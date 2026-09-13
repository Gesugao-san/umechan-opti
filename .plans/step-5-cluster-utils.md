# Step 5 — Cluster + utils + entrypoints (надёжность, lifecycle)

> Детальный план действий. Каждый пункт: **Находка** (доказательства из кода с file:line) → **План действий** → **Критерий закрытия**.
> Ссылается на `packages/backend/REVIEW_PLAN.md` → Step 5. Модули: `src/index.ts`, `src/cluster.ts`, `src/cluster/ipc.ts`, `src/cluster/syncLock.ts`, `src/app/roles.ts`, `src/utils/*`.

---

## 5.1 Graceful shutdown / signal handling

### 5.1.A Нет graceful shutdown в monolith

**Находка.**
- Единственные process-level signal handlers во всём бэкенде — в cluster primary (`src/cluster.ts:105-106`):
  ```ts
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  ```
- Grep по `packages/backend/src/**/*.ts` на `process.on(` / `unhandledRejection` / `uncaughtException` / `SIGTERM` / `SIGINT`: **нет** handler'ов в `src/index.ts`, `src/app/roles.ts` и любом worker пути. Monolith (`runMonolith`) ничего не регистрирует.
- Последствия: при `Ctrl+C` (SIGINT) или остановке сервиса (SIGTERM) monolith процесс убивается OS default action **без cleanup**:
  - `AppDataSource` (better-sqlite3, WAL mode — `src/db/dataSource.ts:27-41`) никогда не `.close()`/`.destroy()`'ится. Единственный `AppDataSource.destroy()` в кодовой базе — `src/db/cli.ts:37` (migration CLI), а не app путь.
  - In-flight full sync (`runSyncLoop`, `src/app/roles.ts:81-92`) может быть убит mid-batch, рискуя частично применённым обновлением SQLite файла. WAL recovery обычно спасает при следующем open, но нет гарантированного checkpoint / `PRAGMA optimize` flush (единственный `PRAGMA optimize` — на старте, `src/db/connection.ts:17`).
  - API server (`fastify`) из `runMonolith` (`src/app/roles.ts:108-113`) никогда не `.close()`'ится в app пути.

**План действий:**
1. Добавить общий shutdown routine (напр. `shutdownApp(signal)`), используемый и monolith, и cluster primary: остановить приём новых API запросов, закрыть fastify, отменить/дождаться текущей итерации sync, затем `await AppDataSource.destroy()`.
2. Зарегистрировать `process.on("SIGTERM")` / `process.on("SIGINT")` в `runMonolith` (и worker-safe вариант), вызывающий его с force-exit после ограниченного grace периода.
3. Сделать периодический loop прерываемым: заменить голый `await sleep(...)` на abortable wait, чтобы shutdown мог быстро выйти из цикла.

**Критерий закрытия:**
- [ ] `SIGINT`/`SIGTERM` в monolith логирует shutdown сообщение и выходит с кодом 0 (не raw crash).
- [ ] При чистом выходе `AppDataSource.destroy()` дождён перед exit процесса (проверено логом + отсутствием роста `-wal` / БД открывается чисто после kill).
- [ ] Full sync, идущий в момент сигнала, либо завершается, либо прерывается без оставления БД в неконсистентном состоянии.
- [ ] API server socket закрывается при shutdown.

---

### 5.1.B Cluster primary shutdown forceful; workers без handler'ов

**Находка.**
- Primary shutdown (`src/cluster.ts:98-104`):
  ```ts
  const shutdown = () => {
    logger.info("[Cluster] Primary shutting down workers");
    for (const id in cluster.workers) {
      cluster.workers[id]?.kill("SIGTERM");
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  ```
  - Шлёт SIGTERM worker'ам, но **никогда не ждёт** их фактического выхода; после жёстких 5 с вызывает `process.exit(0)`. Worker, flush'ящий media/DB дольше 5 с, убивается mid-flight.
  - Собственная DB connection primary (`const db = await createDbConnection();` на `src/cluster.ts:63`) **никогда не закрывается** при shutdown — та же WAL/no-checkpoint экспозиция, что и в monolith.
- Workers регистрируют **никаких** signal handler'ов (см. 5.1.A). Когда terminal SIGINT бьёт по всей process group, workers получают его напрямую и умирают default action до того, как `shutdown()` primary сможет их скоординировать; fastify в каждом worker не закрывается gracefully.
- `.unref()` на 5s таймере означает, что если бы ничего не держало loop alive, процесс мог выйти раньше — но здесь активные workers его держат, так что именно force-exit завершает его.

**План действий:**
1. В `shutdown()` ждать выходы worker'ов (считать счётчик, декрементируемый в `exit` handler'е) до max grace периода, затем force-kill застрявших SIGKILL.
2. Закрывать `AppDataSource` primary и останавливать p2p control server (`fastify.close()` есть на `src/p2p/controlServer.ts:91`) при shutdown.
3. Дать worker'ам собственный SIGTERM handler, закрывающий fastify перед exit, чтобы скоординированный shutdown был чистым даже при прямом получении сигнала.

**Критерий закрытия:**
- [ ] Primary ждёт выхода всех worker'ов (или эскалирует после ограниченного таймаута), а не слепой 5s `process.exit(0)`.
- [ ] DB connection primary уничтожается при shutdown.
- [ ] Workers закрывают свой API server по SIGTERM перед exit.

---

## 5.2 Unhandled rejections / uncaught exceptions

### 5.2.A Нет глобальных handler'ов; monolith entrypoint без `.catch`

**Находка.**
- Grep по бэкенду на `unhandledRejection|uncaughtException|process.on("exit"|beforeExit`: **ноль** совпадений. Нет top-level safety net ни в одном процессе (monolith, primary, worker).
- Monolith entrypoint запускает floating promise без handler'а (`src/index.ts:27`):
  ```ts
  runMonolith(parseAppFlags());
  ```
  Если `runMonolith` reject'ит (напр. сбой DB init в `createDbConnection`, ошибка миграции, p2p identity assertion), default unhandled-rejection поведение Node печатает raw stack и выходит — без структурированного лога, без cleanup.
- Cluster хотя бы оборачивает два top-level вызова (`src/cluster.ts:134-141`):
  ```ts
  runPrimary().catch((err) => { logger.error(`[Cluster] Primary failed: ${err}`); process.exit(1); });
  ...
  runWorker().catch((err) => { logger.error(`[Cluster] Worker failed: ${err}`); process.exit(1); });
  ```
  но любой **другой** floating rejection внутри handler'ов (IPC, sync, API) всё равно крашит процесс без cleanup.

**План действий:**
1. Добавить `process.on("unhandledRejection", ...)` и `process.on("uncaughtException", ...)` в каждый entrypoint: логировать через `logger.error` и запускать graceful shutdown путь (затем exit non-zero).
2. Сохранить/стандартизировать `.catch` на top-level вызовах; убедиться, что каждый async handler (IPC, routes) дождён или явно обработан, чтобы rejection'и не плавали.

**Критерий закрытия:**
- [ ] Принудительный rejection в любом процессе даёт структурированный `ERR:` лог и контролируемый exit code, а не unhandled-rejection crash dump.
- [ ] Сбой `runMonolith` (напр. битая БД) логируется чисто и выходит non-zero без утечки raw stack как единственного сигнала.

---

## 5.3 Cluster worker lifecycle

### 5.3.A Restart loop: нет cap, нет backoff → crash-loop; неполная обработка exit code

**Находка.**
- Restart логика (`src/cluster.ts:83-96`):
  ```ts
  cluster.on("exit", (worker, code, signal) => {
    const wasListening = listeningWorkers.delete(worker.id);
    if (signal === "SIGTERM") { return; }
    if (!wasListening && code === 1) {
      logger.error(`[Cluster] Worker ${worker.process.pid} failed to start, not restarting`);
      return;
    }
    logger.warn(`... exited (code=${code}, signal=${signal}), restarting`);
    forkWorker();
  });
  ```
  - **Нет max-restart cap и нет backoff.** Worker, крашащий повторно, ре-fork'ится вечно (`forkWorker()` на `src/cluster.ts:95`) с нулевой задержкой → плотный crash-loop, бьющий по БД/CPU и спамящий логами.
  - «Не рестартить» guard покрывает только `code === 1` **и** never-listened. Worker, не стартовавший, но вышедший с другим кодом (напр. `2`, или uncaught exception → часто non-1), рестартится, хотя никогда не обслуживал — продлевая crash-loop.
  - Нет различия между «крахнулся во время обслуживания» и «не смог boot'нуться», поэтому персистентный startup fault зацикливается бесконечно.

**План действий:**
1. Считать per-worker (и/или глобальный) restart count с max порогом; после N последовательных сбоев прекратить рестарты (и желательно fail primary или сбросить нагрузку).
2. Добавить экспоненциальный backoff между re-fork'ами при быстрых сбоях.
3. Трактовать «вышел до listening» как non-restartable независимо от exit code, и логировать различающий случай.

**Критерий закрытия:**
- [ ] Crash-loop'ящий worker не рестартится больше ограниченного числа раз (проверено повторным убийством worker'а).
- [ ] Re-fork после сбоя задерживается backoff, а не мгновенный.
- [ ] Pre-listening startup failure не попадает в restart loop.

---

## 5.4 IPC (`cluster/ipc.ts`)

### 5.4.A Dead primary ⇒ 120s hang; нет lock timeout на стороне primary; ответ мёртвому worker'у

**Находка.**
- Client side (`src/cluster/ipc.ts:53-86`): `requestForceSyncFromPrimary` имеет 120s таймер (`FORCE_SYNC_IPC_TIMEOUT_MS = 120_000`, строка 9) и матчит ответы по `id`. Хорошо изолированно, но:
  - Если **primary умирает mid-request**, IPC канал worker'а закрывается; send теряется, и единственный failure путь — полный **120s** таймаут. Мёртвый primary заставляет каждый in-flight `force_sync` висеть две минуты перед ошибкой — плохая доступность и путающая латентность. Нет liveness check / fast-fail при закрытии канала (ошибки `process.send` не наблюдаются).
- Primary side (`src/cluster/ipc.ts:102-135`):
  ```ts
  void withSyncLock(async () => {
    try {
      if (!syncService) { throw new Error("sync is not available on this node"); }
      ...
      await syncService.updatePartial(msg.threadId);
      worker.send({ type: "force_sync_result", id: msg.id, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[Cluster] force_sync failed for thread ${msg.threadId}: ${error}`);
      worker.send({ type: "force_sync_result", id: msg.id, ok: false, error });
    }
  });
  ```
  - Работа идёт под **тем же** `withSyncLock`, что и периодический full sync (`src/cluster.ts:108-122`). Если `updatePartial` (или queued full sync) виснет на медленном upstream fetch, он держит lock бесконечно — **нет lease/timeout на lock**. Каждый последующий `force_sync` и каждый периодический sync выстраиваются за ним в очередь навсегда.
  - Client таймаутится через 120s, а primary может ещё работать; когда тот наконец завершает, вызывает `worker.send(...)` worker'у, который уже сдался (или вышел) — бесполезная работа, и send мёртвому worker'у не защищён.
- Message validation (`isForceSyncRequest`, `src/cluster/ipc.ts:36-40`) проверяет типы `type`/`id`/`threadId`, но `typeof NaN === "number"`, так что `NaN` threadId проходит guard; ловится только позже внутри `updatePartial` (`src/sync/createSyncService.ts:42-45`). Не вредно (обработано), но валидатор слабее, чем кажется.
- Нет per-message size bound на p2p broadcast/outbox массивы (`isP2pBroadcast`/`isP2pOutbox`, строки 43-51) — worker может затолкать произвольно большой `entries` массив в память primary.

**План действий:**
1. Детектировать закрытие IPC канала на client (слушать `'error'`/закрытие канала) и fail fast вместо ожидания полных 120s, когда primary пропал.
2. Добавить ограниченный lease на sync lock (или обернуть locked работу в `Promise.race` с таймаутом), чтобы зависшая задача не клинчила все последующие sync'и; при expiry — release и surface ошибки.
3. Защищать `worker.send(...)` от мёртвых worker'ов (проверять `worker.exited`) перед отправкой результатов.
4. Валидировать/ограничивать размер p2p IPC payload'ов.

**Критерий закрытия:**
- [ ] Убийство primary заставляет in-flight worker `force_sync` быстро падать (не через 120s).
- [ ] Зависший upstream fetch не блокирует последующие `force_sync`/периодические sync'и дольше ограниченного времени.
- [ ] Нет crash/log-spam при ответе уже вышедшему worker'у.

---

## 5.5 `syncLock.ts`

### 5.5.A Reentrancy deadlock, hang клинит lock (нет lease), per-process only; monolith вообще не использует lock

**Находка.**
- Реализация (`src/cluster/syncLock.ts:1-15`):
  ```ts
  export const createSyncLock = (): SyncLock => {
    let tail: Promise<void> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
      const run = tail.then(fn);
      tail = run.then(() => undefined, () => undefined);
      return run;
    };
  };
  ```
  - **Reentrancy ⇒ deadlock.** Если `fn` вызывает тот же lock повторно, внутреннее acquisition цепляется к `tail`, который не разрешится до завершения внешнего `fn` → self-deadlock. Нет re-entrancy guard или owner tracking.
  - **Зависшая (никогда не settle'ящаяся) `fn` клинит lock навсегда.** Rejection обрабатывается (`run.then(ok, err→undefined)` продвигает `tail`), так что *бросающая* задача не клинит — но вечно pending'ящаяся задача (напр. upstream fetch без таймаута) оставляет `tail` pending и каждое последующее acquisition виснет бесконечно. Нет lease/timeout/release-on-error-with-timeout.
  - **Per-process only.** Это in-memory promise chain; нет cross-process координации. Для cluster дизайна это приемлемо (workers делегируют primary через IPC), но lock даёт ноль защиты, если два *процесса* когда-нибудь тронут одну БД.
- **Monolith никогда не использует lock.** `runMonolith` вызывает `runSyncLoop(flags, syncService)` без `withSyncLock` (`src/app/roles.ts:123`), а внутри `runSyncLoop` fallback — no-op wrapper (`src/app/roles.ts:69`):
  ```ts
  const run = withSyncLock ?? (<T>(fn: () => Promise<T>) => fn());
  ```
  То есть в monolith режиме периодический full sync и API-triggered `updatePartial` (force_sync через собственный `syncService` API, `src/api/routes/util.ts:25`) могут идти **конкурентно** на одном better-sqlite3 соединении. Cluster сериализует это; monolith — нет: реальное расхождение в concurrency семантике между двумя режимами.
- Латентный unhandled-rejection: любой caller, вызывающий `withSyncLock(fn)` без await при reject'е `fn`, запустит floating rejection (нет глобального handler'а, см. 5.2.A). Текущие call sites обрабатывают (`void withSyncLock(async () => { try/catch })` и `await run(...)` в loop), так что это латентно, не активно.

**План действий:**
1. Добавить owner/re-entrancy guard, бросающий (или no-op'ящий) при nested acquisition из того же контекста — сделать deadlock невозможным.
2. Добавить lease/timeout: если held задача превышает bound — release lock и surface ошибки, чтобы pipeline не клинил навсегда.
3. Использовать тот же lock в monolith режиме (передать `createSyncLock()` в `runSyncLoop` из `runMonolith`), чтобы оба режима имели идентичные serialization семантики.

**Критерий закрытия:**
- [ ] Nested acquisition того же lock не может deadlock (unit test).
- [ ] Зависшая locked задача освобождает lock после ограниченного времени, последующие sync'и продолжаются.
- [ ] В monolith режиме `force_sync` и периодический full sync сериализованы lock'ом (нет конкурентных DB записей из обоих).

---

## 5.6 Utils: executors, timing, config, logger, sleep

### 5.6.A `parallelExecutor`: hang/throw при `parallelTasks <= 0`, out-of-order результаты, ошибки глотаются ⇒ тихая потеря данных, нет timeout

**Находка.**
- Реализация (`src/utils/parallelExecutor.ts:4-38`):
  ```ts
  const tasks = dataArray.map((taskEntry) => asyncTaskCreator(taskEntry));
  const result: K[] = [];
  const runnerStates: boolean[] = new Array(parallelTasks).fill(false);
  ...
  const run = async (runnerId: number) => {
    const task = tasks.shift();
    if (task) {
      runnerStates[runnerId] = true;
      try { result.push(await task()); }
      catch (e) { logger.error((e as Error).message); }
      finally { runnerStates[runnerId] = false; nextTick(() => run(runnerId)); }
    } else {
      if (runnerStates.every((state) => !state)) { resolve(result); }
    }
  };
  for (let i = 0; i < parallelTasks; i++) { run(i); }
  return promise;
  ```
  - **`parallelTasks === 0` ⇒ бесконечный hang.** `new Array(0)` пуст, `for` цикл не выполняется, ни один runner не вызывает `run()` → `resolve` никогда не вызывается → возвращённый promise никогда не settle'ится. Любой caller, ждущий его, виснет навсегда. (В cluster это также держало бы sync lock вечно — см. 5.5.A.)
  - **`parallelTasks < 0` ⇒ синхронный throw.** `new Array(-1)` бросает `RangeError: Invalid array length`, не пойманный на call site.
  - **Out-of-order результаты.** `result.push(await task())` добавляет в *порядке завершения*, а не входа. Текущие callers это терпят (`getFullThreads` делает `.flatMap((_) => _)` и count reduce — `src/sync/getFullThreads.ts:59-84`), но любой будущий caller, полагающийся на порядок, будет тихо неверен.
  - **Ошибки глотаются ⇒ тихая потеря данных.** `catch` только логирует `(e as Error).message` и не пушит ничего для той задачи — возвращённый массив на один элемент короче на каждый сбой без retry и без сигнала caller'у. В full sync это значит, что доска/тред с упавшим fetch тихо опускается из DB update — видно только в строке лога.
  - **Нет общего timeout / cancellation.** Одна зависшая задача ⇒ её runner никогда не завершается ⇒ `runnerStates.every(!state)` никогда true ⇒ promise никогда не resolve'ится ⇒ full sync виснет (и, под lock'ом, останавливает всё).
  - `(e as Error).message` даёт `"undefined"`, если брошено non-Error.

**План действий:**
1. Валидировать `parallelTasks >= 1` заранее и бросать ясную ошибку иначе (никогда не hang/RangeError молча).
2. Определить явный error контракт: либо прокидывать сбои (reject / собирать ошибки), либо возвращать per-item результаты, чтобы caller мог детектировать недостающие данные; никогда не ронять сбой только строкой лога для data-integrity пути.
3. Сохранять входной порядок в result массиве (индексировать по позиции, а не завершению).
4. Добавить опциональный общий timeout и/или per-task timeout, чтобы зависшая задача не клинила pipeline.

**Критерий закрытия:**
- [ ] `parallelExecutor(data, 0, ...)` бросает ясную ошибку вместо hang; отрицательное тоже чисто ошибается.
- [ ] Падшая задача доводится до caller'а (reject или представление), а не тихо роняется.
- [ ] Возвращённые результаты во входном порядке.
- [ ] Зависшая задача не может оставить promise unsettled дольше ограниченного времени.

---

### 5.6.B `parallelForEach`: `0` ⇒ молча ничего не делает; `< 0` бросает; ошибки глотаются

**Находка.**
- Реализация (`src/utils/parallelExecutor.ts:49-75`):
  ```ts
  if (dataArray.length === 0) { return; }
  const workers = Math.min(parallelTasks, dataArray.length);
  ...
  await Promise.all(Array.from({ length: workers }, () => worker()));
  ```
  - **`parallelTasks === 0` ⇒ `workers = 0`** → `Array.from({length: 0})` не порождает worker'ов → `Promise.all([])` resolve'ится мгновенно и **ничего не обрабатывается**. В `getFullThreadsV2` (`src/sync/getFullThreads.ts:140`) это значит, что ноль тредов fetched/persisted без ошибки — полная тихая потеря данных.
  - **`parallelTasks < 0` ⇒ `Math.min(neg, len) = neg`** → `Array.from({length: negative})` бросает `RangeError`.
  - **Ошибки глотаются:** worker'овский `catch (e) { logger.error((e as Error).message); }` логирует и продолжает — упавший тред пропускается без retry и без сигнала — снова тихий частичный sync.

**План действий:**
1. Валидировать `parallelTasks >= 1` заранее (общий guard с `parallelExecutor`).
2. Доводить per-item сбои до caller'а для data-integrity путей, а не только логировать.

**Критерий закрытия:**
- [ ] `parallelForEach(data, 0, fn)` ошибается ясно, а не молча обрабатывает ничего.
- [ ] Падший item доводится до caller'а, а не просто логируется.

---

### 5.6.C `measureTime`: shared-key race при concurrency (реальный баг), NaN без start, нет eviction (латентный leak)

**Находка.**
- Реализация (`src/utils/measureTime.ts:1-10`):
  ```ts
  const entriesStorage: Record<string, number> = {};
  export const measureTime = (entryName: string, type: "start" | "end") => {
    if (type === "start") { entriesStorage[entryName] = Date.now(); return 0; }
    else { return Date.now() - entriesStorage[entryName]; }
  };
  ```
  - **Shared-key race — активный баг.** `processPosts` использует фиксированный ключ `"db check posts"` (`src/sync/processors/processPosts.ts:88,117`) и вызывается **конкурентно** per thread через `parallelForEach` в `getFullThreadsV2` (`src/sync/createSyncService.ts:30-40`, `src/sync/getFullThreads.ts:140`). Несколько конкурентных вызовов переплетают `start`/`end` на одном ключе, так что каждый «duration» читает start time другого треда → логируемые timings — мусор. Тот же паттерн для `"db check boards"` (`processBoards.ts:7,26`), если когда-нибудь запустится конкурентно.
  - **NaN без start.** Вызов `"end"` без предшествующего `"start"` даёт `Date.now() - undefined = NaN`. В `runSyncLoop` initial-sync end логируется только при успехе (`src/app/roles.ts:73-78`); при сбое start timestamp остаётся stale (невредно, но никогда не чистится).
  - **Нет eviction.** Записи никогда не удаляются. Текущее использование ограничено четырьмя фиксированными ключами (`fetch_all`, `full_sync`, `db check boards`, `db check posts`), так что сегодня не растёт — но API это общий keyed store без delete, и любой будущий динамический ключ (напр. `` measureTime(`thread_${id}`) ``) будет течь бесконечно.

**План действий:**
1. Сделать timing scoped per-invocation: возвращать handle/token из `start` и передавать в `end`, либо использовать `withTiming(name, fn)` wrapper — полностью устранить shared-key race.
2. Защищать от отсутствующего start (возвращать/логировать ясное значение вместо NaN).
3. Если держать глобальную карту — добавить явный cleanup (`delete`) на end, чтобы записи не накапливались.

**Критерий закрытия:**
- [ ] Конкурентные вызовы `processPosts` больше не перекрещивают timings друг друга (unit test с пересекающимися start/end).
- [ ] `"end"` без соответствующего `"start"` никогда не даёт NaN.
- [ ] Записи удаляются после использования; карта не растёт между повторными sync'ами.

---

### 5.6.D Config loading/validation: NaN→default молча, `0`→default (нельзя выставить ноль), отрицательные принимаются ⇒ плотный sync loop, опасный production default, top-level consts заморожены на import

**Находка.**
- Каждый числовой env var использует паттерн `Number(process.env.X) || default` (`src/utils/config.ts:4-31`):
  ```ts
  export const fullSyncIntervalSeconds = Number(process.env.FULL_SYNC_INTERVAL_SECONDS) || 3600; // 1 hour
  ...
  export const getMediaDownloadMaxRetries = (): number => Number(process.env.MEDIA_DOWNLOAD_MAX_RETRIES) || 5;
  ```
  - **NaN ⇒ тихий default.** `FULL_SYNC_INTERVAL_SECONDS="abc"` → `NaN` → fallback на `3600`. Опечатанный значение молча игнорируется без предупреждения — misconfiguration скрыт.
  - **`0` ⇒ default (falsy).** `Number("0") || 5 = 5`, так что retries/limits/interval **нельзя** выставить в ноль; легитимные нулевые значения невозможны, override молча отбрасывается.
  - **Отрицательные принимаются.** `Number("-1")` truthy → используется как есть. `FULL_SYNC_INTERVAL_SECONDS=-1` ⇒ `fullSyncIntervalMs = -1000` ⇒ `sleep(-1000)` срабатывает мгновенно (`setTimeout` клампит отрицательное к ~0) ⇒ **плотный back-to-back full-sync loop** и в monolith, и в cluster (общий `runSyncLoop`, `src/app/roles.ts:81-92`). Нет range/finiteness валидации сверх NaN fallback.
  - **Нет port/range валидации.** `API_DEFAULT_LISTEN_PORT="99999999"` используется как есть и падает только поздно на bind с неясной ошибкой.
- **Опасный default скрывает misconfiguration:** `pissykakaApi` дефолтит к захардкоженному production URL (`src/utils/config.ts:2`):
  ```ts
  export const pissykakaApi = process.env.PISSYKAKA_API || "https://scheoble.xyz/api";
  ```
  Забыть выставить его — молча синкать с чужого/production API в обоих entrypoints.
- **Валидируется только `DATABASE_URL`**, и только на entrypoint (`src/index.ts:4`, `src/cluster.ts:27`). Все остальные переменные имеют тихие default'ы.
- **Top-level consts заморожены на import.** Env загружается через `node --env-file=.env` (см. scripts в `package.json`), так что он есть до запуска кода — но значения, захваченные как module-top константы (`fullSyncIntervalSeconds`, `pissykakaApi`, `apiDefaultListenPort`, …), читаются **один раз** на import и не меняются в рантайме или тестах, тогда как `get*()` функции читают env per call. Сосуществование замороженных consts и динамических getters (плюс deprecated aliases `mediaDataDir`/`apiPublicBaseUrl`, `src/utils/config.ts:16-23`) провоцирует использование stale значения.

**План действий:**
1. Добавить небольшой валидированный числовой парсер: отклонять non-finite, клампить до разрешённого диапазона и **warn/error** на невалидном input вместо тихой подстановки default; разрешать явный ноль там, где он осмыслен.
2. Валидировать ports/диапазоны при загрузке с ясными сообщениями.
3. Убрать или громко deprecate production-URL default для `PISSYKAKA_API` (требовать явно, либо логировать заметное предупреждение при использовании default).
4. Стандартизировать на lazy getters (`get*()`) и убрать замороженные top-level consts / deprecated aliases, чтобы избежать stale captures.

**Критерий закрытия:**
- [ ] Установка `FULL_SYNC_INTERVAL_SECONDS=-1` (или non-numeric) даёт ясную ошибку/предупреждение, а не плотный sync loop или тихий default.
- [ ] Ноль можно выставить там, где это валидное значение; невалидные значения никогда не подменяются молча без уведомления.
- [ ] Отсутствие `PISSYKAKA_API` либо fail fast, либо логирует неотразвимое предупреждение о встроенном production URL.

---

### 5.6.E Logger: `debug` → `console.warn`, нет level gating, unstructured output, неконсистентные сигнатуры

**Находка.**
- Реализация (`src/utils/logger.ts:1-9`):
  ```ts
  export const logger = {
    info: (text: string) => console.log(`INFO: ${text}`),
    error: (err: unknown) => console.error(`ERR: ${toString(err)}`),
    warn: (text: string) => console.warn(`WRN: ${text}`),
    debug: (text: string) => console.warn(`DBUG: ${text}`),
  };
  ```
  - **`debug` → `console.warn`.** Debug output пишется в stderr как *warnings*, засоряя warning stream и делая реальные warnings неотличимыми от verbose debug шума. Много per-thread `logger.debug(...)` вызовов в sync пути (`src/sync/getFullThreads.ts:56,74,80,120,139`), так что production run'ы выпускают большие объёмы «warnings», которые не warnings.
  - **Нет log-level gating.** Нет `LOG_LEVEL`/env контроля; debug всегда эмитится. В production его нельзя заглушить.
  - **Unstructured logging.** Ручные текстовые префиксы (`INFO:`/`ERR:`/…), нет timestamps, нет JSON, нет request/sync correlation ID — трудно парсить агрегаторами или коррелировать force_sync с его worker/thread.
  - **Неконсистентные сигнатуры.** `info/warn/debug` принимают `string`; `error` принимает `unknown`. Callers смешивают оба (`logger.error(err)` в `src/api/routes/util.ts:37` vs `` logger.error(`...${e}`) `` в `src/app/roles.ts:78`). Non-Error объекты, логируемые через `String(v)`, могут стать `[object Object]`.

**План действий:**
1. Маршрутизировать `debug` в debug-appropriate stream (`console.debug`) и гейтить его за log level (напр. `LOG_LEVEL=debug|info|warn|error`).
2. Добавить timestamps и structured/JSON output с полями (level, time, message, опциональный контекст вроде threadId/pid).
3. Унифицировать API так, чтобы все уровни принимали `unknown` и форматируются консистентно; добавить correlation ID для sync run'ов и запросов.

**Критерий закрытия:**
- [ ] При default уровне в production на stderr не появляется ни одной `DBUG:` строки; включённый debug показывает их в отдельном stream.
- [ ] Log строки парсибельны (timestamp + level + message) и коррелируемы с sync run / thread.

---

### 5.6.F `sleep`: не отменяемый; отрицательное/NaN трактуется как мгновенно

**Находка.**
- Реализация (`src/utils/sleep.ts:1`):
  ```ts
  export const sleep = (timeToSleep: number) => new Promise((res) => setTimeout(res, timeToSleep));
  ```
  - **Не прерываемый.** Периодический loop делает `await sleep(fullSyncIntervalMs)` (`src/app/roles.ts:82`). Нет способа выйти из него при shutdown (связь с 5.1.A–B); единственный выход сегодня — принудительный `process.exit`.
  - **Отрицательное/NaN ⇒ мгновенно.** `setTimeout` клампит отрицательные delays к ~0 и трактует NaN как 0, так что `sleep(-x)` или `sleep(NaN)` resolve'тся почти мгновенно. В связке с 5.6.D (отрицательный interval) это превращает плохое env значение в busy loop.
  - Таймер не unref'ится, что держит процесс alive — желательно для loop, но означает, что чистый exit требует явной отмены/force-exit.

**План действий:**
1. Предоставить abortable sleep (принимать `AbortSignal` или возвращать cancel функцию) и использовать его в sync loop, чтобы shutdown мог прервать быстро.
2. Валидировать/coerce delay (отклонять отрицательное/NaN ясной ошибкой, либо клампить к ≥ 0).

**Критерий закрытия:**
- [ ] Shutdown может прервать pending `sleep` без force-exit.
- [ ] Отрицательные/NaN delays отклоняются или клампятся, а не молча трактуются как мгновенно.

---

## Поперечные заметки

- **Monolith vs cluster concurrency divergence (5.5.A + 5.6.D).** Cluster сериализует периодический full sync и `force_sync` через `createSyncLock` (`src/cluster.ts:108-122`), но monolith не передаёт lock в `runSyncLoop` (`src/app/roles.ts:123`) и даже строит **два** отдельных `syncService` инстанса (один для API на `src/app/roles.ts:107`, один для loop на `src/app/roles.ts:122-123`). Итог: в monolith режиме API-triggered partial sync может идти конкурентно с периодическим full sync на одном SQLite соединении — hazard, которого просто нет (или он митигирован) в cluster режиме. Фиксы должны применяться к обоим путям.
- **Config gaps распространяются на entrypoints и lock (5.6.D + 5.5.A + 5.6.A).** Одно плохое `FULL_SYNC_INTERVAL_SECONDS` (отрицательное/NaN) ведёт плотный loop в *обоих* режимах через общий `runSyncLoop`; зависший upstream fetch без таймаута может клинить cluster sync lock навсегда, тогда как workers независимо таймаутятся через 120s — primary и worker'ы расходятся во мнениях об успехе sync.
- **Restart + IPC interaction (5.3.A + 5.4.A).** Неограниченный worker crash-loop продолжает re-fork и повторную отправку IPC; если вместо этого умирает *primary*, каждый in-flight worker `force_sync` виснет полные 120s без fast-fail, и никто не супервизирует/рестартит сам primary (это top-level node процесс).
- **Отсутствие глобального safety net усиливает всё (5.2.A).** Поскольку нет handler'ов `unhandledRejection`/`uncaughtException`, а monolith entrypoint без `.catch`, любой из перечисленных сбоев, проявившийся как floating rejection, крашит процесс raw stack'ом и без DB cleanup — превращая recoverable ошибку в data-integrity риск.
- **Shared-key race `measureTime` вызван тем, как sync его использует (5.6.C + 5.6.B).** Фиксированный ключ `"db check posts"` ведёт себя неверно только потому, что `parallelForEach` запускает `processPosts` конкурентно; фикс concurrency executor'а или scoping таймера — оба решают проблему.

---

## Рекомендуемый порядок внутри шага (по риску)

1. **5.2.A** (unhandledRejection/uncaughtException + `.catch`) — базовый safety net, усиливает всё остальное.
2. **5.1.A/B** (graceful shutdown monolith + cluster) — data-integrity при остановке.
3. **5.6.D** (config validation) — быстрый фикс, убирает целый класс тихих сбоев (плотный loop).
4. **5.6.A/B** (`parallelExecutor`/`parallelForEach`) — тихая потеря данных в sync; критично для data integrity.
5. **5.5.A + 5.4.A** (syncLock lease/reentrancy + IPC fast-fail) — клин pipeline'а и латентность.
6. **5.3.A** (restart cap/backoff) — стабильность cluster.
7. **5.6.C/E/F** (`measureTime`, logger, sleep) — качество наблюдаемости и корректность утилит.

> Подтверждение: исследование read-only, файлы не модифицировались.
