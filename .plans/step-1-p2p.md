# Step 1 — P2P replication (наивысший риск)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода с file:line) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 1. Модуль: `packages/backend/src/p2p/`.

---

## 1.1 `p2p/apply.ts` (366 строк, самая сложная)

### 1.1.A Race: read-check-write без транзакции/row-lock в `applyUpsert`

**Находка.** `applyUpsert` определён на `apply.ts:87`. Все ветки следуют идентичному неатомарному паттерну **`findOne` → `lwwWins` → `save`**:
- Board — `:120` (`repo.findOne({ where: { id } })`), `:121` (гейт `lwwWins`), `:123` (`repo.save(repo.create({...}))`)
- Post — `:141`, `:142`, `:143`
- Media — `:166`, `:167`; save-existing `:178` / create `:180`
- ChatProfile — `:202`, `:203`, `:210`/`:212`
- ChatFolder — `:234`, `:235`, `:243`/`:245` (+ profile lookup `:227-232`)
- ProfileThreadState — `:274`, `:275`, `:287`/`:289` (profile + folder lookups `:261-273`)
- ProfileOwnPost — `:315`, `:316`, `:324`/`:326` (profile lookup `:309-314`)

Нигде нет `dataSource.transaction(...)` и нет row-lock (`SELECT ... FOR UPDATE`). Единственная транзакция в модуле — внутри `journal.ts:logChanges` для записи changelog, и она выполняется **после** entity-write (через `finish`, `apply.ts:99-116`).

**Сценарий переплетения:** два конкурентных писателя одного ключа — live WS push (`controlServer.ts /p2p/push` → `applyPointerWithRow`) и upstream pull (`client.ts applyEntries`/snapshot → `applyUpsert`) — оба вызывают `findOne`, читают **одну и ту же** stale-строку, оба независимо проходят `lwwWins`, оба делают `save`. Последний писатель побеждает на уровне БД вне зависимости от LWW-намерений: логически более старая строка затирает новую (lost update), а changelog фиксирует два расходящихся «applied»-pointers для одного ключа с разными ревизиями — реплики, позже читающие по ревизии, получают неконсистентное состояние. Ветки `Media`/`ChatProfile` хуже: они мутируют загруженную сущность in-place (`existing.field = ...; save(existing)`), поэтому конкурентные мутации переплетаются и на уровне полей.

**План действий:**
1. Обернуть каждый upsert в транзакцию с row-lock: `applyUpsertInTx(manager, table, key, row)` внутри `dataSource.transaction(async (tx) => {...})`; читать существующую строку с pessimistic write lock (`createQueryBuilder().setLock('pessimistic_write')` / `FOR UPDATE`) по natural key; оценить LWW; upsert — всё в одной tx. Вызывать `logChanges` тем же `manager` (он уже поддерживает `opts.manager`, см. `journal.ts:52-60`).
2. *(см. 1.1.B)* сделать deletes LWW-gated внутри той же запертой транзакции.

**Критерий закрытия:**
- [ ] `grep -n "dataSource.transaction\|pessimistic_write\|FOR UPDATE" apply.ts` показывает, что upsert- и delete-пути выполняются в транзакции с row-lock; ни одна ветка не делает unlocked `findOne`→`save`.
- [ ] Конкурентный тест: два одновременных `applyUpsert` на один ключ с разными `(updatedAt, revision)` → ровно один побеждает по LWW, changelog содержит единственный консистентный pointer.

---

### 1.1.B Delete не проходит LWW-гейт (удаляет безусловно)

**Находка.** `applyDelete` — `apply.ts:23`. Аргумент `meta` несёт `{ originNodeId, updatedAt }` (`apply.ts:27`), но **никогда не используется для гейта удаления**. Каждый case просто вызывает `.delete(...)`:
- Board `:32-34`, Post `:35-41` (также удаляет дочерние Media + файлы), Media `:42-50`, ChatProfile `:51-54`, ChatFolder `:55-57`, ProfileThreadState `:58-61`, ProfileOwnPost `:62-65`.
- `meta` потребляется лишь позже на `apply.ts:75` для записи changelog-pointer.

**Последствие:** out-of-order или stale delete (с меньшим `updatedAt`), пришедший после более свежего upsert, **уничтожит** новую строку. Нет guard «удалять только если local.updatedAt <= incoming.updatedAt» — deletes фактически last-message-wins-by-arrival-time, а не по версии.

**План действий:**
1. В `applyDelete` сначала загрузить существующую строку внутри той же запертой транзакции; удалять только если `!existing || incoming.updatedAt >= existing.updatedAt` (и, после внедрения revision — `incoming.revision >= existing.revision`). При проигрыше — skip без changelog-pointer.

**Критерий закрытия:**
- [ ] Out-of-order delete (меньший `updatedAt`), пришедший после более свежего upsert, оставляет строку нетронутой (`applyDelete` возвращает false / строка не удалена) — покрыто тестом.

---

### 1.1.C LWW не сравнивает revision

**Находка.** Полный `lww.ts`:
```ts
export type LwwFields = { updatedAt: number; originNodeId: string | null | undefined };
export const lwwWins = (local, incoming) => {
  if (!local) return true;
  if (incoming.updatedAt > local.updatedAt) return true;
  if (incoming.updatedAt < local.updatedAt) return false;
  const localOrigin = local.originNodeId ?? "";
  const incomingOrigin = incoming.originNodeId ?? "";
  return incomingOrigin > localOrigin;   // string compare tie-break
};
```
`LwwFields` **не имеет поля `revision`**, и `lwwWins` его не читает. При этом revision доступен везде: на каждой сущности (`Board.revision` и др.), в `RawRow` (`row.revision`, используется напр. `apply.ts:130`) и в changelog-pointer (`P2pChangePointer.revision`).

**Как lower-revision затирает higher:** LWW опирается на wall-clock `updatedAt`. Если узел A делает revision 5 с `updatedAt = T`, а узел B (со смещёнными часами или задержанной старой правкой) выдаёт revision 4, но с `updatedAt = T+1` и лексикографически большим `originNodeId`, то `lwwWins(local=rev5, incoming=rev4)` вернёт **true**, т.к. `incoming.updatedAt > local.updatedAt`. Более высокая ревизия перезаписывается более низкой. Ревизия — фактический монотонный счётчик — полностью игнорируется.

**План действий:**
1. Расширить `LwwFields` полем `revision: number`; сравнивать `(updatedAt, revision)` как основное упорядочение; оставить `originNodeId` только как финальный детерминированный tie-break по каноническому node id. Обновить все call sites в `apply.ts`, передавая `row.revision`.

**Критерий закрытия:**
- [ ] Подпись `lwwWins` включает `revision`; юнит-тест доказывает, что incoming с lower-revision/higher-`updatedAt` **не** перезаписывает local с higher-revision.

---

### 1.1.D Дублирование: 7 почти идентичных upsert-ветвей

**Находка.** Каждая ветка `applyUpsert` (`apply.ts:118-338`) структурно идентична: resolve key → опциональные FK lookups (profile/folder) → `findOne` по natural key → гейт `lwwWins` → mutate-or-create с одними и теми же 4 meta-полями (`updatedAt`, `revision`, `originNodeId`) + table-specific payload → `finish(true, recordKey)`.
- Board `:118-137` (доп.: `stripLocalFilesForBoard` при public→private на `:135`)
- Post `:139-161`
- Media `:163-197`
- ChatProfile `:199-224`
- ChatFolder `:226-258` (FK: profile)
- ProfileThreadState `:260-306` (FK: profile + folder)
- ProfileOwnPost `:308-338` (FK: profile)

Чем отличаются таблицы: (1) **key column** (`id` для Board/Post vs `syncId` для остальных), (2) **список payload-полей**, (3) опциональное **FK resolution** в числовой `profileId`/`folderId`, (4) один post-save side effect (Board privacy strip). Всё остальное общее.

**План действий:**
1. Ввести table-driven schema map:
   ```ts
   type TableSpec = {
     keyCol: "id" | "syncId";
     repo: (ds) => Repository<any>;
     resolveFks?: (manager, row) => Promise<Record<string, number|null>>;
     toEntity: (row, fks) => object;          // payload mapping
     postSave?: (manager, existing, next) => Promise<void>; // Board privacy strip
   };
   const TABLES: Record<string, TableSpec> = { Board: {...}, Post: {...}, ... };
   ```
   Единый generic `applyUpsert` обходит spec. Это также централизует транзакцию/lock из 1.1.A в одном месте.

**Критерий закрытия:**
- [ ] Все 7 таблиц идут через один generic upsert; per-table switch в `applyUpsert` заменён картой `TABLES`; дублированных блоков `findOne/lwwWins/save` не осталось (проверка по коду).

---

### 1.1.E Sentinel-несогласованность `originNodeId`

**Находка.**
- `"unknown"` — ставится в `journal.ts:27`: `const originNodeId = input.originNodeId || p2pNodeId() || "unknown";` (только changelog-pointer, когда оба пусты).
- `"remote"` — ставится в `apply.ts:106` внутри `finish`: `originNodeId: incomingMeta.originNodeId || "remote"` (только changelog-pointer; **сущность** хранит сырой `incomingMeta.originNodeId`, который может быть `null`).
- `null` — значение, хранимое в сущности, когда у incoming нет origin (`apply.ts:131,154,...`); локальные записи в `posts.ts:102/119` используют `p2pNodeId() || null`.
- Дополнительные расходящиеся sentinels из локальных write paths: `"local"` (`chat.ts:40,55,77,...`), `"root"` (`media.ts:61`).

**Влияние на LWW tie-break:** при равном `updatedAt` `lwwWins` падает в лексикографическое сравнение этих sentinel-строк. Поскольку разные кодовые пути штампуют разные строки (`""`(null) < `"local"` < `"remote"` < `"root"` < `"unknown"`), победитель на clock-tie зависит от **того, какой кодовый путь** записал каждую сторону, а не от реальной identity узла. Это делает tie-breaks недетерминированными между репликами и может переворачивать выжившую правку в зависимости от origin-лейбла — напрямую подрывая сходимость.

**План действий:**
1. Выбрать один канонический value (напр. всегда `p2pNodeId()`, с fallback на фиксированную константу) и использовать его консистентно в `journal.ts`, `apply.ts finish` и всех локальных write paths (`chat.ts`, `media.ts`, `posts.ts`). Убрать дивергенцию `"remote"`/`"root"`/`"local"`/`null`.

**Критерий закрытия:**
- [ ] `grep -rn '"remote"\|"root"\|"local"\|"unknown"' src/p2p src/db/repositories` не возвращает расходящихся origin-sentinel; везде используется одно каноническое значение.

---

## 1.2 `p2p/client.ts` (311 строк)

### 1.2.A Lost updates: курсор продвигается мимо упавших/пропущенных записей

**Находка.**
- Инкрементальный путь: после `applyEntries(...)` курсор продвигается до **upstream'овского** current revision независимо от исхода отдельных записей — `client.ts:148`:
  ```ts
  await applyEntries(upstream, dataSource, changesRes.body.entries);
  await settings.upsert(SETTINGS_LAST_UPSTREAM, "number", String(meta.currentRevision));
  ```
- Snapshot-путь делает то же на `client.ts:158`.
- Внутри `applyEntries` (`client.ts:~163-190`) non-200/non-404 raw fetch'и **молча отбрасываются**:
  ```ts
  if (status === 404) { await applyPointerWithRow(..., null, ...); continue; }   // трактуется как delete
  if (status !== 200) continue;                                                 // МОЛЧАСКОЕ ДРОП
  await applyPointerWithRow(dataSource, entry, data as RawRow, {...});
  ```

**Точный сценарий потери:** `/p2p/changes?since=lastUpstream` возвращает записи с ревизиями до `meta.currentRevision`. Для одной записи fetch `/p2p/raw/...` возвращает транзиентный `5xx` (сбой upstream) → `status !== 200` → `continue`, ничего не применено, ошибки нет. Управление доходит до `client.ts:148` и ставит `lastUpstream = meta.currentRevision`. Ревизия этой записи теперь **ниже** курсора и никогда не будет запрошена повторно (следующий `/p2p/changes?since=` стартует после неё). Изменение безвозвратно теряется на этой реплике до принудительного полного snapshot. Асимметрия: брошенная ошибка в `applyEntries` прерывает выполнение **до** строки 148 (курсор не продвинут → повторится в следующем цикле), но *молчаливый* `continue`-путь продвигает — значит данные теряют только non-throwing режимы сбоя.

**План действий:**
1. Продвигать курсор **только до наивысшей успешно применённой ревизии**: вести `maxAppliedRev` внутри `applyEntries`; при любом per-entry сбое (non-200/non-404 или брошенный apply) не продвигаться дальше этой записи и ставить `lastUpstream = maxAppliedRev`. Трактовать non-200 как hard error для батча (не `continue`), чтобы курсор никогда её не перескакивал.
2. Явно различать 404 от других ошибок; логировать+считать дропнутые записи; выводить метрику/счётчик, чтобы молчаливая потеря была наблюдаема.

**Критерий закрытия:**
- [ ] Тест: одна запись возвращает `5xx` в середине батча → `lastUpstream` **не** продвигается дальше ревизии этой записи (запись запрашивается повторно в следующем цикле); данных не теряется.

---

### 1.2.B Нет backoff/timeouts

**Находка.**
- Фиксированный 5s sleep без экспоненциального backoff/jitter при ошибке — `connectLoop`, `client.ts:117`: `await new Promise((r) => setTimeout(r, 5000));` (`catch` на `:113-115` просто логирует и падает в тот же фиксированный delay).
- **Все fetch-вызовы без `AbortController`/timeout:**
  - `fetchJson` — `client.ts:36`
  - `fetchMsgpack` — `client.ts:42`
  - `readLengthPrefixedStream` (snapshot) — `client.ts:55`
  - `downloadFile` — `client.ts:84`
  - push в `flushOutbox` — `client.ts:253`
- **WS reconnect без backoff/jitter:** `listenWs` на `client.ts:277` создаёт сокет; по `"close"`/`"error"` просто вызывает `done()` (resolve). Переподключение движется только внешним фиксированным 5s циклом; нет per-attempt delay, jitter или max-retry — flapping upstream даёт плотный reconnect churn.

**План действий:**
1. Обернуть каждый fetch в `AbortController` с per-call timeout (meta/changes/raw — короткий, snapshot/file — длинный).
2. Заменить фиксированный 5s sleep на экспоненциальный backoff + jitter при ошибке (reset при успехе).
3. Добавить WS reconnect backoff/jitter и max-retry окно перед откатом к polling-циклу.

**Критерий закрытия:**
- [ ] `grep -n "AbortController\|signal:" client.ts` показывает, что у каждого `fetch(` есть timeout signal; `grep -n "setTimeout" client.ts` на error-пути показывает backoff/jitter, а не одиночный фиксированный 5000 ms.
- [ ] WS reconnect логика включает экспоненциальный backoff + jitter (видимо в коде / покрыто flapping-upstream тестом).

---

### 1.2.C Unbounded outbox

**Находка.**
- `hub.ts:enqueueOutbox` пушит в in-memory `outbox: OutboxItem[]` **без size cap** (`hub.ts:37-40`).
- При неудачном push `flushOutbox` ре-энквюит **всю** drained-партию — `client.ts:~261-264`:
  ```ts
  if (!res.ok) { logger.error(...); hub?.enqueueOutbox(entries); return; }
  ```
  Так как `drainOutbox()` уже вырезал их (`hub.ts:41-44`), устойчиво падающий push каждый цикл добавляет те же записи заново → неограниченный рост памяти и дублирующиеся push после восстановления. Нет cap, dedup или TTL/drop политики нигде.

**План действий:**
1. В `hub.ts` ввести `maxOutboxItems`/`maxOutboxBytes`; при переполнении drop-oldest или persist на диск; dedup по `(table,key,revision)`, чтобы re-enqueue после сбоя не дублировал. `flushOutbox` ре-энквюит только **неподтверждённый** остаток.

**Критерий закрытия:**
- [ ] В `hub.ts` действует outbox cap; тест, падающий push N раз, показывает ограниченную память и отсутствие дубликатов после восстановления.

---

### 1.2.D Snapshot streaming: неограниченный буфер + нет fetch timeout

**Находка.** `readLengthPrefixedStream`, `client.ts:52-78`: накапливает в один растущий буфер без bound и без fetch timeout (`fetch` на `:55` без signal):
```ts
let pending = Buffer.alloc(0);
...
pending = Buffer.concat([pending, Buffer.from(value)]);   // неограниченный рост
while (pending.length >= 4) { const len = pending.readUInt32BE(0); if (pending.length < 4+len) break; ... }
```
Если `onFrame` (делает полный DB upsert на фрейм, `client.ts:154-156`) медленнее сети, или один фрейм большой/некорректный с огромным length prefix — `pending` растёт без предела → исчерпание памяти. Повреждённый/завышенный 4-byte length также затыкает цикл, удерживая все предыдущие байты.

**План действий:**
1. Стримить фреймы с max pending size (отклонять/прерывать при `pending.length > MAX_FRAME_BYTES`); добавить fetch timeout на snapshot-запрос; рассмотреть backpressure (паузить reader, пока `onFrame` в полёте).

**Критерий закрытия:**
- [ ] В `readLengthPrefixedStream` есть max-pending guard и fetch timeout; некорректный oversized-length фрейм прерывает процесс вместо неограниченного буферизирования (покрыто тестом).

---

## 1.3 Безопасность

### 1.3.A Репликация plaintext-креденшелов (`raw.ts`)

**Находка.** `profileToRaw`, `raw.ts:59-67`, сериализует живые креденшелы дословно в реплицируемую строку:
```ts
const profileToRaw = (p: ChatProfile): RawRow => ({
  syncId: p.syncId,
  token: p.token,                 // <-- plaintext API-токен
  passphraseHash: p.passphraseHash,// <-- хэш пароля
  createdAt: p.createdAt, updatedAt: p.updatedAt, revision: p.revision, originNodeId: p.originNodeId,
});
```
Эти строки доступны **всем** репликам через два канала: `/p2p/raw/ChatProfile/:key` (`routes.ts` → `loadRawRow` → `profileToRaw`, `raw.ts:137-140`) и полный snapshot stream (`iterateSnapshot` выдаёт ChatProfile-фреймы через `profileToRaw`, `raw.ts:~145`). Каждая реплика (и любой, кто может достучиться до `/p2p/raw` или `/p2p/snapshot` с общим токеном) получает chat API-токен и passphrase hash в plaintext.

**План действий:**
1. Перестать реплицировать секреты: убрать `token` и `passphraseHash` из `profileToRaw`; реплицировать только нечувствительные поля профиля (или opaque id/ссылку). Если репликам нужен токен — провизонировать его out-of-band per node, а не по проводу. Добавить примечание о миграции/backfill для существующих строк.

**Критерий закрытия:**
- [ ] `grep -n "token\|passphraseHash" raw.ts` показывает, что ни одно из полей не сериализуется в `profileToRaw`; snapshot/raw ответ для ChatProfile не содержит credential-полей (покрыто тестом).

---

### 1.3.B `auth.ts`: слабое сравнение, shared static token, нет TLS

**Находка.** Полный файл (`auth.ts:1-14`). Проверка — обычное неconstant-time равенство на `auth.ts:13`:
```ts
return token === expected;
```
(timing side-channel; нужен constant-time compare). Удостоверение — единый **shared static** bearer токен из env — `config.ts:4` `p2pSyncToken() = process.env.P2P_SYNC_TOKEN`. Все реплики держат один секрет; нет per-peer identity, ротации или scoping. **Нет enforcement TLS нигде:** ничего не проверяет, что запросы приходят по HTTPS/WSS или валидирует сертификаты; advertised URL'ы по умолчанию plain `ws://`/`http://127.0.0.1:...` (`config.ts:18-24`). Токен и все реплицируемые данные (включая креденшелы из 1.3.A) по умолчанию идут в cleartext.

**План действий:**
1. Использовать constant-time сравнение (`crypto.timingSafeEqual` на буферах равной длины).
2. Перейти от одного shared static токена к per-peer credentials (или как минимум поддержать ротацию); форсировать TLS/WSS (отклонять non-secure запросы или требовать `P2P_REQUIRE_TLS`).

**Критерий закрытия:**
- [ ] В `auth.ts` используется `crypto.timingSafeEqual`; config поддерживает per-peer токены и/или enforcement TLS (non-TLS запрос отклоняется, когда требуется).

---

### 1.3.C `routes.ts`: нет rate-limit, sync FS в request path; traversal guard

**Находка.**
- **Нет rate-limiting** ни на одном P2P route (`/p2p/meta`, `/p2p/changes`, `/p2p/snapshot`, `/p2p/raw/:table/:key`, `/p2p/raw/batch`, `/p2p/files/index`, `/p2p/files/:syncId/:role`). В `bindP2pReadRoutes` нет `fastify-rate-limit` или per-route limit. Аутентифицированный (или с утёкшим токеном) клиент может бить по этим эндпоинтам без ограничений.
- **Синхронный FS в request path** — `/p2p/files/index` вызывает `fs.statSync(abs).size` дважды на media-строку внутри handler'а (`routes.ts:~150` и `:~163`), блокируя event loop на каждый файл при каждом вызове (масштабируется с числом медиа).
- **Path-traversal guard** — `resolveAbsolutePath`, `storage.ts:9-24`:
  ```ts
  if (!relativePath.startsWith("media-data/")) return null;
  const absolute = path.resolve(root, relativeFromRoot);
  const relativeCheck = path.relative(root, absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) return null;
  ```
  Он **действительно** отклоняет `..`: prefix-требование + проверка `path.relative` возвращают `null` для любого значения, разрешающегося за пределы media root (напр. `media-data/../../etc/passwd`). Traversal через сфабрикованный сохранённый `localPath` заблокирован. Остаточное замечание: защита опирается на сохранённое значение `localPath` и фиксированный prefix; она корректна, но стоит явного теста.

**План действий:**
1. Rate-limit P2P routes (глобальный + более строгие лимиты на `/p2p/raw`, `/p2p/files/*`, `/p2p/snapshot`).
2. Заменить `fs.statSync` в `/p2p/files/index` на async `fs.promises.stat` (или предвычислить/кешировать размеры).
3. Добавить regression-тесты traversal для `resolveAbsolutePath` (`..`, absolute, prefix-bypass), хотя guard сейчас держится.

**Критерий закрытия:**
- [ ] Rate limiting зарегистрирован на P2P routes; `/p2p/files/index` использует async stat (`grep -n "statSync" routes.ts` в handler path ничего не возвращает).
- [ ] Traversal-тесты для `resolveAbsolutePath` проходят для `..`, absolute и prefix-bypass входных.

---

### 1.3.D `controlServer.ts`: SSRF-ish callback fetch

**Находка.** `fetchRawFromCallback`, `controlServer.ts:19-30`, строит URL из **предоставленного вызывающим** `callbackBaseUrl` (взятого из тела push на `controlServer.ts:~52`: `body.callbackBaseUrl?.trim()`) и выпускает исходящий `fetch` с общим Bearer токеном:
```ts
const url = `${callbackBaseUrl.replace(/\/$/, "")}/p2p/raw/${...}/${...}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${p2pSyncToken()}` } });
```
**Риск:** любой держатель (общего) sync токена может указать `callbackBaseUrl` на произвольные внутренние эндпоинты (cloud metadata `169.254.169.254`, внутренние сервисы, localhost-порты), заставляя сервер делать аутентифицированные исходящие запросы и прогонять ответ через `applyPointerWithRow`. Это SSRF / data-exfiltration примитив.
**Текущие (слабые) митигации:** требуется валидный Bearer токен (но он общий для всех реплик — не сильная граница); полученные байты должны распаковаться как msgpack и пройти LWW, чтобы быть применёнными (ограничивает *write*-влияние, но не сам исходящий запрос). **Нет** allowlist `callbackBaseUrl`, нет enforcement TLS, нет IP/hostname фильтрации.

**План действий:**
1. Валидировать `callbackBaseUrl` по allowlist известных peer base URL (выведенных из зарегистрированных node identities); форсировать HTTPS; блокировать private/link-local IP-диапазоны. Идеально — заменить pull-by-callback на взаимно аутентифицированный прямой fetch к предрегистрированному эндпоинту.

**Критерий закрытия:**
- [ ] В `controlServer.ts` `callbackBaseUrl` валидируется/allowlist'ится и блокируются private/link-local цели (тест: push с `callbackBaseUrl=http://169.254.169.254/...` отклоняется / не fetch'ится).

---

## 1.4 Прочее

### 1.4.A `raw.ts:iterateSnapshot` грузит полные таблицы в память

**Находка.** `iterateSnapshot`, `raw.ts:~128-165`, вызывает `.find()` **без пагинации/take/skip** для всех семи таблиц, напр.:
```ts
for (const post of await dataSource.getRepository(Post).find()) { yield {...} }
for (const media of await dataSource.getRepository(Media).find()) { yield {...} }
...
```
Каждый `.find()` материализует **всю** таблицу как hydrated сущности до выдачи. Для больших досок (сотни тысяч постов/медиа) это крупная одновременная аллокация памяти на каждую таблицу + стоимость полного entity hydration; snapshot handler (`routes.ts /p2p/snapshot`) затем пакует каждый фрейм, пока все строки таблицы уже резидентны. В связке с client-side неограниченным `pending` буфером (§1.2.D) большая доска может OOM на любой стороне во время полного sync.

**План действий:**
1. Пагинировать snapshot: заменить `.find()` на keyset pagination (`WHERE id > :cursor ORDER BY id LIMIT :batch`) per table в `iterateSnapshot`, выдавая батчами, чтобы в памяти была только одна страница; связать с client-side buffer bound из §1.2.D.

**Критерий закрытия:**
- [ ] В `iterateSnapshot` используется keyset pagination (`grep -n "\.find()" raw.ts` не показывает unpaginated full-table loads на snapshot path); large-board snapshot тест держит память в пределах (одна страница за раз).

---

### 1.4.B `schemaVersion.ts`: грубый гейт по имени миграции; hard-fail при mismatch

**Находка.** Полный файл (`schemaVersion.ts:1-15`): «версия схемы» — просто **последнее применённое имя TypeORM-миграции**:
```ts
SELECT name, timestamp FROM migrations ORDER BY timestamp DESC, id DESC LIMIT 1
... return rows[0]?.name;   // иначе "unknown"
```
Это string-equality гейт по последней миграции — любой rename/reorder или расходящаяся история миграций меняет её. Mismatch **hard-fail'ит весь sync** в `client.ts:~134`:
```ts
if (meta.schemaVersion !== localSchema) throw new Error(`schema mismatch ...`);
```
Это прерывает `syncOnce`; в связке с фиксированным циклом реплика, отстающая даже на одну миграцию, полностью останавливает синк (нет partial/degraded режима).
**`P2P_PROTOCOL_VERSION`** = `1` (`types.ts:1`). Он **используется**: advertised в `/p2p/meta` (`routes.ts:33`) и сравнивается на клиенте (`client.ts:130`, бросая при mismatch). То есть это не dead code — но это хардкод-константа, поэтому bump протокола требует скоординированных изменений кода с обеих сторон (нет negotiation).

**План действий:**
1. Сделать schema gating явным и не тотальным: выводить версию схемы из упорядоченного content-based digest применённых миграций (а не только последнего имени); при mismatch логировать + выставлять статус, а не молча останавливаться навсегда; рассмотреть управляемое состояние «await upgrade» вместо hard throw loop.
2. Версионировать протокол осознанно: сохранить `P2P_PROTOCOL_VERSION`, но задокументировать процедуру bump и добавить compatibility matrix / negotiation field в `/p2p/meta`.

**Критерий закрытия:**
- [ ] Schema mismatch даёт наблюдаемое некрашащееся degraded состояние (тест: реплика, отстающая на одну миграцию, отчитывается статусом вместо throw'а в плотном цикле); у bump протокола есть задокументированная процедура.

---

### 1.4.C Тестовые пробелы

**Находка.**
- `journal.apply.test.ts` (полный файл): единственный smoke-тест, который *если* нативный биндинг `better-sqlite3` грузится, открывает in-memory БД и проверяет `logChanges` + `getCurrentRevision >= 1`. **Полностью пропускается**, когда addon отсутствует. Не затрагивает `applyUpsert`, `applyDelete`, LWW integration, concurrency или table mapping.
- `protocol.test.ts` (полный файл): покрывает `P2P_PROTOCOL_VERSION === 1`; список реплицируемых таблиц + негативы `isP2pReplicatedTable`; уникальность `newSyncId()`; три случая `lwwWins` (local-missing→true; равное `updatedAt` с большим local origin→false); формат `mediaSyncIdFromNaturalKey`. Это весь охват LWW — нет revision-случая, нет sentinel tie-break случаев.
- **Конкретно не покрытые функции:**
  - `apply.ts`: все семь ветвей `applyUpsert` (включая in-place мутацию Media/ChatProfile, Board privacy strip), `applyDelete`, `applyPointerWithRow`, wiring `finish`→`logChanges`/broadcast/outbox.
  - `raw.ts`: все мапперы (`boardToRaw`, `postToRaw`, `mediaToRaw`, `profileToRaw`, `folderToRaw`, `stateToRaw`, `ownPostToRaw`), `loadRawRow`, `iterateSnapshot`.
  - `hub.ts`: `broadcast`, `enqueueOutbox`/`drainOutbox`, `addClient` (close/error cleanup), `clientCount`.
  - `client.ts`: `syncOnce`, lost-update/silent-drop путь `applyEntries`, cursor-advance логика, re-enqueue в `flushOutbox`, `listenWs`, `readLengthPrefixedStream`, hash check в `downloadFile`, skip/download в `ensureLocalFile`.
  - `routes.ts`: все handler'ы — `/p2p/meta`, `/p2p/changes` (включая 410 gap логику при `since < oldest - 1`), фрейминг `/p2p/snapshot`, `/p2p/raw/:table/:key`, `/p2p/raw/batch`, `/p2p/files/index`, `/p2p/files/:syncId/:role` (включая private-board skip).
  - `controlServer.ts`: apply loop в `/p2p/push`, `fetchRawFromCallback`, auth/close путь `/p2p/ws`.
  - `auth.ts`: **нет вообще** тестов для `authorizeP2pRequest` (отсутствующий header, неверная схема, неверный токен).
  - `journal.ts`: `pruneChangeLog` (и age-based cutoff, и max-rows overflow delete) не покрыт; `listChangesSince`, `getOldestRevision` тоже.

**План действий (приоритет):**
1. Юнит-тесты `lwwWins` с revision + sentinel tie-breaks; все ветви `auth.ts`.
2. Table-driven юнит/интеграционные тесты каждой ветви `applyUpsert`/`applyDelete` и LWW гейта, плюс конкурентный тест (§1.1).
3. Тесты мапперов `raw.ts`, утверждающие **отсутствие секретных полей** в выводе ChatProfile; pagination-тест `iterateSnapshot`.
4. Lost-update + cursor-advance тест `client.ts` с mocked upstream, возвращающим один 5xx; re-enqueue/cap тест `flushOutbox`.
5. Handler-тесты `routes.ts` (410 gap, private-board skip, file streaming hash header) и callback allowlist/SSRF rejection тест `controlServer.ts`.
6. Тесты `journal.ts pruneChangeLog` для age и row-cap pruning.

**Критерий закрытия:**
- [ ] Существуют и проходят новые тесты для: каждой ветви `applyUpsert`/`applyDelete` + concurrency; revision/sentinel случаев `lwwWins`; всех мапперов `raw.ts` (с утверждением, что вывод ChatProfile исключает `token`/`passphraseHash`); lost-update/cursor поведения `client.ts`; 410-gap и privacy-skip в `routes.ts`; SSRF rejection в `controlServer.ts`; всех ветвей `auth.ts`; `journal.ts pruneChangeLog` (age + row cap).
- [ ] Coverage report показывает, что ранее не покрытые функции выше затрагиваются хотя бы одним проходящим тестом каждая.

---

## Рекомендуемый порядок внутри шага (по severity)

1. **1.1.A + 1.1.B** — неатомарный LWW apply + негейтированные deletes → lost updates / повреждение данных при конкурентном WS+push.
2. **1.1.C + 1.1.E** — LWW игнорирует revision; несостыкованные origin sentinels → несходимость tie-breaks.
3. **1.2.A** — курсор продвигается мимо молча дропнутых записей → постоянные lost updates.
4. **1.3.A–D** — plaintext credential replication + shared static token + non-constant-time compare + нет TLS + нет rate limits + SSRF-capable callback fetch → широкая security-экспозиция.
5. **1.2.C, 1.2.D, 1.4.A** — неограниченные пути памяти (outbox re-enqueue, snapshot `pending` буфер, full-table `.find()`) → OOM риск на больших досках / падающих push'ах.
6. **1.1.D, 1.4.B, 1.4.C** — дублирование, schema gating, тестовые пробелы (maintainability/наблюдаемость).
