# Step 4 — API + media (безопасность, валидация)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода с file:line) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 4. Модули: `packages/backend/src/api/`, `src/media/`.

---

## 4.1 Безопасность (приоритет)

### 4.1.A `unmod` — сохранить флаг, добавить ChatUI authorization и audit log

**Находка.**
- Тог модерации читается напрямую из query string и передаётся в DB слой **в 7 местах**, все вида `request.query.unmod !== 'true'`:
  - `src/api/routes/boards.ts:29` → `db.apis.boards.getAll(request.query.unmod !== 'true')`
  - `boards.ts:47` → `boards.getByTag(...)`
  - `boards.ts:54`, `60` → `threads.getByBoardTag(...)`, `threads.getCountByBoardTag(...)`
  - `boards.ts:68` → `threads.getById(...)`
  - `boards.ts:77` → `posts.getById(...)`
  - `boards.ts:86`, `91` → `feed.getAll(...)`, `feed.getCount(...)`
- DB слой трактует булеан как жёсткий фильтр. В `src/db/repositories/apis.ts:5-13`:
  ```ts
  const applyModeratedBoardFilter = (qb, boardAlias, moderated) => {
    if (!moderated) return;                       // ← при unmod=true фильтра нет вообще
    qb.andWhere(`${boardAlias}.isPublic = :isPublic`, { isPublic: true });
    ...
  };
  ```
  То есть `?unmod=true` ⇒ `moderated=false` ⇒ **приватные доски и banned теги возвращаются любому вызывающему.**
- Grep по кодовой базе на `MODERATION_SECRET_PASS` по всему `src/`: **ноль использований в коде.** Переменная есть только в `.env:23`, `.env.example:25`, `README.md:83`, `REVIEW_PLAN.md`. Env var определена, но ни один route/middleware её не читает.
- Grep на `unmod` по `src/`: **только** `boards.ts` (строки 27–91). Другого гейта нет.

**Вывод:** bypass модерации полностью client-controlled. Требование плана: `unmod` не удалять, но сделать его effect доступным только после успешной авторизации через ChatUI; прямой query-параметр без ChatUI authorization должен оставлять обычную модерацию. Каждый авторизованный вход с `unmod` должен создавать structured audit log с пользователем/сессией, временем, контекстом маршрута и результатом проверки, без записи passphrase, cookie или profile token.

**План действий:**
1. Сохранить query-параметр `unmod` в публичном API contract и frontend navigation, но не трактовать его как самостоятельное разрешение.
2. Ввести server-side ChatUI authorization: по умолчанию `request.moderated = true`; переключать в `false` только для валидной авторизованной ChatUI-сессии с требуемой moderator role/permission. Не принимать произвольный profile token или сырой query как доказательство права.
3. Передавать в `db.apis.*` только server-resolved boolean, полученный из `unmod` + ChatUI authorization, а не сырой query input.
4. При каждом разрешённом входе с `unmod` писать structured audit event с user/session identity, timestamp, route/resource context и authorization result; исключить секреты и credential values из log fields.
5. Добавить интеграционные тесты: `?unmod=true` без ChatUI-сессии и с истекшей/недостаточной сессией сохраняет публичную фильтрацию; авторизованная ChatUI-сессия с правом unmod открывает приватный контент и создаёт audit log.

**Критерий закрытия:**
- [ ] `unmod` остаётся в API/client contract, но ни один route не использует его без server-side ChatUI authorization.
- [ ] В DB передаётся только server-resolved moderation boolean; raw query input не является authorization.
- [ ] Разрешённый вход с `unmod` создаёт structured audit log без passphrase, cookie и profile token.
- [ ] Интеграционный тест: неаутентифицированный или не имеющий нужного ChatUI permission `GET /api/v2/board/<privateTag>?unmod=true` → обычная публичная фильтрация; авторизованная ChatUI-сессия с permission → приватный контент и audit event.

---

### 4.1.B CORS `origin:true, credentials:true`

**Находка.**
- `src/api/server.ts:20-23`:
  ```ts
  fastify.register(fastifyCors, {
    origin: true,
    credentials: true,
  });
  ```
- API ставит session cookie (`umechan_chat_profile`, см. 4.1.C). С `origin:true` (отражать `Origin` запроса) **и** `credentials:true` любой сайт может выпускать credentialed cross-origin запросы к этому API и читать ответы — браузер приложит profile cookie, а отражённый origin разрешён. Это ломает same-site защиту для эндпоинта, который выдаёт cookies.

**План действий:**
1. Заменить `origin: true` на явный allow-list доверенных origins (env-driven, напр. `CORS_ORIGINS=https://app.example.com`).
2. Оставить `credentials:true` только если cookie-auth требуется cross-origin; иначе убрать и использовать non-cookie bearer token.
3. Если модель — same-site cookies, предпочесть `origin: <specific>` + `SameSite=Lax/Strict`.

**Критерий закрытия:**
- [ ] CORS config в `server.ts` использует явный список origins (без `true`).
- [ ] Запрос с credentials с нереестрированного origin получает разрешительный `Access-Control-Allow-Origin`; с реестрированного — получает.

---

### 4.1.C Profile cookie без флага `Secure`

**Находка.**
- `src/api/routes/boards.ts:113`:
  ```ts
  reply.header("Set-Cookie", `${CHAT_COOKIE_NAME}=${encodeURIComponent(profile.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  ```
- Флаги есть: `Path`, `HttpOnly`, `SameSite=Lax`, `Max-Age`. **Нет `Secure`.** Token cookie может передаваться по plain HTTP и быть перехваченным.

**План действий:**
1. Добавить `; Secure` в строку Set-Cookie (при необходимости гейтить на production/TLS флаг, если локальная dev требует non-HTTPS).
2. При необходимости рассмотреть `Partitioned`/короче `Max-Age`, но `Secure` — обязательный фикс.

**Критерий закрытия:**
- [ ] Выдаваемый `Set-Cookie` для `umechan_chat_profile` содержит `Secure`. Проверено интеграционным тестом, утверждающим на response header.

---

### 4.1.D Глобальный error handler утекает raw error object

**Находка.**
- `src/api/server.ts:25-28`:
  ```ts
  fastify.setErrorHandler((error: unknown, request, reply) => {
    logger.error(error);
    reply.status(500).send({ ok: false, error });   // ← raw error object сериализуется клиенту
  });
  ```
- Полный объект `error` (message, stack, вложенный cause, TypeORM/DB internals) отправляется в response body. Это утекает внутреннюю структуру и может раскрыть SQL или пути к файлам.

**План действий:**
1. Отправлять generic body: `reply.status(500).send({ ok:false, error: "internal server error" })`.
2. Полные детали держать только в `logger.error(error)`.
3. Опционально мапить известные Fastify/validator ошибки на 4xx с безопасными сообщениями до catch-all.

**Критерий закрытия:**
- [ ] Вброшенная внутренняя ошибка возвращает body без stack traces и DB internals; детальный объект виден только в server logs. Проверено интеграционным тестом, триггерящим 500 и утверждающим на shape ответа.

---

### 4.1.E `/metrics` auth: точное строковое сравнение, нет Bearer схемы, FAIL-OPEN при unset

**Находка.**
- `src/api/routes/util.ts:60`:
  ```ts
  if (request.headers['authorization'] !== process.env.METRICS_PASSWORD) {
    reply.code(404); reply.send(); return;
  }
  ```
- **Не constant-time:** использует `!==` на строках — timing side-channel.
- **Нет парсинга Bearer схемы:** клиент должен отправить *всё* сырое значение (по `.env:25`, `"Basic base64_secret="`) как заголовок `Authorization`, а не разобранный токен.
- **Fail-open при unset:** если `METRICS_PASSWORD` undefined и у запроса нет заголовка `Authorization`, то `undefined !== undefined` → `false` → guard пропускается, и `/metrics` отдаётся кому угодно. То есть незаconfigured деплой открывает метрики без аутентификации.

**План действий:**
1. Fail-closed: если `process.env.METRICS_PASSWORD` не задан — всегда возвращать 404 (или отключить route).
2. Парсить правильную схему (`Bearer <token>` или `Basic <creds>`) и сравнивать только токен-часть через `crypto.timingSafeEqual`.
3. Гейтить различающиеся длины до `timingSafeEqual`.

**Критерий закрытия:**
- [ ] При unset `METRICS_PASSWORD` `GET /metrics` → 404 для всех запросов (без заголовка или с любым).
- [ ] При заданном: неверный/отсутствующий auth → 404; верный Bearer токен → 200. Сравнение — constant-time.

---

### 4.1.F Rate limiting только на `chat/identify`; нет лимитов в остальных местах; spoofable IP

**Находка.**
- In-memory limiter есть **только** для identify: `src/api/routes/boards.ts:6` (`const identifyRateLimit = new Map<string, number[]>();`) и handler на `boards.ts:97-105`:
  ```ts
  const identity = request.ip ?? "unknown";
  const now = Date.now();
  const history = (identifyRateLimit.get(identity) ?? []).filter((ts) => now - ts < 60_000);
  if (history.length >= 10) { reply.status(429).send({ error: "too many identify attempts" }); return; }
  identifyRateLimit.set(identity, [...history, now]);
  ```
  → 10/мин на `request.ip`, in-memory (per-process, сбрасывается при рестарте, неограниченный рост карты — нет eviction устаревших ключей сверх 60s фильтра).
- **Нет rate limit** на: media download (`src/api/routes/media.ts`), `force_sync` (`util.ts:12`) и вообще ни на одном общем API route.
- **IP spoofability:** grep на `trustProxy` по всему `packages/backend/src/`: **ноль совпадений.** Fastify создан без `trustProxy`. Последствия: за load balancer'ом/CDN `request.ip` — адрес прокси (все реальные пользователи схлопываются в один бакет → лимит 10/мин становится фактически глобальным и тривиально исчерпывается), при этом сейчас нет безопасного способа доверять `X-Forwarded-For`.

**План действий:**
1. Корректно настроить `trustProxy` под топологию деплоя (напр. `createFastify({ trustProxy: true })` только за известным прокси, либо явный CIDR список).
2. Добавить rate limiting на media download и `force_sync` (и рассмотреть глобальный per-IP limiter), используя общее хранилище (Redis), чтобы лимиты были консистентны между cluster workers, а не в per-process памяти.
3. Ограничить in-memory карту (TTL eviction / LRU) или перенести в Redis.

**Критерий закрытия:**
- [ ] `trustProxy` явно настроен и задокументирован под реальную топологию.
- [ ] Media download + `force_sync` возвращают 429 при устойчивой нагрузке; identify лимит работает per real client IP. Лимиты персистентны/консистентны между workers (общее хранилище).

---

## 4.2 `api/routes/boards.ts` (351 строка, hotspot)

### 4.2.A N+1 в `GET /api/v2/chat/board/:boardTag/threads`

**Находка.**
- Handler начинается на `boards.ts:127`. После батчинга states/folders/previews (строки 145-150) идёт per-thread цикл:
  - `boards.ts:154`: `const responseItems = await Promise.all(threads.map(async (thread) => {`
  - `boards.ts:157`: `const unreadCounter = await db.chat.unreadCountForThread(profile.id, thread.id, lastSeenPostId);`
- `unreadCountForThread` (`src/db/repositories/chat.ts:285`) сам выпускает **два** запроса на вызов (`ProfileOwnPost.find(...)` + `Post.getCount()`). Итого для N тредов цикл делает **≈ 2N DB round-trips**, поверх фиксированных батченных вызовов (`listThreadsByBoard`, `countThreadsByBoard` и 4-query `Promise.all` на строках 145-150 ≈ ещё 6). Всего ≈ **2N + 6** round trips на N тредов.

**План действий:**
1. Заменить per-thread цикл единым batched query: вычислить unread counts для всех `(profileId, threadId, lastSeenPostId)` кортежей одним (или несколькими) SQL statement'ами по `threadId`, затем мапить результаты обратно — как states/previews уже батчатся через `In(threadIds)`.
2. Если per-thread own-post exclusion делает единый query неудобным — как минимум схлопнуть два запроса внутри `unreadCountForThread` в один и забатчить между тредами.

**Критерий закрытия:**
- [ ] Для N тредов DB round-trips O(1) (константа), а не O(N). Проверено тестом, считающим query'ы (напр. TypeORM query logger / mock) для доски с ≥ 20 тредами и утверждающим, что число независимо от N.

---

### 4.2.B Повторяющийся auth boilerplate (`getProfileToken` + `profileByToken` + 401)

**Находка.** — **13 handler'ов** повторяют один и тот же паттерн token-extraction → `profileByToken` → 401:

| # | Route / handler | строки profile |
|---|-----------------|-------------|
| 1 | `GET /api/v2/chat/session` | `boards.ts:118` |
| 2 | `GET /api/v2/chat/board/:boardTag/threads` (через промежуточную переменную) | token `:129`, profile `:130`, 401 `:131-134` |
| 3 | `GET /api/v2/chat/thread/:postId` | `boards.ts:187` |
| 4 | `POST /api/v2/chat/thread/:postId/read` | `boards.ts:204` |
| 5 | `POST /api/v2/chat/board/:boardTag/read_all` | `boards.ts:221` |
| 6 | `POST /api/v2/chat/thread/:postId/hidden` | `boards.ts:232` |
| 7 | `POST /api/v2/chat/thread/:postId/alias` | `boards.ts:243` |
| 8 | `GET /api/v2/chat/board/:boardTag/folders` | `boards.ts:254` |
| 9 | `POST /api/v2/chat/board/:boardTag/folders` | `boards.ts:270` |
| 10 | `PUT /api/v2/chat/folder/:folderId` | `boards.ts:291` |
| 11 | `DELETE /api/v2/chat/folder/:folderId` | `boards.ts:311` |
| 12 | `POST /api/v2/chat/thread/:postId/folder` | `boards.ts:326` |
| 13 | `POST /api/v2/chat/own_post` | `boards.ts:337` |

Каждый дублирует: читать токен (cookie/query/body) → `await db.chat.profileByToken(...)` → `if (!profile) { reply.status(401)...; return; }`.

**План действий:**
1. Добавить Fastify decorator или общий хелпер, напр.:
   ```ts
   fastify.decorateRequest("getProfile", async function () { ... }); // читает cookie/query/body токен
   ```
   плюс `preHandler` (или per-route hook), который разрешает профиль и либо ставит `request.profile`, либо шлёт 401. Handler'ы тогда просто используют `request.profile`.
2. Централизовать приоритет «источника токена» (cookie → query → body) в одном месте, а не выводить заново в каждом handler'е.

**Критерий закрытия:**
- [ ] Литеральный блок `profileByToken(` + 401 встречается один раз (в hook/decorator), а не 13; handler'ы ссылаются на разрешённый профиль. Grep на `reply.status(401)` в `boards.ts` сокращается до единственного общего места.

---

### 4.2.C Валидация: `Number(...) || undefined` / `|| 0`

**Находка.**
- `Number(x) || undefined` (тихий NaN→default, и валидный `0`→undefined):
  - `boards.ts:56-58` — board threads `offset`, `limit`, `thread_size`
  - `boards.ts:87-89` — feed `offset`, `limit`, `thread_size`
  - `boards.ts:142` — chat board threads `limit`
- `Number(x) || 0`:
  - `boards.ts:141` — `const offset = Number(request.query.offset) || 0;` (NaN→0 тихо; валидный 0 сохраняется)
- Режимы сбоя: `?offset=abc` → `NaN || undefined` ⇒ трактуется как default **без 400**; `?offset=0` на строках с `|| undefined` ⇒ становится `undefined`, хотя 0 — легитимный offset.
- Контраст — явные корректные проверки есть в том же файле и в media:
  - `boards.ts:345` (own_post): `if (!Number.isFinite(threadId) || threadId <= 0 || !Number.isFinite(postId) || postId <= 0)` → правильный 400.
  - `src/api/routes/media.ts`: `if (!Number.isFinite(threadId) || threadId <= 0)` → 400.

**План действий:**
1. Ввести небольшой парсер, напр. `parsePositiveInt(value, { allowZero })`, возвращающий `{ ok, value }`, и возвращать **400** на non-finite/отрицательный input вместо тихого default'а.
2. Применить ко всем шести coercion местам (56-58, 87-89, 141-142), соответствуя стилю `Number.isFinite`, уже используемому в own_post/media.

**Критерий закрытия:**
- [ ] Нигде не осталось `Number(...) || undefined` / `|| 0` для query параметров; невалидные значения дают 400, а `offset=0` принимается там, где валиден. Покрыто тестами: 400 на `?offset=abc`, корректная пагинация на `?offset=0`.

---

## 4.3 Media pipeline

### 4.3.A Happy path `syncLocalMedia` не покрыт тестами

**Находка.**
- Тест-файл `src/media/syncLocalMedia.test.ts` содержит **ровно один тест**: `"keeps media metadata but does not download files"` (ветка `skipDownload: true`). Ставит заглушку на `global.fetch`, утверждает `fetchCalls === 0` и что `localPath`/`localPreviewPath` null.
- Непокрытые ветки в `src/media/syncLocalMedia.ts`:
  - **Фактическая загрузка** — non-skip Image/Video путь → `resolveLocalPath` → `downloadMediaFile` (~строки 108-124).
  - **Вычисление хэша** — `hashLocalFile(localPath)` / `hashLocalFile(localPreviewPath)` для `contentSha256`/`previewSha256` (~строки 127-128), включая fallback `?? existing?.contentSha256`.
  - **Удаление при смене preview** — `if (existing && existing.urlPreview !== item.preview) { await deleteFile(existing.localPreviewPath); localPreviewPath = null; }` (~строка 104).
  - **Удаление stale existing строк** — pre-loop `for (const existing of existingMedia) { if (!incomingKeys.has(key)) await deleteFilesForMedia(existing); }` (~строки 78-86).
  - **YouTube ветка** — `item.mediaType === MediaTypeEnum.YouTube` → null пути, без загрузки (~строка 92).
  - **Preview-absent else ветка** — удаляет `existing.localPreviewPath`, когда incoming без preview (~строки 118-123).

**План действий:**
1. Добавить тесты со stubbed `db.media.getByPostIds`, stubbed/real temp-dir storage и контролируемым `fetch`:
   - download путь пишет файл + вычисляет хэши;
   - YouTube item даёт null пути и без fetch;
   - смена preview URL триггерит удаление старого preview файла;
   - existing строка, чей key отсутствует в incoming, получает удаление файлов;
   - отсутствующий incoming preview удаляет ранее сохранённый preview.

**Критерий закрытия:**
- [ ] Каждая перечисленная ветка имеет хотя бы один проходящий тест, утверждающий конкретный side effect (файл создан/удалён, значение хэша, null пути). `fetchCalls`/fs assertions доказывают download vs skip поведение.

---

### 4.3.B Error swallowing в `download.ts` и `hash.ts`

**Находка.**
- `src/media/download.ts:61-64`:
  ```ts
  if (lastError) {
    return false;
  }
  return false;
  ```
  Обе ветки возвращают `false`; `lastError` захвачен (строка 51), но **никогда не логируется и не используется** — сбои молчаливы.
- `src/media/hash.ts:12-14`:
  ```ts
  } catch {
    return null;
  }
  ```
  Catch-all возвращает `null` без логирования — отсутствующий файл, permission error или read failure неотличимы от «нет хэша».

**План действий:**
1. В `download.ts` логировать `lastError` (с url/attempt контекстом) перед return false; схлопнуть избыточную ветку в единый `return false`.
2. В `hash.ts` логировать пойманную ошибку (path + причина) перед return null, либо rethrow для по-настоящему неожиданных ошибок и возвращать null только для ожидаемых «нет файла» случаев.

**Критерий закрытия:**
- [ ] Сбой загрузки и сбой хэширования каждый производят server-side log запись с причиной; молчаливых `return false`/`return null` на error путях не осталось.

---

### 4.3.C Dead code в `download.ts`

**Находка.**
- `src/media/download.ts:61-64` (показано выше): `if (lastError) { return false; } return false;` — условие мёртвое, т.к. оба исхода идентичны. Это избыточная ветка для удаления.

**План действий:**
1. Заменить строки 61-64 единым `return false;` (после логирования `lastError`, по пункту B).

**Критерий закрытия:**
- [ ] Функция заканчивается одним терминальным `return false;`; недостижимых/дублирующихся return не осталось.

---

### 4.3.D Check-then-act race на download

**Находка.**
- `src/media/download.ts:80-91` (`downloadMediaFile`):
  ```ts
  if (fileExists(relativePath)) { return relativePath; }   // check
  await ensureThreadDir(params.threadId);
  const absolutePath = resolveAbsolutePath(relativePath);
  ...
  const ok = await downloadToAbsolutePath(params.url, absolutePath);  // act (write)
  ```
- `src/media/syncLocalMedia.ts:38-45` (`resolveLocalPath`) имеет тот же check-then-download shape.
- **Race:** два конкурентных sync'а могут оба наблюдать `fileExists === false` и оба писать один путь → torn/partial файл или дублирующая работа. Крах mid-write также оставляет partial файл, который затем проходит `fileExists` при следующем запуске (нет integrity check).
- **Митигация есть, но не enforced здесь:** app-level сериализующий lock существует — `src/cluster/syncLock.ts` (`createSyncLock`) создаётся в `src/cluster.ts:108` и оборачивает и периодический full-sync (`runSyncLoop`, `app/roles.ts:69`), и IPC force_sync (`src/cluster/ipc.ts:112`). Он сериализует sync jobs **внутри primary процесса**, но не применяется внутри `downloadMediaFile`/`resolveLocalPath`, нет per-file lock, и записи не атомарны (нет temp-file + rename). Файловый check-then-act остаётся небезопасным между процессами или при partial-write recovery.

**План действий:**
1. Сделать записи атомарными: качать в уникальный temp path в той же директории, затем `fs.promises.rename` поверх цели; существующий валидный файл считать успехом.
2. Опционально добавить per-path mutex (или полагаться на sync lock) и/или проверять content hash после записи перед тем, как считать её завершённой.

**Критерий закрытия:**
- [ ] Загрузки используют temp+rename (без прямой перезаписи финального пути); конкурентные загрузки одного медиа не портят файл; partial/crashed download детектируется (hash mismatch или отсутствующий temp), а не принимается через `fileExists`.

---

### 4.3.E `boardPrivacy.ts` — ноль тестов

**Находка.**
- Нет `boardPrivacy.test.ts` в `src/media/` (в директории только тесты `download`, `paths`, `storage`, `syncLocalMedia`).
- Логика, требующая покрытия:
  - `chunkArray` (`boardPrivacy.ts:6-13`): `chunkSize <= 0` → `[items]`; нормальный чанкинг группами по `SQL_IN_CHUNK_SIZE = 500`.
  - `getPrivateBoardIds` (`:15-32`): дедупликация + отбрасывание non-finite id; пустой input → пустой set; возвращает только доски, где `!isPublic`.
  - `getMediaSyncIdsOnPrivateBoards` (`:34-71`): post→board маппинг, обработка null `postId`/`boardId`, возврат `syncId` медиа, чьи посты на приватных досках.

**План действий:**
1. Добавить тест-файл с in-memory/faked TypeORM `DataSource`:
   - границы чанкинга (0, <500, ровно 500, >500);
   - пустые / non-finite board id input'ы;
   - смешанные public/private доски → возвращаются только private id;
   - медиа на приватных vs публичных постах → корректный set `syncId`; строки с null postId/boardId игнорируются.

**Критерий закрытия:**
- [ ] Проходящий тестовый suite утверждает размеры чанков, private-only фильтр и точный set media syncIds, помеченных как приватно-досочные (включая edge cases: пустой input, >500 id, null foreign keys).

---

### 4.3.F `serializers/post.ts` — ноль тестов + type-unsafe cast

**Находка.**
- Нет тест-файла в `src/api/serializers/` (только `post.ts`).
- Type-unsafe cast на `src/api/serializers/post.ts:43`:
  ```ts
  board: post.board
    ? { id: Number(post.board.id), tag: post.board.tag, name: post.board.name }
    : (undefined as unknown as EpdsPost["board"]),   // ← заявляет значение, фактически undefined в рантайме
  ```
- `mediaTypeToEpds` (`post.ts:7-12`) молча дефолтит любой нераспознанный string на `PISSYKAKA_IMAGE`.
- Рекурсия/null обработка в `serializePost`/`serializePosts` (~строки 46-53): `replies` мапятся рекурсивно с `.filter(item => item != null)`; `media?.map(serializeMedia)`.

**План действий:**
1. Починить тип: сделать `EpdsPost["board"]` опциональным (`board?: ...`) или выдавать хорошо определённый sentinel, убрав cast `as unknown as`.
2. Добавить тесты, утверждающие:
   - null/undefined post → `null`;
   - post с и без `board` → корректный board объект / отсутствующее поле;
   - вложенные replies сериализуются рекурсивно и отбрасывают null'ы;
   - маппинг `mediaTypeToEpds` для YOUTUBE, VIDEO и неизвестного string (задокументировать дефолт).

**Критерий закрытия:**
- [ ] Cast `as unknown as EpdsPost["board"]` удалён (тип сделан опциональным или значение хорошо определено); проходящий тестовый suite покрывает null post, board present/absent, рекурсивные replies и media-type маппинг.

---

## 4.4 Тесты (API) — ноль интеграционного покрытия

**Находка.**
- Поиск файлов `packages/backend/src/api/**/*.test.*` возвращает **нет файлов**. Нет ни unit, ни integration тестов нигде под `src/api/` (`routes/boards.ts`, `routes/media.ts`, `routes/util.ts`, `serializers/post.ts`). Единственные бэкенд-тесты живут в `media/` и `p2p/`.
- Соответственно, не верифицировано ни одно из следующих поведения:
  - **Auth / 401 / 404 / 429** по chat routes (13 profile-gated handler'ов).
  - **Rate-limit поведение** на `chat/identify` (10/мин/IP → 429; in-memory reset семантика).
  - **Metrics auth**, включая критичный fail-open-when-unset случай (пункт 4.1.E).
  - **Media streaming endpoint** `GET /api/v2/media/:threadId/:filename` (`media.ts`): path-traversal guard через `isSafeFilename`, невалидный thread id → 400, отсутствующий файл → 404, корректные `Content-Type`/`Cache-Control`.
  - **`force_sync`** (`util.ts:12`): валидный/невалидный `thread_id`, 503 когда sync недоступен, 500 при ошибке.

**План действий:**
1. Добавить интеграционный тестовый харнес (напр. Fastify `inject()` против реальной или stubbed БД), покрывающий каждую перечисленную группу route'ов.
2. Приоритет: metrics fail-open, media path-traversal/404, identify rate-limit 429 и regression ChatUI authorization/audit для `unmod` (связь с 4.1.A).

**Критерий закрытия:**
- [ ] Существует и проходит хотя бы один интеграционный тест на группу эндпоинтов, утверждающий статус-коды и ключевые поля ответа: 401 без токена, 404 для отсутствующей доски/треда/файла, 429 после превышения identify лимита, `/metrics` 404 при unset `METRICS_PASSWORD`, media 400/404 на невалидном input, и `force_sync` 503/500 пути.

---

## Рекомендуемый порядок внутри шага (по риску)

1. **4.1.A** (`unmod` authorization через ChatUI + audit log) — критичный authz gap; закрыть первым.
2. **4.1.E** (metrics fail-open) + **4.1.D** (error handler leak) — быстрые, высокоценные security фиксы.
3. **4.1.B/C/F** (CORS, cookie Secure, rate-limit/trustProxy) — security hardening.
4. **4.2.A/B/C** (`boards.ts` hotspot: N+1, auth boilerplate, валидация).
5. **4.3.A–F** (media pipeline: тесты happy path, error swallowing, dead code, race, boardPrivacy/serializers покрытие).
6. **4.4** (интеграционные тесты API) — опирается на 4.1–4.3.

> Поперечные заметки: `trustProxy` нигде не настроен (см. 4.1.F); `MODERATION_SECRET_PASS` — мёртвая конфигурация, определённая в `.env`/README, но не читаемая кодом (см. 4.1.A); app-level sync lock (`cluster/syncLock.ts`) сериализует sync jobs внутри primary процесса, но не защищает файловые check-then-act записи (см. 4.3.D).
