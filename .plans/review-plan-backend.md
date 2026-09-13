# Backend Code Review Plan

> Статус: **план** (само ревью не проводилось).
> Базовый ресёрч выполнен по 4 ключевым модулям: sync+sources, p2p, db, api+media.
> Приоритизация — по риску (correctness / data integrity / security → maintainability).

## Карта модулей

| Модуль | Путь | ~Строк | Сложность | Тесты |
|---|---|---|---|---|
| Sync engine | `src/sync/`, `src/sources/` | ~500 | Med–High | ❌ нет |
| P2P replication | `src/p2p/` | ~1612 | High | ⚠️ минимально |
| DB layer | `src/db/` | ~2546 | High | ❌ нет |
| API + media | `src/api/`, `src/media/` | ~1300 | Med–High | ⚠️ частично |
| Cluster + utils + entrypoints | `src/cluster/`, `src/utils/`, `src/index.ts`, `src/cluster.ts`, `src/app/roles.ts` | ~400 | Low–Med | ❌ нет |

---

## Step 0 — Cross-cutting (архитектура, поперечные риски)

Цель: зафиксировать системные проблемы, которые влияют на несколько модулей сразу.

- [ ] **Циклическая зависимость `db` ↔ `p2p`.** `db/repositories/posts.ts` использует `await import("../../p2p/hub")` для обхода цикла; слои `db`/`p2p`/`media` взаимно проникают друг в друга. Определить чистую границу слоёв.
- [ ] **Отсутствие тестов на ядре.** `sync/`, `sources/`, `db/` (entities/repositories/migrations) — 0 тестов. Составить список критичных путей, которые нужно покрыть в первую очередь.
- [ ] **`bigint` → `number` (precision).** `db/transformers.ts` `bigintTransformer` конвертирует SQLite `bigint` в JS `number`. ID > 2^53 теряют точность. Проверить реальные диапазоны ID досок/постов.
- [ ] **Относительный путь БД** `./data/dev.db` — зависит от CWD; разный результат для `index.ts` vs `cluster.ts`.
- [ ] **In-memory state не cluster-safe.** Rate-limit map, metrics counter, `isFirstFullSync` — per-process; в cluster-режиме семантика искажается.

---

## Step 1 — P2P replication (наивысший риск)

Цель: корректность репликации, race conditions, безопасность.

### 1.1 `p2p/apply.ts` (366 строк, самая сложная)
- [ ] **Race: read-check-write без транзакции/row-lock** в `applyUpsert` (`findOne` → `lwwWins` → `save`). Конкурентные WS + push по одному ключу могут переплестись.
- [ ] **Delete не проходит LWW-гейт** — `applyDelete` удаляет безусловно; stale delete может затереть свежий upsert (delete-vs-update конфликт не разрешён).
- [ ] **LWW не сравнивает `revision`** — только `updatedAt`/`originNodeId`; lower-revision с higher `updatedAt` перепишет higher-revision.
- [ ] **Дублирование:** 7 почти идентичных upsert-ветвей — предложить table-driven schema map.
- [ ] **Sentinel-несогласованность `originNodeId`:** `"unknown"` (journal) vs `"remote"` (apply) vs `null` — влияет на LWW tie-break.

### 1.2 `p2p/client.ts` (311 строк)
- [ ] **Lost updates:** курсор продвигается до `meta.currentRevision` даже при ошибке отдельных записей; non-200 записи молча отбрасываются (нет retry/dead-letter).
- [ ] **Нет backoff/timeouts:** фиксированный 5s цикл, `fetch` без таймаутов, WS reconnect без backoff/jitter.
- [ ] **Unbounded outbox:** re-enqueue при неудачном push без лимита.
- [ ] **Snapshot streaming:** `readLengthPrefixedStream` буферизует без лимита; нет таймаута на fetch.

### 1.3 Безопасность
- [ ] **Репликация plaintext-креденшелов:** `ChatProfile.token` / `passphraseHash` уходят на все реплики (`raw.ts:profileToRaw`).
- [ ] **`auth.ts`:** сравнение токена `===` (не constant-time); shared static token; нет enforcement TLS.
- [ ] **`routes.ts`:** нет rate-limit на `/p2p/raw`, `/p2p/files`, `/p2p/snapshot`; `fs.statSync` в request path.
- [ ] **`controlServer.ts`:** `fetchRawFromCallback` доверяет `callbackBaseUrl` из тела push (SSRF-ish, смягчено токеном).

### 1.4 Прочее
- [ ] `raw.ts:iterateSnapshot` грузит полные таблицы в память (`find()` без пагинации).
- [ ] `schemaVersion.ts` — грубый гейт по имени последней миграции; любое расхождение hard-fail всего sync.
- [ ] **Тесты:** покрыть `applyUpsert`/`applyDelete` (7 таблиц), LWW tie-break, delete-vs-update, round-trip `raw.ts`, `hub.ts`, `client.ts`.

---

## Step 2 — Sync engine + sources

Цель: надёжность инжеста, обработка ошибок, дублирование.

### 2.1 Обработка ошибок / надёжность
- [ ] **Silent failure:** `parallelExecutor`/`parallelForEach` глотают per-item ошибки — упавший тред отбрасывается без retry и без записи о пропуске.
- [ ] **Нет HTTP timeout/retry в `sources/rest.ts`** — зависший upstream может повесить воркера навсегда (в отличие от media download, где таймауты есть).
- [ ] **`BOARD_INDEX_MAX_PAGES = 1000`** — тихий тримм досок с >20k тредов, без warning.
- [ ] **Pagination early-stop** — предположение, что `updated_at` индекса отражает активность всего треда; проверить семантику upstream.

### 2.2 Корректность / данные
- [ ] **Race на media-файлах:** конкурентные `processPosts` (из параллельного пула) + delete-логика `syncLocalMedia` — два пересекающихся sync'а могут удалить/перекачать одни и те же файлы. Sync lock защищает только entry points.
- [ ] **`processBoards.updated` — мёртвый счётчик** (всегда логирует `updated=0`).
- [ ] **`processPosts` counts — оценки** (считаются до фактического upsert, не отражают реальный результат).

### 2.3 Maintainability
- [ ] **Дублирование `getFullThreads` vs `getFullThreadsV2`** (~70% общей логики); V1 используется только для первого sync.
- [ ] **`isFirstFullSync` — per-process state**; при рестарте primary повторно идёт тяжёлый non-streaming путь. `runMonolith` создаёт **два** экземпляра сервиса.
- [ ] **`rest.ts:20`** — `exclude_tags[]=` в URL-строке, хрупко.

### 2.4 Тесты
- [ ] Покрыть `processPosts` (collect/dedupe), `getFullThreads` (filtering), `sources/rest.ts`.

---

## Step 3 — DB layer

Цель: целостность данных, производительность, атомарность.

### 3.1 Атомарность / транзакции
- [ ] **`chat.ts`: save + journal — две отдельные операции** (не атомарно); крах между ними рассинхронизирует БД и журнал. Затрагивает `markThreadRead`, `setHidden`, `setAlias`, `assignThreadFolder`, `deleteFolder`.
- [ ] **`boards.ts` insert/update:** `save` → `logChanges` → `broadcast` — три неатомарных шага.

### 3.2 Производительность (N+1)
- [ ] **`chat.ts:markAllReadByBoard`** — худший offender: O(threads) round-trips, каждый с journaling.
- [ ] **`apis.ts:threads.getByBoardTag` / `feed.getAll`** — по одному запросу на тред для replies.
- [ ] **`media.ts:replaceForPosts` / `stripLocalFilesForBoard`** — per-row update/delete циклы.

### 3.3 Индексы / схема
- [ ] **Нет индекса на `Media.postId`** (запрашивается постоянно).
- [ ] **`Post.boardId`** для non-thread lookups — partial index покрывает только `parentId IS NULL`.
- [ ] **`ProfileThreadState(profileId, threadId)`** — не индексирован.
- [ ] **`Settings.name` без unique constraint** — дубликаты тихо ломают `get`/`set`.

### 3.4 Миграции
- [ ] **`001`** — полная пересоздание таблицы `Post` (FK off, lock contention); `down()` не восстанавливает `boardId NOT NULL` (необратимо); создаёт orphaned `File`/`Passport` таблицы.
- [ ] **`007:backfillSyncIds`** — row-by-row `UPDATE` по всем таблицам; на больших таблицах держит write lock.

### 3.5 Прочее
- [ ] **`chat.ts:hashPassphrase`** — hardcoded default salt `"umechan-chat"` (слабый KDF, общий salt).
- [ ] **Дублирование:** "load-or-create state" блок повторяется 6+ раз в `chat.ts`; `chunkArray` дублируется в `media.ts` и `posts.ts`.
- [ ] **Тесты:** покрыть `syncPostsAndMedia`, N+1 запросы, миграции.

---

## Step 4 — API + media

Цель: безопасность, валидация, покрытие тестами.

### 4.1 Безопасность (приоритет)
- [ ] **`unmod` — client-controlled flag** (`?unmod=true`) обходит модерацию без секрета/токена. **Критичный authz gap** — проверить, не enforced ли это upstream.
- [ ] **CORS `origin: true, credentials: true`** — отражает любой origin с credentials; нужен явный allowlist.
- [ ] **Cookie без `Secure` flag** — уязвимость к краже cookie вне TLS.
- [ ] **Error handler утекает raw error object** клиенту (`server.ts`).
- [ ] **Metrics auth:** точное строковое сравнение (не constant-time); нет `Bearer` схемы.
- [ ] **Rate-limit:** только на `chat/identify`; нет на media download, force_sync, общий API. `request.ip` spoofable без `trustProxy`.

### 4.2 `api/routes/boards.ts` (351 строка, hotspot)
- [ ] **N+1:** `chat/board/:boardTag/threads` — `unreadCountForThread` внутри `Promise.all(threads.map(...))`.
- [ ] **Повторяющийся auth boilerplate** (`profileByToken` + 401) — кандидат на Fastify hook/decorator.
- [ ] **Валидация:** `Number(...) || undefined` — `0` (валидный offset) превращается в `undefined`; нет 400 на мусор.

### 4.3 Media pipeline
- [ ] **`syncLocalMedia` happy path не покрыт тестами** (download, hash, preview-change delete, stale rows, YouTube branch).
- [ ] **Error swallowing:** download/hash failures молчат (нет логирования).
- [ ] **Dead code в `download.ts`:** `if (lastError) return false; return false;` — обе ветви идентичны, `lastError` не логируется.
- [ ] **Check-then-act race** на download (fileExists → write) — смягчено sync lock, но не enforced.
- [ ] **`boardPrivacy.ts` — 0 тестов** (chunking, private-board filtering).
- [ ] **`serializers/post.ts` — 0 тестов** + type-unsafe cast `undefined as unknown as EpdsPost["board"]`.

### 4.4 Тесты (API)
- [ ] **Все API routes — 0 integration tests:** нет auth/401/404/429, rate-limit, metrics auth, media streaming.

---

## Step 5 — Cluster + utils + entrypoints (низший приоритет)

Цель: lifecycle, graceful shutdown, config.

- [ ] **Graceful shutdown:** нет явного `destroy()` DataSource в server paths (`server.ts`, `cluster.ts`, `roles.ts`) — полагается на exit процесса.
- [ ] **Unhandled promise rejections** — проверить в `runSyncLoop`, `connectLoop`, WS handlers.
- [ ] **Config validation:** env vars читаются без валидации/дефолтов в ряде мест; проверить `utils/config.ts`.
- [ ] **`parallelExecutor`** — edge cases (empty array, error propagation, two variants).
- [ ] **`cluster/syncLock.ts`** — promise-chain mutex: проверить корректность при ошибке в цепочке.
- [ ] **`app/roles.ts`** — bootstrap: два экземпляра sync service, порядок старта P2P control server vs client.

---

## Рекомендуемый порядок выполнения

1. **Step 0** — зафиксировать поперечные риски (быстро, задаёт рамки).
2. **Step 1 (P2P)** — наивысший риск: race, lost updates, безопасность.
3. **Step 2 (Sync)** — надёжность инжеста, silent failures.
4. **Step 3 (DB)** — атомарность, N+1, индексы, миграции.
5. **Step 4 (API+media)** — безопасность, валидация, тесты.
6. **Step 5 (Cluster/utils)** — lifecycle, config.

> Для каждого шага: (a) подтвердить/опровергнуть finding по коду, (b) оценить severity, (c) предложить фикс или тест.
