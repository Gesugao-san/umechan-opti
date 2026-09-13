# Step 0 — Cross-cutting (архитектура, поперечные риски)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 0.

---

## 0.1 Циклическая зависимость `db` ↔ `p2p` (+ `media`)

### Находка

Полный граф кросс-импортов (статические):

**`db/ → p2p/`:**
- `src/db/repositories/posts.ts:7-9` — `mediaSyncIdFromNaturalKey` (`p2p/ids`), `logChanges`+`LogChangeInput` (`p2p/journal`), `p2pNodeId` (`p2p/config`)
- `src/db/repositories/boards.ts:4-6` — `logChanges`, `p2pNodeId`, `getP2pHub`
- `src/db/repositories/chat.ts:11-15` — `newSyncId`, `logChanges`, `p2pNodeId`, `getP2pHub`, `type P2pReplicatedTable`
- `src/db/repositories/media.ts:6-7` — `mediaSyncIdFromNaturalKey`, `p2pNodeId`

**`db/ → p2p/` (динамический импорт — обход цикла):**
- `src/db/repositories/posts.ts:314` — `const { getP2pHub } = await import("../../p2p/hub")` → `getP2pHub()?.broadcast(pointers)` (:315)

**`db/ → media/`:**
- `src/db/repositories/boards.ts:7` — `getPrivateBoardIds` (`media/boardPrivacy`)
- `src/db/repositories/media.ts:5`, `posts.ts:6` — `deleteFilesForMedia` (`media/storage`)

**Обратное направление (создаёт цикл):**
- `src/p2p/journal.ts:2` → `db/entities/SyncChangeLog`
- `src/p2p/apply.ts:2-8` → все 7 сущностей; `:10` → `stripLocalFilesForBoard` из `db/repositories/media` (**p2p лезет в репозиторий db**)
- `src/p2p/raw.ts:2-8`, `client.ts:6`, `routes.ts:5` → сущности; `schemaVersion.ts:1` → `AppDataSource`

**Третья сторона:**
- `src/media/hash.ts:3` → `sha256Buffer` из `p2p/ids` (**media лезет в p2p**)
- `src/media/boardPrivacy.ts:2-4`, `syncLocalMedia.ts:3-4` → сущности db, тип `DbConnection`

**Корень проблемы:** репозитории одновременно делают 3 вещи — (a) персистентность, (b) запись P2P-журнала (`logChanges`), (c) push в live-hub (`getP2pHub()?.broadcast/enqueueOutbox`). Пункты (b)+(c) и заставляют `db/` импортировать `p2p/`.

### План действий

1. **Ввести notification-port в `db/`:** интерфейс `ChangeNotifier { notify(pointers: P2pChangePointer[]): void }` (новый файл, напр. `src/db/events.ts`). Репозитории принимают его параметром вместо прямого импорта `getP2pHub`.
2. **Вынести запись журнала из репозиториев:** `logChanges` вызывает оркестратор (sync-процессоры / p2p apply). Репозитории возвращают список изменённых ключей/pointers; вызывающий пишет их в `SyncChangeLog`.
3. **Разорвать `media/hash.ts → p2p/ids`:** перенести `sha256Buffer` в нейтральное место (`src/utils/crypto.ts`); оба модуля импортируют оттуда.
4. **Разорвать `p2p/apply.ts:10 → db/repositories/media`:** вынести file-deletion за интерфейс репозитория или общий сервис `db/`.
5. **Убрать динамический импорт в `posts.ts:314`** — после шагов 1-2 репозитории не трогают hub напрямую.
6. **Зафиксировать границу линтером:** правило ESLint `import/no-restricted-paths`: `db/**` не импортирует `p2p/**`; `media/**` — только leaf-утилиты.

### Критерий закрытия

- [ ] `grep -rE "from ['\"]\.\./.*p2p/" packages/backend/src/db/` → 0 совпадений (статика и динамика).
- [ ] `grep -rE "await import\(.*p2p" packages/backend/src/db/` → 0.
- [ ] `grep -rE "from ['\"]\.\./p2p/" packages/backend/src/media/` → 0 (`hash.ts` перенесён в utils).
- [ ] В `packages/backend/eslint.config.mjs` есть restricted-paths правило; `pnpm run lint` проходит без нарушений.
- [ ] Все существующие тесты (`journal.apply.test.ts`, `protocol.test.ts`) проходят после рефакторинга.

---

## 0.2 Отсутствие тестов на ядре (`sync/`, `sources/`, `db/`)

### Находка

В бэкенде существуют ТОЛЬКО эти тест-файлы:
`src/media/{paths,storage,download,syncLocalMedia}.test.ts`, `src/p2p/{journal.apply,protocol}.test.ts`.
Под деревьями `src/sync/**`, `src/sources/**`, `src/db/**` — **0 тестов** (проверено glob'ом).

Непокрытые экспортируемые функции (по файлам):
- `sync/createSyncService.ts:10` — `createSyncService` (флаг `isFirstFullSync`, оркестрация full/partial)
- `sync/getFullThreads.ts:51,100` — `getFullThreads`, `getFullThreadsV2` (пагинация, early-stop, фильтр неизменённых)
- `sync/processors/processBoards.ts:6` — `processBoards`
- `sync/processors/processPosts.ts:87` — `processPosts` (dedup, media collection, вызовы `syncLocalMedia` + `db.posts.syncPostsAndMedia`)
- `sources/rest.ts:13` — `createRestSource` → `getBoardsList`, `getThreadsList`, `getThreadPostsList`
- `db/connection.ts:10`, `dataSource.ts:21`, `runMigrations.ts:7`, `transformers.ts:6`
- `db/repositories/apis.ts:17`, `boards.ts:9`, `chat.ts:63`, `media.ts:20,46`, `posts.ts:56`, `settings.ts:4`

**Топ-10 критичных для покрытия (по риску):**
1. `db/repositories/posts.ts → syncPostsAndMedia` — главный write-path: транзакция upsert + reconcile media + delete orphaned files + journal. Тест: seed temp SQLite, 2 треда (новый + обновлённый с удалённым медиа) → строки постов корректны, удалённая media-строка и её localPath исчезли, в журнале matching upsert/delete pointers, повторный вызов идемпотентен.
2. `db/repositories/posts.ts → upsertMany` — chunked INSERT…OR UPDATE: повторная вставка с изменёнными полями обновляет на месте (row count стабилен), граница чанка (>50) не роняет строки, null'ы `parentId`/`boardId` сохраняются.
3. `db/repositories/posts.ts → getExistingIds / getUpdatedAtByIds` — chunked IN по 500: при >500 id результат полный (без тихого truncation), пустой вход → пустой Set/Map, значения coerced в number.
4. `sync/getFullThreads.ts → getFullThreadsV2` early-stop + фильтр: с фейковым `SyncSource` и stub'ом `db.posts.getUpdatedAtByIds` — треды со stored `updatedAt === index.updatedAt` НЕ перекачиваются; изменённые/новые — да; `onBoards`/`onFullThread` вызваны ожидаемое число раз.
5. `sync/processors/processPosts.ts → collectPostsWithThreadIds`: reply с id, равным id другого root'а → unique-множество корректно, каждый пост привязан к правильному threadId; media собирается только для non-private досок.
6. `db/repositories/chat.ts → identify`: один passphrase дважды → тот же token/profile (без дубля), другой passphrase → новый профиль, journal upsert `ChatProfile` ровно 1 раз.
7. `db/repositories/settings.ts → upsert/get`: upsert→get возвращает значение; type `"number"` round-trip в JS number; отсутствующий ключ: `get` бросает, `getOptional` → null.
8. `db/transformers.ts → bigintTransformer`: `to(null)===null`, `from("123")===123`; поведение для > 2^53 явно зафиксировано (см. 0.3).
9. `sources/rest.ts → createRestSource.getThreadsList` (axios mock): ignored tag → `[]`; обычный вызов → `payload.posts`; отсутствующий payload → `[]`.
10. `db/repositories/boards.ts → insert/update + getPrivateIds`: insert создаёт строку с `originNodeId`, update меняет поля, доска, переключённая в private, возвращается из `getPrivateIds`.

### План действий

1. Создать общий тест-хелпер БД (temp-file или in-memory `better-sqlite3` DataSource + миграции) — напр. `src/db/__tests__/helpers.ts`.
2. Написать 10 тестов выше, начиная с #1–#5 (наивысший риск целостности данных).
3. Сначала юнит-тесты чистых функций (`bigintTransformer`, `collectPostsWithThreadIds`, фильтр `getFullThreadsV2`) — без БД.
4. Подключить к существующему `pnpm test` (уже гоняет `node --test ./dist/**/*.test.js`).

### Критерий закрытия

- [ ] Есть хотя бы один `.test.ts` под каждым из `src/sync/`, `src/sources/`, `src/db/repositories/`.
- [ ] Каждая из 10 функций имеет проходящий тест, утверждающий именно то поведение, что описано.
- [ ] `pnpm --filter epds test` проходит с включёнными новыми тестами.

---

## 0.3 `bigint` → `number` (потеря точности ID)

### Находка

Трансформер (`src/db/transformers.ts:6-21`):
```ts
to:   (value) => value == null ? null : String(value),  // ~строка 9 — точное хранение
from: (value) => value == null ? null : Number(value),  // строка ~16 — ПОТЕРЯ ТОЧНОСТИ при чтении
```

Колонки, использующие его:
- `Board.ts:7` (`id`)
- `Post.ts:8` (`id`), `:42` (`boardId`), `:54` (`parentId`)
- `Media.ts:48` (`postId`)
- `ProfileOwnPost.ts:23,30` (`threadId`, `postId`)
- `ProfileThreadState.ts:24,31` (`threadId`, `lastSeenPostId`)

**Где ID приходят из upstream:** `src/types/responseThreadsList.ts:7,8,12` — `id`, `board_id`, `parent_id` типизированы как `number`. Axios → JSON.parse: **первая потеря точности происходит ещё до БД** — любой id > 2^53 округляется при парсинге. Вторая точка потери — `Number(value)` в `transformers.ts:16` при каждом чтении сущности.

Реалистично ли > 2^53 (≈9×10¹⁵)? Зависит от upstream; **защиты нет нигде**: ни одна проверка `Number.isSafeInteger(id)` не существует. Если id превысит порог — FK-джойны (`boardId`/`parentId`) тихо рассинхронизируются (reply указывает на округлённого родителя), dedup в `processPosts` сломается.

Точки потери:
- `src/sources/rest.ts` — JSON.parse ответов `/v2/board`, `/v2/board/:tag`, `/v2/post/:id`
- `src/db/transformers.ts:16` — `Number(value)` при чтении
- Потребители, предполагающие safe integers: `api/routes/boards.ts:34` (`Number(b.id)`), сортировки `a.id - b.id` в `chat.ts`

### План действий

1. **Решить контракт:** (а) ID — непрозрачные строки end-to-end (наиболее безопасно) или (б) доказать, что < 2^53, и задокументировать.
2. Если оставляем number: добавить guard на границе источника — в `rest.ts` после парсинга проверять `Number.isSafeInteger` для каждого id и падать/логировать при нарушении.
3. Если переходим на string/BigInt: колонки сущностей → `type: "bigint"` со **string**-трансформером (`from: v => v as string`), типы `ResponsePost`/`ResponseBoard` → `string`, проверить все FK-сравнения (строковое равенство работает).
4. **Влияние на миграции:** колонки уже SQLite `bigint`; хранение decimal-строк в bigint-колонке совместимо (динамическая типизация SQLite), но нужен аудит существующих строк и проверка raw SQL с арифметикой по id (`chat.ts:105` сортировка, `getUpdatedAtByIds`). DDL-изменений при сохранении number не требуется.
5. Добавить регрессионный тест (см. 0.2 #8), фиксирующий выбранное поведение для > 2^53.

### Критерий закрытия

- [ ] Либо (а) guard `Number.isSafeInteger` на границе источника (`rest.ts`) с fail-fast, либо (б) все id-колонки/трансформеры используют string/BigInt и `Number(value)` не применяется к id нигде.
- [ ] Тест демонстрирует корректный round-trip (или явное отклонение) для значения > 2^53.
- [ ] Все FK-джойны (`boardId`, `parentId`, `postId`, `threadId`) проверены на соответствие при выбранном представлении.

---

## 0.4 Относительный путь БД (зависимость от CWD)

### Находка

`src/db/dataSource.ts:12-19`:
```ts
const getDatabasePath = (): string => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return "./data/dev.db";          // ~строка 15 — относительно CWD
  return dbUrl.replace(/^file:/, "");           // ~строка 17 — может остаться относительным
};
```
better-sqlite3 разрешает относительный путь от `process.cwd()`.

Фактическое поведение entrypoints:
- `src/index.ts:5-8` и `src/cluster.ts:27-30`: если `DATABASE_URL` не задан → `process.exit(1)`. Дефолт `./data/dev.db` на практике **не используется**.
- `.env.example`: `DATABASE_URL="file:./dev.db"` → после strip = `./dev.db` (относительный).
- Ни один entrypoint не вызывает `process.chdir(...)` — CWD = каталог запуска.

**Последствие:** место БД зависит от каталога запуска. Запуск из `packages/backend` (через pnpm) кладёт файл туда; запуск из корня репо / systemd с другим WorkingDirectory → **тихо создаётся вторая пустая БД**. Та же проблема для медиа: `src/media/storage.ts:7` — `path.resolve(process.cwd(), getMediaDataDir())`, дефолт `./media-data` (`utils/config.ts:15`).

### План действий

1. Ввести единый источник истины, напр. `src/utils/paths.ts`: базовый каталог = явный env (напр. `APP_DATA_DIR`) ИЛИ `path.resolve(process.cwd(), "data")`, вычисляется один раз и логируется при старте.
2. В `dataSource.ts`: если `DATABASE_URL` относительный — разрешить относительно базы: `path.isAbsolute(p) ? p : path.join(baseDir, p)`; логировать итоговый абсолютный путь при init.
3. То же применить к `media/storage.ts:getMediaDataRoot`; убрать deprecated `utils/config.ts:17 mediaDataDir`.
4. В `.env.example` — абсолютный или явно задокументированный путь; в README — «CWD больше не имеет значения».
5. Startup-ассерция: если каталог разрешённой БД не существует — создать его (или fail fast), а не давать better-sqlite3 создавать файлы где попало.

### Критерий закрытия

- [ ] `getDatabasePath()` возвращает **абсолютный** путь во всех случаях (`path.isAbsolute(...) === true`), покрыто юнит-тестом с установленным/сброшенным `DATABASE_URL`.
- [ ] Итоговый абсолютный путь БД (и media root) логируется при старте.
- [ ] Запуск приложения из двух разных CWD с одинаковым env даёт **один и тот же** файл БД (ручная проверка / интеграционный тест).

---

## 0.5 In-memory state не cluster-safe

### Находка

Топология: `cluster.ts` — primary (sync + P2P control server) + N workers (`runWorker`, API-only, каждый со своим `createDbConnection`). Каждый worker — отдельный процесс с собственным module-state.

1. **Rate-limit map** — `src/api/routes/boards.ts:6`:
   ```ts
   const identifyRateLimit = new Map<string, number[]>();
   ```
   Используется на `:100` (фильтр за 60s) и `:105`. Module-level → **одна карта на worker**. Лимит «10/мин/IP» фактически per-worker: клиент может получить ~N×10 попыток, обходя load balancer. Плюс нет eviction устаревших ключей — карта растёт без bounds (принудительно чистится только при следующем запросе того же IP).

2. **Metrics counter** — `src/api/routes/util.ts:8-10`:
   ```ts
   const metrics = { requests: 0 };
   ```
   Closure на инстанс fastify → per-worker. Инкремент в `onRequest` (`:53`), чтение и **сброс в 0** на `/metrics` (`:74`). В cluster каждый worker считает только свой трафик; `/metrics` отдаёт частичную сумму, зависящую от того, какой worker ответил, и сбрасывает только его. Неатомарно между workers.

3. **Флаг `isFirstFullSync`** — `src/sync/createSyncService.ts:13`:
   ```ts
   let isFirstFullSync = true;
   ```
   Per-инстанс сервиса. В cluster sync создаёт только primary — в штатной топологии безопасно. Риски: (а) не персистится → после рестарта повторно идёт «initial» путь (`getFullThreads`) вместо streaming V2; (б) при двойном запуске двух процессов на одну БД оба считают себя первыми → конкурентные initial full-sync'и с конфликтующими записями.

4. **P2P hub outbox + WS client set** — `src/p2p/hub.ts:19-20`:
   ```ts
   const clients = new Set<WebSocket>();
   const outbox: OutboxItem[] = [];
   ```
   Per-hub. Корректно primary-only (workers используют `createWorkerP2pBridge()` из `cluster/ipc.ts`, который форвардит через `process.send`). Реальные проблемы: **outbox волатилен** — крах/рестарт primary между enqueue и `flushOutbox` (`p2p/client.ts:250`) теряет queued pointers (нет персистентности); `enqueueOutbox` без size bound → неограниченный рост памяти при устойчивых push-сбоях.

5. **Journal notify handler** — `src/p2p/journal.ts:8`:
   ```ts
   let notifyHandler: JournalNotify | null = null;
   ```
   Module global, устанавливается только control server'ом primary. В workers остаётся `null` (они полагаются на IPC bridge). Корректно, но хрупко — легко сломать, если worker начнёт его выставлять/использовать.

6. **Sync lock tail** — `src/cluster/syncLock.ts:4` (`let tail = Promise.resolve()`) — per primary; безопасно (sync primary-only), стоит задокументировать инвариант.

7. **(Связанное) Per-worker DB-коннекты:** каждый worker открывает собственную better-sqlite3 коннекцию к одному файлу (`api/server.ts:14`). WAL допускает multi-process, но N writers + primary могут упираются в write-contention/lock timeout (`dataSource.ts` `timeout: 5000`).

### План действий

1. **Rate limiter:** перенести состояние в общий хранилище (Redis или SQLite-таблица по IP+окну) с TTL-eviction; либо явно задокументировать per-worker семантику и скорректировать порог.
2. **Metrics:** либо per-worker метрики с worker-label + агрегация на уровне scrape, либо счётчики в общем хранилище (SQLite/Redis), а `/metrics` читает глобальное значение без сброса одного процесса.
3. **`isFirstFullSync`:** персистировать завершение в `Settings` (напр. ключ `sync.initial_done`), чтобы рестарт не перезапускал initial-путь; задокументировать «только primary синкает»; guard/лог при обнаружении двух процессов, синкающих одну БД.
4. **Hub outbox:** персистировать pending pointers (они уже маппятся на ревизии `SyncChangeLog` — drain по revision watermark вместо in-memory массива); добавить max-size bound + backpressure/drop-oldest.
5. **Задокументировать primary-only инварианты** (`notifyHandler`, sync lock, hub) комментариями в коде и README.
6. **DB concurrency:** оценить single-writer (все записи через primary/выделенный writer) vs N read-heavy workers; минимум — мониторинг `SQLITE_BUSY`.

### Критерий закрытия

- [ ] Состояние rate-limit вынесено из per-process памяти (общее хранилище) **или** явно задокументировано как per-worker с скорректированным порогом; проверено нагрузкой через ≥2 workers — один глобальный cap.
- [ ] `/metrics` возвращает корректное значение независимо от того, какой worker ответил (агрегированное или с label); проверено scrape'ом двух разных workers под нагрузкой.
- [ ] Поведение `isFirstFullSync` переживает рестарт без повторного initial full sync (лог после рестарта показывает streaming-путь).
- [ ] P2P outbox переживает рестарт primary (pointers дошли из персистентного revision watermark): убить primary с pending outbox → ни один pointer не потерян.

---

## Рекомендуемый порядок внутри шага

1. **0.4** (абсолютные пути) — маленький, высокоценный фикс; сделать первым.
2. **0.1** (граница слоёв) — разблокирует чистое тестирование из 0.2 и убирает хрупкий динамический импорт.
3. **0.3** (bigint guard/контракт) — latent-риск; добавить guard + тест.
4. **0.5** (cluster-safe state) — operational-риски; guards + персистентность.
5. **0.2** (тесты ядра) — объёмная работа, опирается на 0.1.
