# Step 3 — DB layer (целостность, производительность)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода с file:line) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 3. Модуль: `packages/backend/src/db/`.

---

## 3.1 Атомарность / транзакции

### Находка

**Ключевой архитектурный факт:** journal-хелперы в `chat.ts` (`journalUpsert`, `journalDelete`) вызывают `logChanges(...)`, а затем `getP2pHub()?.broadcast/enqueueOutbox`. Критично: когда вызваны **без** `manager`, `logChanges` открывает **собственную транзакцию** только вокруг вставки в `SyncChangeLog`:

- `packages/backend/src/p2p/journal.ts:56-79` — `logChanges(dataSource, inputs, opts?)`:
  ```ts
  if (manager) { for (...) pointers.push(await insertLog(manager, input)); }
  else { await dataSource.transaction(async (tx) => { for (...) pointers.push(await insertLog(tx, input)); }); }
  ```
То есть каждый вызов `journalUpsert` в chat/boards репозиториях — это **отдельный commit**, отличный от предшествующего entity save. Они никогда не оборачиваются вместе.

**chat.ts — каждая мутация: (1) `repo.save(...)` [своя имплицитная tx], затем (2) `await journalUpsert(...)` [своя tx]. Две отдельные операции.** Доказательства по 3+ методам:

- **`ensureState`** — `chat.ts:302-321`:
  ```ts
  let state = await repo.findOne({ where: { profileId, threadId } });   // L302
  if (!state) { ... state = await repo.save(repo.create({...}));        // save (своя tx)
    await journalUpsert(dataSource, "ProfileThreadState", state.syncId, ts);  // L321 (отдельная tx)
  }
  ```
- **`markThreadRead`** — `chat.ts:327-348`: `repo.findOne` (L327) → `const saved = await repo.save(state)` (~L347, своя tx) → `await journalUpsert(...)` (L348, отдельная tx).
- **`setHidden`** — `chat.ts:394-416`: `repo.save(state)` затем `journalUpsert` на **L416**.
- **`setAlias`** — `chat.ts:421-443`: save затем `journalUpsert` на **L443**.
- **`assignThreadFolder`** — `chat.ts:502-524`: save затем `journalUpsert` на **L524**.
- **`deleteFolder`** — `chat.ts:~480-500`: bulk `update({profileId, folderId}, {folderId:null})`, затем **per-state цикл** с вызовом `journalUpsert` (L494), затем `folderRepo.delete(...)` + `journalDelete(...)`. Это 3+ независимые операции без общей транзакции.
- **`createFolder` / `renameFolder` / `addOwnPost`**: тот же split save→journalUpsert.

**boards.ts — insert/update: три неатомарных шага (save → logChanges → broadcast):**
- **`insert`** — `boards.ts:10-34`:
  ```ts
  const saved = await boardRepository.save(newBoard);          // шаг 1 (своя tx)
  const pointers = await logChanges(dataSource, [{ table:"Board", ... }]);  // шаг 2 (своя tx)
  getP2pHub()?.broadcast(pointers);                            // шаг 3 (in-memory/network)
  ```
- **`update`** — `boards.ts:36-58`: `boardRepository.update(...)` → `logChanges(...)` → `getP2pHub()?.broadcast(...)`. Тот же трёхшаговый неатомарный паттерн.

**Несогласованность, которую оставляет крах:** поскольку запись сущности и запись журнала коммитятся независимо, краш между ними даёт одно из двух расходящихся состояний:
1. **DB-строка изменена, но журнал не обновлён** (краш после `repo.save`, до commit'а `logChanges`): новое значение записи персистировано локально, но change pointer в `SyncChangeLog` нет. Пиров никогда не узнают → тихая потеря репликации; также `getCurrentRevision()`/outbox это не отразят.
2. **Журнал обновлён, но DB-строка не изменена** (краш после commit'а `logChanges`, до/без entity save — возможно при обратном порядке или повторном log): change pointer ссылается на запись, чьё локальное значение никогда не продвинулось → пиры тянут stale/nonexistent ревизию.

Для `deleteFolder` окно хуже: states сначала bulk-updated, затем N отдельных journal upsert'ов в цикле; краш посреди цикла оставляет часть states журналированными, а другую нет, плюс folder delete мог и не произойти — единой rollback-границы нет.

### План действий
1. Ввести shared-transaction wrapper для каждой chat/boards мутации: `await dataSource.transaction(async (manager) => { ...save через manager...; await logChanges(manager-or-dataSource-with-manager, inputs, { manager }); })`. Заметьте: `logChanges` уже принимает `{ manager }` и пропускает собственную транзакцию при его наличии (`journal.ts:63-71`) — значит фикс в том, чтобы передавать ambient `manager` в новый хелпер `journalUpsertInTx(manager, ...)` вместо текущего `dataSource`-based.
2. Рефакторить хелперы `chat.ts`: заменить `journalUpsert(dataSource, ...)` / `journalDelete(...)` на transaction-aware варианты; обернуть тело каждой мутации (`ensureState`, `markThreadRead`, `setHidden`, `setAlias`, `assignThreadFolder`, `createFolder`, `renameFolder`, `deleteFolder`, `addOwnPost`) в одну `dataSource.transaction`.
3. Для `deleteFolder`: bulk state update + folder delete + все journal entries — в одной транзакции (батчить N journal inputs в один вызов `logChanges(manager, [...])` вместо цикла из N итераций).
4. Рефакторить `boards.ts insert/update`: обернуть save/update + `logChanges({ manager })` в одну транзакцию; оставить `broadcast` **после** commit (он идемпотентен/outbox-backed), чтобы post-commit краш рисковал только пропущенным broadcast, а не расхождением данных.
5. Определить ordering-контракт: запись сущности и запись журнала — в одной tx; broadcast/enqueueOutbox строго после commit.

### Критерий закрытия
- [ ] Каждый state-mutating метод в `chat.ts` и оба `insert`/`update` в `boards.ts` выполняют мутацию сущности и её запись в `SyncChangeLog` внутри одной `dataSource.transaction(...)` (проверяется инспекцией кода: одна транзакционная граница на мутацию; нет top-level `repo.save`, за которым следует независимый `logChanges`).
- [ ] Crash-injection тест (kill между save и commit) оставляет либо и строку, и journal pointer, либо ни того, ни другого — никогда только одно.

---

## 3.2 Производительность (N+1)

### Находка

**chat.ts `markAllReadByBoard`** — `chat.ts:351-390`:
```ts
const threads = await ... .where("thread.parentId IS NULL").andWhere("thread.boardId = :boardId")...getMany();  // L~356 (1 query)
for (const thread of threads) {                                   // L360 — цикл по N тредам
  const lastReply = await dataSource.getRepository(Post).createQueryBuilder("post")   // L361-366: отдельный "last reply" query на тред
    .where("(post.parentId = :threadId OR post.id = :threadId)", { threadId: thread.id })
    .orderBy("post.id", "DESC").getOne();
  let state = await repo.findOne({ where: { profileId, threadId: thread.id } });   // L368: отдельная state load на тред
  ... const saved = await repo.save(state);                                        // save на тред
  await journalUpsert(dataSource, "ProfileThreadState", saved.syncId, ts);         // L389: отдельная tx на тред
}
```
**Round-trips для доски с N тредами:** 1 (список тредов) + N × [lastReply query + state `findOne` + `save` + `logChanges`(своя tx)] = **1 + 4N round trips**, и каждая итерация открывает собственную транзакцию. Худший offender в DB-слое.

**apis.ts — per-thread reply-loading цикл (две копии):**
- `threads.getByBoardTag` — `apis.ts:69-80`:
  ```ts
  for (const thread of threads) {                       // L69
    const replies = await postRepository.createQueryBuilder("reply")   // L70-77: один query на тред
      .leftJoinAndSelect("reply.media","media").leftJoinAndSelect("reply.board","board")
      .where("reply.parentId = :threadId", { threadId: thread.id })
      .orderBy("reply.id","DESC").take(threadSize).getMany();
    thread.replies = replies.reverse();                 // L79
  }
  ```
- `feed.getAll` — `apis.ts:138-149`: идентичный цикл (L138, reply query L139-146, reverse L148).

**N+1:** каждый возвращает `limit` тредов и затем выпускает **дополнительный query на каждый тред** → 1 + N запросов. При дефолтном page size это полный fan-out при каждом board view и каждой feed-странице. (Замечание: `getById`/`threadWithReplies` используют единый join query — они в порядке; только list-endpoints циклят.)

**media.ts — per-row update/delete циклы:**
- `stripLocalFilesForBoard` — `media.ts:39-43`:
  ```ts
  for (const row of rows) {
    if (!row.localPath && !row.localPreviewPath) continue;
    await deleteFilesForMedia(row);                                                    // L41: per-row FS + query
    await mediaRepo.update({ id: row.id }, { localPath: null, localPreviewPath: null });  // L42: один UPDATE на строку
  }
  ```
- `replaceForPosts` — `media.ts:108-163`: после загрузки `existing`, два цикла:
  - delete цикл `media.ts:115-119`: `await deleteFilesForMedia(row); await ...delete({ id: row.id });` (L116-117) — один DELETE на удалённую строку.
  - upsert цикл `media.ts:123-160`: для каждого item либо single-row `update` (L135-149), либо single-row `save`/insert (L150-160). Одно statement на media item.

**N+1:** оба масштабируются линейно с числом строк, используя индивидуальные statements вместо batched `IN (...)` / multi-row upsert'ов. (`posts.ts syncPostsAndMedia` и `upsertMany` уже используют chunked bulk writes — контраст показывает задуманный паттерн.)

### План действий
1. **markAllReadByBoard:** заменить per-thread last-reply query на один aggregate query (переиспользовать существующий `lastReplyPreviewByThreadIds`-style `MAX(p.id) ... GROUP BY COALESCE(parentId,id)` из `chat.ts:246-290`), чтобы получить все last-reply id за один round trip; затем load-or-create states в bulk (`find({ where: { profileId, threadId: In(threadIds) } })`), применить обновления и написать **один** batched `logChanges(manager, [...])` внутри одной транзакции. Цель: 3–4 запроса всего независимо от N.
2. **apis.ts getByBoardTag / feed.getAll:** схлопнуть reply-цикл в один query с window functions (`ROW_NUMBER() OVER (PARTITION BY parentId ORDER BY id DESC)`) или двухшагово — получить thread ids, затем `find({ where: { parentId: In(threadIds) } })` и слайсить per-thread в JS до `threadSize`. Цель: 2 запроса всего.
3. **media.ts stripLocalFilesForBoard:** собрать затронутые media ids и выпустить один bulk `update(..., { id: In(ids) }, {...})`; оставить FS delete цикл (неизбежный I/O), но отделить его от per-row SQL.
4. **media.ts replaceForPosts:** батчить deletes (`delete({ id: In(toDeleteIds) })`), батчить updates группировкой unchanged-vs-changed и chunked `orUpdate` upsert'ами как в `posts.ts upsertMany`, вместо per-item statements.

### Критерий закрытия
- [ ] `markAllReadByBoard` выпускает константное число запросов (≤ 4) независимо от числа тредов; проверяется логированием/EXPLAIN или тестом, утверждающим, что query count при N=50 тредах равен случаю N=1.
- [ ] `getByBoardTag` и `feed.getAll` выпускают ровно 2 запроса независимо от page size.
- [ ] `stripLocalFilesForBoard` / `replaceForPosts` используют batched `IN (...)` statements; число statement'ов O(1) на чанк, а не O(rows).

---

## 3.3 Индексы / схема

### Находка — все @Index/@Unique декораторы по сущностям

| Сущность | Декораторы (из entity-файла) |
|---|---|
| `Board.ts` | **нет** в сущности. (`UQ_Board_tag` unique + `IDX_Board_tag` создаются только миграциями 001/004.) |
| `Post.ts` | **нет** в сущности. (`IDX_Post_parentId`, `IDX_Post_parentId_id`, partial `IDX_Post_boardId_updatedAt_threads` — миграция 004.) |
| `Media.ts:6` | `@Index("UQ_Media_syncId", ["syncId"], { unique: true })`. **Нет индекса на `postId`.** |
| `ChatProfile.ts:6,15,18` | `@Index("UQ_ChatProfile_syncId",["syncId"],{unique:true})`; колонка `token` `unique:true`; колонка `passphraseHash` `unique:true`. |
| `ChatFolder.ts:6` | `@Index("UQ_ChatFolder_syncId",["syncId"],{unique:true})`. (`IDX_ChatFolder_profile_board` — миграция 002.) |
| `ProfileThreadState.ts:8,9` | `@Unique("UQ_ProfileThreadState_profile_thread", ["profileId","threadId"])`; `@Index("UQ_ProfileThreadState_syncId",["syncId"],{unique:true})`. |
| `ProfileOwnPost.ts:7,8` | `@Unique("UQ_ProfileOwnPost_profile_post", ["profileId","postId"])`; `@Index("UQ_ProfileOwnPost_syncId",["syncId"],{unique:true})`. |
| `Settings.ts` | **нет.** Нет unique constraint на `name`, нет индекса. |
| `SyncChangeLog.ts:5,6` | `@Index("IDX_SyncChangeLog_createdAt",["createdAt"])`; `@Index("IDX_SyncChangeLog_table_key",["tableName","recordKey"])`. |

**Подтверждение отсутствующих индексов по паттернам запросов:**

1. **Media.postId — НЕТ индекса.** Запрашивается в:
   - `media.ts getByPostId` (`find({ where: { postId } })`, L~92) и `getByPostIds` (chunked `postId: In(chunk)`),
   - `replaceForPosts` existing-load (`postId: In(postIds)`, L109-111),
   - `posts.ts syncPostsAndMedia` (`manager.getRepository(Media).find({ where: { postId: In(postIds) } })`),
   - `deleteByPostId` / `dropByPostId` (`{ postId }`).
   Каждый из них — full table scan по `Media`.

2. **Post.boardId для non-thread lookups — покрыто лишь частично.** Миграция 004 создаёт partial index:
   ```sql
   CREATE INDEX "IDX_Post_boardId_updatedAt_threads" ON "Post" ("boardId","updatedAt" DESC) WHERE "parentId" IS NULL;
   ```
   Он покрывает **thread** listings (`parentId IS NULL`). Но `stripLocalFilesForBoard` выполняет `.where("post.boardId = :boardId")` по **всем** постам доски (треды *и* реплии, `media.ts:24-30`) — это не обслуживается partial index и full-scans.

3. **ProfileThreadState(profileId, threadId) — ИНДЕКСИРОВАНО.** Покрыто composite unique `UQ_ProfileThreadState_profile_thread` с ведущим `profileId`, затем `threadId`. Все repository-запросы фильтруют по обоим (`{ profileId, threadId }` / `{ profileId, threadId: In(...) }`) и используют его. (Оговорка только: запрос, фильтрующий по одному `threadId`, не использовал бы — таких сейчас нет.)

4. **Settings.name — НЕТ unique constraint и индекса.** Подтверждено в `Settings.ts`. `settings.ts get/getOptional/upsert/set` все делают `findOne({ where: { name } })` → full scan, а `upsert` (L~52-60) — read-then-write **без enforcement уникальности** → конкурентные upsert'ы могут создать дубликаты строк.

### План действий
1. Добавить индекс на `Media.postId`:
   ```sql
   CREATE INDEX "IDX_Media_postId" ON "Media" ("postId");
   ```
2. Добавить общий board lookup index для non-thread постов (реплий):
   ```sql
   CREATE INDEX "IDX_Post_boardId" ON "Post" ("boardId");
   ```
   (Существующий partial thread index сохранить; этот обслуживает `stripLocalFilesForBoard` и любой reply-by-board scan.)
3. `ProfileThreadState(profileId,threadId)` — менять не нужно (уже покрыто). Опционально добавить ведущий-`threadId` индекс только если будущий запрос будет фильтровать по одному thread.
4. Добавить unique constraint + индекс на `Settings.name`:
   ```sql
   CREATE UNIQUE INDEX "UQ_Settings_name" ON "Settings" ("name");
   ```
   и конвертировать `settings.ts upsert` в атомарный `INSERT ... ON CONFLICT(name) DO UPDATE`.

Все четыре — новой **миграцией** (напр. `1700000000009-DbIndexes.ts`) через `queryRunner.createIndex`, с соответствующим `down()`.

### Критерий закрытия
- [ ] `EXPLAIN QUERY PLAN` для `SELECT ... FROM Media WHERE postId = ?` показывает использование `IDX_Media_postId` (не full scan).
- [ ] `EXPLAIN QUERY PLAN` для board-wide post query в `stripLocalFilesForBoard` использует `IDX_Post_boardId`.
- [ ] Вставка двух строк с одинаковым `Settings.name` вызывает unique-constraint ошибку.
- [ ] Новая миграция существует, idempotent-safe (`IF NOT EXISTS`) и имеет рабочий `down()`.

---

## 3.4 Миграции

### Находка

**001 — `KafkaFilePassportBoardPost` (`1700000000001-...ts`)**
- Пересоздаёт таблицу Post (SQLite workaround для nullable-колонки):
  ```ts
  await queryRunner.query("PRAGMA foreign_keys=OFF");                       // L~46
  await queryRunner.query(`CREATE TABLE "Post_new" (... "boardId" bigint, ...)`);   // L~47-58
  await queryRunner.query(`INSERT INTO Post_new (...) SELECT ... FROM Post`);        // L~59-61
  await queryRunner.query("DROP TABLE Post");                                  // L~62
  await queryRunner.query("ALTER TABLE Post_new RENAME TO Post");              // L~63
  ```
  Полная пересборка таблицы: дроп и recreate `Post`, повторное добавление FK, временное отключение foreign keys. На большой таблице Post это долгая write-lock / data-copy операция с реальным риском потери данных при прерывании посреди `INSERT…SELECT`.
- **`down()` НЕ восстанавливает `boardId NOT NULL`** — явный комментарий в конце:
  ```ts
  // Revert Post.boardId to NOT NULL would require table recreate - skip
  ```
  Миграция **необратима** относительно nullability этой колонки.
- **Orphaned schema:** `up()` создаёт две таблицы, на которые не ссылается ни одна сущность:
  ```ts
  await queryRunner.createTable(new Table({ name: "File", columns:[{name:"id"...},{name:"cid"...}] }), true);   // L~19-30
  await queryRunner.createTable(new Table({ name: "Passport", columns:[{name:"id"...}] }), true);               // L~32-38
  ```
  Подтверждено grep'ом: **нет `@Entity("File")` и нет `@Entity("Passport")`** нигде в `packages/backend/src/db/entities/`. Это мёртвые таблицы (`down()` их дропает, но они живут всю жизнь любой БД, где был выполнен `up`).

**007 — `P2pReplication` (`1700000000007-...ts`)**
- Row-by-row backfill:
  ```ts
  const backfillSyncIds = async (queryRunner, table) => {                    // L~24
    const rows = await queryRunner.query(`SELECT id FROM "${table}"`);       // L~25
    for (const row of rows) {                                                // L~26
      await queryRunner.query(`UPDATE "${table}" SET "syncId" = ? WHERE id = ?`, [randomUUID(), row.id]);  // L~27 — один UPDATE на строку
    }
  };
  ```
  Вызывается для `Media` (L~85) и каждой из `ChatProfile, ChatFolder, ProfileThreadState, ProfileOwnPost` (цикл L~91-93). Каждый вызов — O(rows) индивидуальных `UPDATE ... WHERE id = ?` statement'ов → на больших таблицах это держит write path очень долго (N round trips + N commits), серьёзный lock-contention / availability риск при деплое.

**Другие рискованные миграции:**
- **001** — основной data-loss/lock риск (пересборка таблицы с отключёнными FK).
- **007** — основной lock-contention риск (row-by-row backfill).
- Остальные (002, 003, 004, 005, 006, 008) — аддитивные `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX`, низкий риск; их `down()` чисто дропят добавленные объекты.

### План действий
1. **Backfill в 007:** заменить per-row цикл на единый set-based statement:
   ```sql
   UPDATE "Media" SET "syncId" = lower(hex(randomblob(16))) WHERE "syncId" IS NULL;
   ```
   (Это уже делается follow-up строкой для Media на L~87 и для chat-таблиц на L~95 — значит row-loop в `backfillSyncIds` избыточен и может быть удалён целиком, оставив только единый bulk `UPDATE ... WHERE syncId IS NULL`.) Если per-row UUID действительно нужны — батчить чанками по 500 одним multi-row statement'ом вместо one-per-row.
2. **Orphaned таблицы в 001:** добавить follow-up миграцию, дропящую `File` и `Passport` (нет ни сущностей, ни читателей), либо задокументировать как намеренно зарезервированные. Дроп — чистый фикс.
3. **Необратимость 001:** принять и задокументировать, что `down()` не может восстановить `boardId NOT NULL`; если обратимость важна — реализовать guarded table-recreate в `down()` за явным флагом; иначе оставить явный комментарий (уже есть) и пометить миграцию non-downgradable в runbook.
4. Добавить deploy-примечание: 001 и 007 должны выполняться в maintenance window / с write-drain на больших БД.

### Критерий закрытия
- [ ] `backfillSyncIds` больше не выпускает один `UPDATE` на строку; syncId backfill — единый (или chunked) set-based statement — проверяется чтением миграции и/или подсчётом statement'ов в тестовой БД.
- [ ] Новая миграция дропает orphaned `File`/`Passport` таблицы, либо они явно задокументированы как зарезервированные; `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('File','Passport')` возвращает пусто после миграции на свежих БД.
- [ ] Migration runbook документирует 001 (необратимая boardId nullability) и lock-окно для 001/007.

---

## 3.5 Прочее

### Находка

**chat.ts `hashPassphrase` — hardcoded default salt:**
```ts
// packages/backend/src/db/repositories/chat.ts:17-20
const hashPassphrase = (passphrase: string) => {
  const salt = process.env.CHAT_PASSPHRASE_SALT ?? "umechan-chat";   // L18 — hardcoded fallback
  return scryptSync(passphrase.trim(), salt, 64).toString("hex");    // L19
};
```
Используется в `identify` на `chat.ts:66`. **Weak-KDF concern:** единый общий salt для всех пользователей (literal `"umechan-chat"`, когда env var не задан) означает, что одинаковые passphrase у разных пользователей дают одинаковые хэши — это позволяет precomputed/rainbow-table атаки на всю пользовательскую базу и cross-user корреляцию. Нет per-user/per-record salt, хранящегося рядом с хэшем (`ChatProfile` имеет только `passphraseHash`, без salt-колонки).

**Дублирование — блок "load-or-create ProfileThreadState" в chat.ts:**
Идентичный load-or-create паттерн встречается в **5 state-mutation методах** плюс inline-копия:
- `ensureState` — `chat.ts:302` (create branch ~L304-319)
- `markThreadRead` — `chat.ts:327` (create branch ~L330-345)
- `setHidden` — `chat.ts:394` (create branch ~L397-411)
- `setAlias` — `chat.ts:421` (create branch ~L424-438)
- `assignThreadFolder` — `chat.ts:502` (create branch ~L505-519)
- inline-вариант внутри цикла `markAllReadByBoard` — `chat.ts:368`

Итого **6 вхождений** одного и того же блока на ~15 строк.

**`chunkArray` продублирован в media.ts и posts.ts (и третья копия в boardPrivacy):**
```ts
// packages/backend/src/db/repositories/media.ts:12-19  (SQL_IN_CHUNK_SIZE = 500 at L10)
const chunkArray = <T>(items: T[], chunkSize: number): T[][] => {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) { chunks.push(items.slice(i, i + chunkSize)); }
  return chunks;
};

// packages/backend/src/db/repositories/posts.ts:20-27  (SQL_IN_CHUNK_SIZE=500 L18, SQL_UPSERT_CHUNK_SIZE=50 L19)
const chunkArray = <T>(items: T[], chunkSize: number): T[][] => { /* идентичное тело */ };
```
(Также третья идентичная копия в `packages/backend/src/media/boardPrivacy.ts`.)

**db ↔ p2p циклическая зависимость / layering:**
- Подтверждён динамический импорт в posts.ts:
  ```ts
  // packages/backend/src/db/repositories/posts.ts:314
  const { getP2pHub } = await import("../../p2p/hub");
  ```
  (используется в конце `syncPostsAndMedia` для broadcast после commit). Динамическая форма используется именно для обхода статического циклического импорта.
- **Все cross-layer импорты из `db/repositories/*` в `p2p/` и `media/`:**

| Файл | Строки импорта | Цель |
|---|---|---|
| `boards.ts` | L4,5,6,7 | `../../p2p/journal`, `../../p2p/config`, `../../p2p/hub`, `../../media/boardPrivacy` |
| `chat.ts` | L11,12,13,14,15 | `../../p2p/ids`, `../../p2p/journal`, `../../p2p/config`, `../../p2p/hub`, `../../p2p/types` (type-only) |
| `media.ts` | L5,6,7 | `../../media/storage`, `../../p2p/ids`, `../../p2p/config` |
| `posts.ts` | L6,7,8,9 (+ dynamic L314) | `../../media/storage`, `../../p2p/ids`, `../../p2p/journal`, `../../p2p/config`, и dynamic `../../p2p/hub` |

То есть DB-репозитории зависят и от P2P слоя (journal/hub/ids/config/types), и от media слоя (storage/boardPrivacy), тогда как эти слои в свою очередь читают DB сущности (`media/boardPrivacy.ts` импортирует `db/entities/*`; `p2p/journal.ts` импортирует `db/entities/SyncChangeLog`) — настоящая **циклическая зависимость** между `db` и `p2p`, разорванная только динамическим импортом на `posts.ts:314`.

### План действий
1. **hashPassphrase:** генерировать per-user случайный salt (напр. 16 байт), хранить в новой колонке `ChatProfile.salt`; хэшировать `scryptSync(pass, perUserSalt, 64)`. Миграция на backfill salts для существующих строк и re-hash при следующем логине. Убрать literal fallback `"umechan-chat"` (fail fast при отсутствии salt).
2. **Дедупликация load-or-create:** вынести единый хелпер `getOrCreateThreadState(manager, profileId, threadId)` в chat.ts и вызывать из всех 5 методов + цикла markAllReadByBoard; объединить с транзакционной работой из 3.1, чтобы creation+save+journal происходили атомарно.
3. **Дедупликация chunkArray:** перенести в общий util (напр. `packages/backend/src/utils/chunk.ts`) и импортировать в media.ts, posts.ts, boardPrivacy.ts; удалить три локальные копии.
4. **Разорвать цикл db↔p2p:** ввести абстракцию, чтобы репозитории не импортировали p2p напрямую — напр. интерфейс `ChangeJournal` + `HubNotifier`, инжектимые в repository factory (или event/callback через `setJournalNotify`, который уже есть в `journal.ts:10-13`). Перевести `logChanges`/`newSyncId`/`p2pNodeId` за эту границу, чтобы у `db/repositories/*` было ноль статических и динамических импортов из `p2p/`. Media FS deletion (`deleteFilesForMedia`) тоже — через инжектимый storage-интерфейс.

### Критерий закрытия
- [ ] Нигде не осталось вхождения literal `"umechan-chat"`; каждый хэш использует сохранённый per-user salt (проверяется grep'ом + тест, утверждающий, что два пользователя с одинаковым passphrase получают разные хэши).
- [ ] Load-or-create блок существует ровно один раз в chat.ts (единый хелпер), используется всеми mutation-методами.
- [ ] `chunkArray` определён ровно один раз в кодовой базе и импортируется в остальных местах.
- [ ] Ни один файл под `db/repositories/*` не содержит импорта из `../../p2p/` или `../../media/` (статического или динамического); grep по этим путям возвращает ноль совпадений, и приложение всё равно стартует (цикл разорван через injection).

---

## 3.6 Тесты

### Находка
- **Под `src/db/` — ноль тест-файлов.** Подтверждено: glob `packages/backend/src/db/**/*.test.ts` не возвращает файлов. (Существующие тесты живут в других местах — напр. `media/*.test.ts`, `p2p/*.test.ts` — но DB-слой не покрыт.)

### План действий
Создать тест-файлы под `src/db/` (напр. `repositories/__tests__/`) с in-memory или temp-file SQLite `DataSource`. Приоритет, с минимальным осмысленным утверждением:

1. **`posts.syncPostsAndMedia`** — seed поста + медиа, выполнить sync дважды (во второй раз меняется message и удаляется одно медиа). Утверждать: Post-строка обновлена один раз, удалённая Media-строка дропнута, `SyncChangeLog` содержит ровно ожидаемые upsert/delete pointers; атомарность проверяется тем, что и БД, и журнал отражают изменение вместе.
2. **`posts.upsertMany`** — вставить чанк > `SQL_UPSERT_CHUNK_SIZE` (напр. 120 постов) с некоторыми дублирующимися id. Утверждать: все строки на месте, дубликаты обновлены, а не продублированы; выполнено в нескольких чанках без ошибки.
3. **Chunking `getExistingIds` / `getUpdatedAtByIds`** — передать список id > `SQL_IN_CHUNK_SIZE` (напр. 1200). Утверждать: возвращённый Set/Map полный и корректный через границу чанка (нет пропущенных id, нет SQLite "too many SQL variables" ошибки).
4. **`settings.upsert` / `get`** — upsert нового ключа, затем upsert снова с изменённым значением/типом; утверждать, что `get` возвращает типизированное значение (`number` для type `"number"`), и второй upsert обновляет, а не дублирует (одна строка на это имя).
5. **`bigintTransformer`** — round-trip: `to(...)` → string, `from("1234567890123")` → number; утверждать, что null/undefined проходят как null и большие значения выживают без потери точности.

### Критерий закрытия
- [ ] Под `src/db/` существует хотя бы один тест-файл (glob `packages/backend/src/db/**/*.test.ts` не пуст).
- [ ] Каждая из пяти функций выше имеет проходящий тест с указанным утверждением; `pnpm --filter backend test` гоняет их зелёным.

---

## Рекомендуемый порядок внутри шага

1. **3.1** (атомарность) — обернуть каждую chat/boards мутацию + её journal запись в одну транзакцию через существующий `{ manager }` путь в `logChanges`. Наивысший риск корректности сегодня.
2. **3.2** (N+1) — батчить `markAllReadByBoard`, оба apis list-endpoints, media replace/strip циклы.
3. **3.3** (индексы) — добавить `Media.postId`, общий `Post.boardId`, unique `Settings.name` одной новой миграцией.
4. **3.4** (миграции) — удалить избыточный row-by-row `backfillSyncIds`; дропнуть orphaned `File`/`Passport`.
5. **3.5** (layering) — инжектить journal/hub/storage, чтобы убрать цикл db↔p2p; дедуплицировать load-or-create и `chunkArray`; починить shared-salt KDF.
6. **3.6** (тесты) — поднять первый DB-layer test suite вокруг пяти перечисленных функций.
