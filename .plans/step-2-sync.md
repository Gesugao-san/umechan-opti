# Step 2 — Sync engine + sources (надёжность инжеста)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода с file:line) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 2. Модули: `packages/backend/src/sync/`, `src/sources/`.

---

## 2.1 Обработка ошибок / надёжность

### 2.1.A Silent failure в параллельных исполнителях (`utils/parallelExecutor.ts`)

**Находка.**
- `parallelExecutor` (строки 3–42). Per-item ошибка ловится и выбрасывается на **строках 22–25**:
  ```ts
  try {
    result.push(await task());          // строка 23
  } catch (e) {
    logger.error((e as Error).message); // строка 24 — залогировано, затем элемент потерян
  } finally { ... nextTick(() => run(runnerId)); }
  ```
- Что теряется при падении fetch треда/доски: **нет retry**, **нет записи о том, какой именно элемент упал** (упавший `taskEntry`/index нигде не фиксируется), и возвращаемый массив `result` **короче `dataArray`**. Downstream (`getFullThreads` ~строка 70 `.flatMap`, `processPosts`) просто никогда не видит этот тред — он молча отсутствует в БД на этом цикле.
- `(e as Error).message`: если `e` не `Error` (брошенная строка/число), `.message` = `undefined` → логируется `"undefined"`. Если `e` = `null`/`undefined`, обращение к `.message` **бросает TypeError внутри catch**, который вылетает из `run()` и может сбить runner. «Безопасный» cast на деле не безопасен для non-Error rejections (axios отклоняется с `AxiosError`, но брошенный примитив/null его сломает).
- **`parallelTasks <= 0` → promise hang.** Строка 10: `new Array(parallelTasks).fill(false)`; строки 37–39: цикл запускает runners. При `parallelTasks = 0` или отрицательном тело цикла не выполняется, и `resolve` (строка 14) **никогда не вызывается** → возвращённый promise висит вечно. Вызывающий (`getFullThreads`) ждёт его бесконечно.
- `parallelForEach` (~строки 48–75): тот же swallow в catch; при `parallelTasks <= 0` → `workers = Math.min(parallelTasks, len)` = 0 → **молчаливый no-op** (не hang), ничего не обработано.

**План действий:**
1. В обоих исполнителях фиксировать упавший элемент и выносить его наружу: catch логирует с контекстом (`tag`/`threadId`) и собирает failures в массив, возвращаемый вместе с результатами (напр. `Promise<{ results: K[]; errors: Array<{ index: number; error: unknown }> }>`), — или как минимум типизированный хелпер `safeMessage(e)`, безопасно обрабатывающий non-Error/null.
2. Добавить retry-with-backoff для транзиентных сбоев (зеркалить паттерн из `media/download.ts`: attempt loop + delay), настраиваемый через config.
3. Guard `parallelTasks`: clamp к `Math.max(1, parallelTasks)` в начале обеих функций (+ проверка, что `dataArray` — массив). Убирает и hang, и silent no-op.
4. Определить политику частичного сбоя: либо громко падать весь sync, либо фиксировать пропущенные ID для целевой пересборки в следующем цикле.

**Критерий закрытия:**
- [ ] Юнит-тест: при одном падающем task `parallelExecutor` возвращает массив длиной input−1 **и** сообщает, какой index упал (без молчаливого дропа).
- [ ] Юнит-тест: `parallelTasks = 0` и `-5` не вешаются/не no-op'ят — либо бросают явную ошибку, либо клампятся к 1.
- [ ] Путь ошибки (`safeMessage`) обрабатывает брошенные `null`, строку и `Error` без падения внутри catch (покрыто тестами).

---

### 2.1.B Нет HTTP timeout/retry в `sources/rest.ts`

**Находка.**
- Клиент создан **без timeout**: строка 14 `const request = axios.create({ baseURL: params.baseUrl });`.
- Три вызова, ни у одного нет timeout/retry/обработки ошибок (axios бросает на non-2xx и пропагирует):
  - `getBoardsList` — строка 18: `request.get<ApiTemplate<ResponseBoardsList>>("/v2/board?exclude_tags[]=", { params: { limit } })`.
  - `getThreadsList` — строки 29–31: `request.get(..., { params: { offset, limit, no_board_list: "true" } })`; возвращает `response.data.payload?.posts || []`.
  - `getThreadPostsList` — строка 37: `request.get<ApiTemplate<ResponseThreadPostsList>>(\`/v2/post/${threadId}\`)` — **без config-объекта вообще**.
- Контраст с `src/media/download.ts`, который надёжен: retry loop `for (let attempt = 1; attempt <= getMediaDownloadMaxRetries(); attempt++)` (дефолт 5), `AbortController` + `setTimeout(() => controller.abort(), getMediaDownloadTimeoutMs())` (дефолт 30s) на попытку, и `isRetryableStatus(status) { return status >= 500 }` с delay между попытками. Media-загрузки имеют timeout+retry; **API source вызовы — ни того, ни другого**.
- Последствие: один зависший/медленный upstream-ответ блокирует слот исполнителя бесконечно (усугубляя риск hang из 2.1.A), а любой 4xx/5xx прерывает весь sync-цикл без retry и частичного прогресса.

**План действий:**
1. Добавить `timeout` на axios instance (напр. `axios.create({ baseURL, timeout: getApiRequestTimeoutMs() })`) — новый config getter по образцу `getMediaDownloadTimeoutMs`.
2. Обернуть каждый из трёх методов в retry-хелпер (attempt loop + backoff на network errors и 5xx), переиспользуя форму из `download.ts` (`isRetryableStatus`, delay). Рассмотреть вынос общего `withRetries(fn)` утилиты, чтобы media и sources делили её.
3. Нормализовать обработку ошибок: catch, лог с контекстом (tag/threadId/offset), либо retry, либо типизированная ошибка, которую sync-слой может привязать к конкретному элементу.

**Критерий закрытия:**
- [ ] В `rest.ts` на axios instance явно настроен request timeout (видно в коде + тест: зависший mock server отклоняется примерно за timeout).
- [ ] Каждый из трёх методов ретраит транзиентные сбои (5xx/network) до N раз с backoff — покрыто mocked-axios тестом «падает дважды, затем успешно».
- [ ] Non-retryable 4xx даёт залогированную атрибутируемую ошибку, а не unhandled rejection.

---

### 2.1.C `BOARD_INDEX_MAX_PAGES = 1000` — тихий тримм (`sync/getFullThreads.ts`)

**Находка.**
- Константа на **строке 9**: `const BOARD_INDEX_MAX_PAGES = 1000;`.
- Цикл пагинации в `fetchBoardThreadIndex`, ~строка 26: `for (let page = 0; page < BOARD_INDEX_MAX_PAGES; page++) { ... }` с `limit = fetchEntitiesFromApiBaseLimit` (дефолт **20**, config.ts строка 5).
- Единственные выходы: пустая страница (`posts.length === 0`, ~строка 28), early-stop эвристика (~строки 39–43, только когда передан `db`) и короткая страница (`posts.length < limit`, ~строка 47). **Когда цикл просто доходит до `page === 1000`, он выходит без лога/предупреждения** — ветки «cap reached» нет.
- Тихо урезаемые данные: доска с >20 000 тредов (1000 страниц × 20/страницу) даёт ровно ~20 000 тредов, остальные никогда не качаются и не сохраняются, **без строки лога о truncation**. V1 (`getFullThreads`) вызывает `fetchBoardThreadIndex(source, tag)` **без** `db`, поэтому не может early-stop'ить и всегда упирается в cap на больших досках.

**План действий:**
1. После цикла детектить cap: если последняя полученная страница была полной (`posts.length === limit`) и выход произошёл из-за достижения max (а не короткой/пустой страницы) — логировать **warning** с board tag + счётчиком, напр. `logger.warn(\`Board ${tag} index truncated at BOARD_INDEX_MAX_PAGES=${...} (${list.length} threads)\`)`.
2. Сделать cap настраиваемым (`getBoardIndexMaxPages()`) и/или поднять; рассмотреть cursor/continuation, чтобы большие доски полностью покрывались между циклами вместо жёсткого отреза.
3. Выносить truncation операторам (метрика/лог), чтобы тихая потеря данных была наблюдаема.

**Критерий закрытия:**
- [ ] Тест с mock source, возвращающим полные страницы за пределами cap: логируется warning и длина результата = `cap × limit` (truncation явная, не молчаливая).
- [ ] В коде есть отдельная ветка «cap reached», отличная от нормального завершения короткой страницей.

---

### 2.1.D Pagination early-stop эвристика (`sync/getFullThreads.ts`)

**Находка.**
- Эвристика в `fetchBoardThreadIndex`, ~строки 33–45 (активна только когда передан `db`, т.е. V2):
  ```ts
  if (db) {
    const storedUpdatedAt = await db.posts.getUpdatedAtByIds(posts.map((t) => t.id)); // ~строка 34
    const pageFullySynced = posts.every((thread) => {                                  // ~строка 35
      const dbUpdatedAt = storedUpdatedAt.get(thread.id);                             // ~строка 36
      return dbUpdatedAt !== undefined && dbUpdatedAt === thread.updated_at;         // ~строка 37
    });
    if (pageFullySynced) { logger.info(...); break; }                                 // ~строки 39–43
  }
  ```
- **Предположение:** board index упорядочен по `updated_at` (bump-ordered), и `updated_at` root-поста в индексе отражает **активность всего треда** (реплии его повышают). Если все треды страницы совпадают с DB `updated_at`, то все более старые страницы тоже неизменены → стоп.
- То же предположение переиспользуется в per-thread skip фильтре V2 (`getFullThreadsV2`, ~строки 108–117): тред пропускается от full fetch, если `dbUpdatedAt === thread.updated_at`. Docstring даже формулирует допущение: *"assumes board index updated_at reflects whole-thread activity, not OP-only."*
- **Как теряется обновление при неверном предположении:** если upstream **не** повышает root/OP `updated_at` при добавлении реплии (только правка OP его повышает), то тред, уже существующий в БД с совпадающим `updated_at`, но с **новыми реплиями**, либо: (a) удовлетворит `pageFullySynced` и вызовет early-stop до того, как его полная версия будет получена, либо (b) будет отфильтрован skip'ом V2. В обоих случаях новые реплии никогда не качаются → тихая потеря данных до тех пор, пока какое-то другое изменение не повысит `updated_at` этого треда.

**План действий:**
1. Эмпирически проверить семантику upstream: подтверждает ли добавление реплии изменение root-поста index `updated_at` (лог/сравнение на живой доске). Задокументировать подтверждённое поведение в docstring.
2. Если это OP-only — **не** полагаться на root `updated_at` для skip/early-stop. Варианты: (a) убрать эвристику и всегда качать полные треды; (b) вести per-thread reply count / last-reply timestamp из индекса, если доступен; (c) периодически принудительно перекачивать вращающийся срез как страховку.
3. Сделать эвристику opt-in через config с явным дефолтом и логировать, когда она пропускает N тредов, чтобы покрытие было аудируемо.

**Критерий закрытия:**
- [ ] Тест: early-stop срабатывает только когда все треды страницы совпадают с DB `updated_at` и **не** срабатывает при одном различии (mock `getUpdatedAtByIds`).
- [ ] Предположение о семантике upstream `updated_at` задокументировано с подтверждённым источником, либо эвристика убрана/ограничена. Если оставлена — тест демонстрирует, что missed-reply сценарий обработан (напр., не пропускается).

---

## 2.2 Корректность / данные

### 2.2.A Race на media-файлах (`processPosts.ts` + `syncLocalMedia.ts` + `cluster/syncLock.ts`)

**Находка.**
- `processPosts` (`src/sync/processors/processPosts.ts`, строки 86–124):
  - `collectPostsWithThreadIds` (строки 12–30) дедуплицирует по `post.id` и строит `threadIdByPostId`.
  - `getExistingIds` ~строка 97; счётчики считаются до upsert (см. 2.2.C).
  - `privateBoardIds = await db.boards.getPrivateIds(...)` ~строка 102.
  - `collectMediaItems(uniquePosts, threadIdByPostId, privateBoardIds)` строки 34–85 (`skipDownload = privateBoardIds.has(post.board_id)`).
  - **`syncLocalMedia(db, mediaItems, uniquePosts.map((post) => post.id))`** ~строка 110 — `allPostIds` ограничен **только постами этого треда**.
  - **`db.posts.syncPostsAndMedia(uniquePosts, syncedMedia)`** ~строка 113.
- Delete-логика в `syncLocalMedia` (`src/media/syncLocalMedia.ts`), ~строки 62–70:
  ```ts
  for (const existing of existingMedia) {           // existingMedia ограничен postIds (этот тред)
    const key = mediaKey({ postId, mediaType, urlOrigin });
    if (!incomingKeys.has(key)) {
      await deleteFilesForMedia(existing);          // удаляет ФАЙЛЫ на диске для строк вне incoming-набора
    }
  }
  ```
  Это **file-level** удаление по снапшоту `existingMedia`. Отдельно `syncPostsAndMedia` (posts.ts ~строка 179+) делает собственный **row-level** media upsert/delete внутри DB транзакции через `existingByNatural`. То есть два независимых delete-пути (дисковые файлы vs DB-строки), которые могут расходиться при конкурентности.
- **Как два пересекающихся вызова `processPosts` портят/перекачивают одни и те же файлы:** в V2 `getFullThreadsV2` использует `parallelForEach(threadsToFetch, fetchEntitiesMaxParallelJobs, ...)` для конкурентного вызова `processPosts([thread], db)` по многим тредам (дефолт 10 параллельно). Если два вызова затрагивают пересекающиеся посты/треды (напр. один и тот же тред через разные пути, или периодический full sync, пересекающийся с on-demand partial), то:
  - Оба читают `existingMedia` в чуть разное время; один может решить, что файл «не в incoming», и вызвать `deleteFilesForMedia`, пока другой в середине загрузки → **частичный/повреждённый файл** или только что записанный файл удаляется.
  - `resolveLocalPath` проверяет `fileExists(existingPath)` перед загрузкой; если A его удалил, B перекачивает, хотя A собирался его записать → **дублирующиеся/конкурентные загрузки** одной и той же путли через `pipeline(...createWriteStream(absolutePath))` (без lock) → переплетённые/повреждённые записи.
- **Sync lock защищает только entry points.** `src/cluster/syncLock.ts` (`createSyncLock`, строки 3–14) — promise-chain mutex, сериализующий то, что через него пропущено. Подключён в `cluster.ts` строка 108 и применяется к (a) full sync через `runSyncLoop(..., withSyncLock)` (строка 122) и (b) force_sync partials через `ipc.ts` строка 112 (`void withSyncLock(async () => { ... updatePartial(...) })`). **Он НЕ сериализует внутренние конкурентные вызовы `processPosts` внутри одного `updateAll`** — они выполняются в одной запертой области, но конкурентно между собой. Хуже: в **monolith-режиме** (`app/roles.ts` `runMonolith`, ~строка 123) `runSyncLoop(flags, syncService)` вызывается **без** lock, а API force_sync route вызывает `syncService.updatePartial(threadId)` напрямую (api/routes/util.ts строка 25) без lock — значит периодический full sync и on-demand partial могут выполняться полностью конкурентно в monolith.

**План действий:**
1. Сериализовать media/DB записи per thread: ввести тонкозернистый lock по `threadId` (или `postId`) вокруг пары `syncLocalMedia` + `syncPostsAndMedia`, чтобы пересекающиеся вызовы одного треда выстраивались в очередь даже внутри одного `updateAll`. Простой in-process map `threadId → tail promise` (та же форма, что `createSyncLock`) достаточен.
2. Сделать файловые записи атомарными: качать во временное имя и затем rename на место (`fs.rename`); защитить «in-flight» множеством, чтобы два воркера никогда не писали один путь конкурентно; `resolveLocalPath` должен ждать in-flight promise вместо повторной загрузки.
3. Согласовать два delete-пути: решить, что удаление файлов ведётся от DB строк (единый источник истины), а не отдельным снапшот-циклом, чтобы избежать disk/DB расхождения при конкурентности.
4. Применять entry lock консистентно и в monolith (передать `withSyncLock` в `runSyncLoop` и обернуть API-triggered `updatePartial`), либо задокументировать, что monolith намеренно допускает перекрытие, — и тогда всё равно исправить внутренний race.

**Критерий закрытия:**
- [ ] Конкурентный тест: два пересекающихся вызова `processPosts` одного треда (mocked source/db) → ни один файл не удаляется во время записи другим, нет double-download in-flight пути, итоговое состояние БД/файлов консистентно.
- [ ] В коде видна per-thread (или per-post) сериализация вокруг пары media+DB запись; monolith force_sync и full sync не могут переплестись на одном треде.

---

### 2.2.B `processBoards.updated` — мёртвый счётчик (`sync/processors/processBoards.ts`)

**Находка.**
- `let updated = 0;` объявлен на **строке 7**.
- Цикл ~строки 12–24: когда доска существует, вызывается `await db.boards.update(board)` (~строка 16), но **`updated` никогда не инкрементируется**; только else-ветка делает `created += 1` (~строка 23).
- Лог ~строка 29: `` `"boards" table updated, checked=${checked}, updated=${updated}, created=${created}..." `` → **всегда логирует `updated=0`**, независимо от того, сколько досок реально обновлено.

**План действий:**
1. Инкрементировать счётчик на update-пути: после `await db.boards.update(board)` добавить `updated += 1;`. (Опционально отдельно посчитать privacy-strip ветку.)
2. При желании точности сверять с реальными исходами БД (см. подход из 2.2.C), но как минимум сделать залогированное число отражающим фактические обновления.

**Критерий закрытия:**
- [ ] Тест со смесью новых + существующих досок: `updated` равен числу обработанных существующих, `created` — числу вставленных; debug-лог показывает ненулевой `updated`, когда обновления были.

---

### 2.2.C Счётчики `processPosts` — оценки (`sync/processors/processPosts.ts`)

**Находка.**
- ~Строки 97–99:
  ```ts
  const existingIds = await db.posts.getExistingIds(uniquePosts.map((post) => post.id)); // ~строка 97
  updated = uniquePosts.filter((post) => existingIds.has(post.id)).length;              // ~строка 98
  created = uniquePosts.length - updated;                                               // ~строка 99
  ```
- Считаются **до** фактической записи (`db.posts.syncPostsAndMedia(...)` на ~строке 113), которая является `INSERT ... OR UPDATE` upsert (posts.ts ~строки 179+). Поэтому:
  - Пост, существующий но с изменённым контентом, считается «updated», даже если ничего реально не изменилось; совершенно новый пост считается «created» до его вставки.
  - Числа отражают **pre-write состояние БД**, а не реальные исходы (записанные строки, реально изменённые строки, конфликты). Это оценки только для лога и могут вводить операторов в заблуждение об эффективности sync.

**План действий:**
1. Выводить счётчики из результата upsert где возможно: `syncPostsAndMedia` возвращает `{ inserted, updated }` (TypeORM `execute()` даёт affected row counts; либо вычислить сравнением before/after) и логировать их вместо pre-computed оценок.
2. Если точные per-row семантики недостижимы — как минимум переименовать поля лога, чтобы было ясно, что это pre-write оценки (напр. `expected_created` / `expected_updated`).

**Критерий закрытия:**
- [ ] Залогированные created/updated берутся из реальных результатов записи БД (либо явно помечены как оценки). Тест со смесью новых + изменённых + неизмененных постов показывает, что счётчики совпадают с фактически записанным/изменённым.

---

## 2.3 Maintainability

### 2.3.A Дублирование `getFullThreads` vs `getFullThreadsV2` (`sync/getFullThreads.ts`)

**Находка.**
- `getFullThreads` (V1): **~строки 51–84**.
- `getFullThreadsV2`: **~строки 97–140**.
- Общая/пересекающаяся логика (дословно или почти дословно в обоих):
  - `logger.info("Fetch boards list...")` + `source.getBoardsList()` + debug.
  - `const boardTags = boards.map((board) => board.tag);`
  - Весь пайплайн «boards → index»: `parallelExecutor<ResponsePost[], string>(boardTags, fetchEntitiesMaxParallelJobs, (tag) => () => { ... return fetchBoardThreadIndex(source, tag[, db]); })` с последующим `.flatMap(...)`.
- Различия: V1 передаёт **не** `db` в `fetchBoardThreadIndex` (нет early-stop), затем делает второй `parallelExecutor`, собирающий все полные треды в гигантский массив и возвращающий `{ fullThreads, boards }`. V2 передаёт `db`, вызывает `handlers.onBoards(boards)`, применяет per-thread skip фильтр и стримит через `parallelForEach(... handlers.onFullThread(full))`.
- **Оценка дублирования:** весь boards→index пайплайн (~15 строк) продублирован дословно; относительно тела V1 на ~30 строк это примерно **40–50% line-level дублирования**, перенесённого в V2.

**План действий:**
1. Вынести общий хелпер `fetchBoardsAndIndex(source, db?)`, возвращающий `{ boards, shortThreads }`; обе публичные функции вызывают его и расходятся только на шаге персистентности (array collect vs streaming handlers).
2. Поскольку V1 используется **только для первого sync** (см. 2.3.B), рассмотреть полное удаление V1 и сделать initial sync через V2 с `db` undefined (что уже отключает early-stop) — устраняет дублированный пайплайн и тяжёлый in-memory array путь.

**Критерий закрытия:**
- [ ] Единый общий хелпер используется обоими entry points; дублированного blocks boards→index не осталось. Если V1 удалён — тест подтверждает, что initial sync всё ещё качает все треды (без early-stop) через оставшийся путь.

---

### 2.3.B `isFirstFullSync` — per-process state (`sync/createSyncService.ts` + `app/roles.ts`)

**Находка.**
- Флаг: **строка 14** `let isFirstFullSync = true;` внутри `createSyncService` — это **closure state, один на инстанс**.
- Ставится в false на **строке 18**, только при первом вызове `updateAll()`.
- `app/roles.ts` `runMonolith` создаёт **два отдельных инстанса**, когда включён API server:
  - ~строка 107: `const syncService = isP2pReplica() ? undefined : await createSyncService(pissykakaApi);` (для API server)
  - ~строка 122: `const syncService = await createSyncService(pissykakaApi);` (для sync loop)
  У каждого свой `isFirstFullSync = true`. Инстанс API-server'а никогда не вызывает `updateAll` (API только вызывает `updatePartial` для force_sync), поэтому его флаг инертен, но всё равно аллоцирован.
- **Последствие при рестарте primary:** флаг живёт в памяти, поэтому каждый старт процесса сбрасывает его в `true`, и первый sync после любого рестарта повторно идёт тяжёлым non-streaming V1 путём (`getFullThreads`: качает **все** полные треды в гигантский массив, без early-stop эвристик), а не лёгким streaming V2. Дорогая initial-sync стоимость оплачивается при каждом рестарте, хотя БД уже заполнена.

**План действий:**
1. Персистировать «выполнен хотя бы один full sync» в надёжном хранилище (напр. строка `settings`/meta или flag-файл) и читать при старте, чтобы рестарты сразу шли в V2 streaming.
2. Альтернативно — убрать V1 путь целиком (см. 2.3.A), чтобы не было тяжёлой initial ветки для повторного срабатывания; сделать first sync = V2 с эвристиками, отключёнными только когда БД пуста.
3. Не создавать два инстанса в monolith: один `syncService`, общий для API server и sync loop.

**Критерий закрытия:**
- [ ] После рестарта с уже заполненной БД первый sync идёт streaming V2 путём (лог показывает "Full sync (streaming via getFullThreadsV2)..." вместо "...initial via getFullThreads...").
- [ ] `runMonolith` создаёт ровно один инстанс `createSyncService`, общий для API + loop.

---

### 2.3.C `rest.ts` — хрупкий параметр `/v2/board?exclude_tags[]=`

**Находка.**
- В `getBoardsList` query string вшит в URL literal: ~строка 18 `request.get<ApiTemplate<ResponseBoardsList>>("/v2/board?exclude_tags[]=", { params: { limit } })`. (В плане указан как «rest.ts:20»; это вызов `getBoardsList`.)
- Почему хрупко/неясно:
  - Query параметр (`exclude_tags[]=`) вшит в **path string** вместо использования axios `params`, смешивая два механизма и легко допускающий опечатку/пропуск.
  - Пустой array-параметр `exclude_tags[]=` имеет неоднозначную семантику («нет значения» = «исключить все теги»?), без комментария, объясняющего намерение.
  - Несогласованно с другими методами, которые передают всё через `params`.

**План действий:**
1. Перенести в params-объект: `request.get("/v2/board", { params: { limit, exclude_tags: [] } })` (или то, что ожидает upstream), убрав inline query string.
2. Добавить короткий комментарий, документирующий назначение `exclude_tags[]`, и подтвердить точную ожидаемую форму по API-контракту.

**Критерий закрытия:**
- [ ] Ни один метод не вшивает сырой `?query=` в URL path; все query параметры передаются через axios `params`; намерение `exclude_tags` задокументировано/подтверждено по upstream API.

---

## 2.4 Тесты

**Находка.**
- **Под `src/sync/` и `src/sources/` — ноль тест-файлов.** Поиск по workspace `packages/backend/src/**/*.test.*` возвращает только: `media/{paths,storage,download,syncLocalMedia}.test.ts`, `p2p/{journal.apply,protocol}.test.ts`. Sync и sources не покрыты.
- Функции, требующие тестов, с минимальным осмысленным утверждением:

| Функция (файл) | Минимальный тест должен утверждать |
|---|---|
| `createSyncService` (`sync/createSyncService.ts`) | Первый `updateAll` идёт V1 путём и переключает флаг; второй — V2. `updatePartial` отклоняет невалидный `threadId` (≤0 / non-finite). |
| `getFullThreads` (`sync/getFullThreads.ts`) | Возвращает `{ fullThreads, boards }`; flatMap index→full корректен с mocked source. |
| `getFullThreadsV2` (`sync/getFullThreads.ts`) | Вызывает `onBoards` один раз; пропускает (не вызывает `onFullThread` для) тредов, чей DB `updated_at` совпадает; вызывает для изменённых/новых. |
| `fetchBoardThreadIndex` (внутренняя, через вышеуказанные) | Early-stop срабатывает только когда вся страница совпадает с DB `updated_at`; соблюдает cap `BOARD_INDEX_MAX_PAGES` и логирует truncation. |
| `processBoards` (`sync/processors/processBoards.ts`) | `created` считает вставки; `updated` отражает фактические обновления (сейчас всегда 0 — тест выявляет баг); privacy-strip срабатывает при public→private переходе. |
| `processPosts` (`sync/processors/processPosts.ts`) | Дедупликация: пост, появляющийся в нескольких тредах, обрабатывается один раз с правильным `threadId`; media items собираются per type; private доски ставят `skipDownload`. Счётчики отражают реальные исходы (либо помечены как оценки). |
| `createRestSource` (`sources/rest.ts`) | `getBoardsList` мапит `payload.boards`; `getThreadsList` возвращает `[]` для ignored tags и мапит `payload.posts`; `getThreadPostsList` мапит `payload.thread_data`. Поведение timeout/retry (см. 2.1.B). |

**План действий:**
1. Добавить тест-харнес с mocked `SyncSource` и mock/in-memory `DbConnection` (репозиторий уже использует `.test.ts` файлы под `media/` — следовать тому паттерну).
2. Написать перечисленные тесты, приоритет: дедупликация (`processPosts`), V2 skip filtering, pagination early-stop + cap, source mapping (`createRestSource`). Добавить конкурентный тест media race (2.2.A) и counter-тесты `processBoards`/`processPosts`.

**Критерий закрытия:**
- [ ] Под `src/sync/` и `src/sources/` существует хотя бы по одному `.test.ts`; suite покрывает: дедупликацию, V2 skip filtering, pagination early-stop + cap truncation, source response mapping, а также (для 2.2) board/post счётчики и media race — все проходят.

---

## Рекомендуемый порядок внутри шага

1. **2.1.A** (silent drop в исполнителях) + **2.1.B** (timeout/retry в rest.ts) — сначала сделать сбои наблюдаемыми и безопасными; остальное строится на этом.
2. **2.2.A** (media race + entry-only lock) — риск повреждения файлов при конкурентных `processPosts`, которые V2 `parallelForEach` сознательно создаёт.
3. **2.1.D** (early-stop предположение) — потенциальная тихая потеря данных; проверить семантику upstream и зафиксировать/ограничить эвристику.
4. **2.1.C** (cap truncation warning), **2.2.B/C** (счётчики) — наблюдаемость/корректность логов.
5. **2.3.A/B/C** (дублирование, per-process флаг, хрупкий параметр) — maintainability.
6. **2.4** (тесты) — опирается на 2.1–2.3.

> Композиция рисков: silent drop (2.1.A) → упавший тред молча отсутствует; нет timeout/retry (2.1.B) → такие сбои вероятны и могут повесить весь цикл; early-stop предположение (2.1.D) может пропустить изменившиеся треды; media race + entry-only lock (2.2.A) → риск повреждения файлов. Исправление 2.1.A/B первым делает остальное наблюдаемым и безопасным для усиления.
