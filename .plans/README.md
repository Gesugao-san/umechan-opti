# Backend code review — детальные планы действий (`.plans`)

Детализация плана из `packages/backend/REVIEW_PLAN.md` (Step 0–5). Каждый документ разбивает свой шаг на конкретные пункты, у каждого: **Находка** (доказательства с `file:line` и сниппетами кода) → **План действий** (нумерованные шаги) → **Критерий закрытия** (чек-лист проверяемых условий).

> ⚠️ Это **только план/ресёрч**. Код не модифицировался. Все пути в документах относительны к `packages/backend/`.

## Документы по шагам

## Frontend review plan

Перед backend-документами подготовлен отдельный план будущего ревью фронтенда: [review-plan-frontend.md](./review-plan-frontend.md). Он фиксирует модули, границы ответственности и порядок проверки; само ревью и изменения кода в него не входят.

| Шаг | Документ | Модули / фокус |
|-----|----------|----------------|
| 0 | [step-0-cross-cutting.md](./step-0-cross-cutting.md) | Сквозные: циклическая зависимость db↔p2p, отсутствие core-тестов (top-10 функций), потеря точности bigint→number, относительный DB path (зависит от CWD), in-memory state не cluster-safe. |
| 1 | [step-1-p2p.md](./step-1-p2p.md) | `src/p2p/`: race в `apply.ts` (read-check-write без tx, 7 веток), delete не gated LWW, LWW игнорирует revision, несогласованность originNodeId sentinel, lost updates в `client.ts`, отсутствие backoff/timeouts, unbounded outbox; безопасность: plaintext credential replication (`raw.ts`), non-constant-time compare + shared static token + нет TLS (`auth.ts`), нет rate-limit + `fs.statSync` (`routes.ts`), SSRF-ish callback fetch (`controlServer.ts`). |
| 2 | [step-2-sync.md](./step-2-sync.md) | `src/sync/`, `src/sources/`: silent failure в `parallelExecutor`, отсутствие HTTP timeout/retry в `sources/rest.ts`, тихая транкация `BOARD_INDEX_MAX_PAGES=1000`, race на media files, dead counter `processBoards.updated`, дублирование getFullThreads vs V2, per-process state `isFirstFullSync` (monolith создаёт два инстанса). |
| 3 | [step-3-db.md](./step-3-db.md) | `src/db/`: save+journal не атомарны (`chat.ts`, `boards.ts`), N+1 запросы, отсутствующие индексы (Media.postId, Post.boardId, Settings.name), проблемные миграции 001/007, захардкоженный salt в `hashPassphrase`, дублирование load-or-create и chunkArray. |
| 4 | [step-4-api-media.md](./step-4-api-media.md) | `src/api/`, `src/media/`: безопасность (server-side ChatUI authorization для сохранённого `unmod` флага и audit-лог входа с ним, CORS origin:true+credentials, cookie без Secure, error handler leak, metrics fail-open, rate-limit только на identify + spoofable IP), N+1 и auth boilerplate в `boards.ts`, media pipeline (непокрытый happy path, error swallowing, dead code, check-then-act race, нулевое покрытие boardPrivacy/serializers). |
| 5 | [step-5-cluster-utils.md](./step-5-cluster-utils.md) | `src/index.ts`, `src/cluster*`, `src/app/roles.ts`, `src/utils/*`: отсутствие graceful shutdown и unhandledRejection handler'ов, worker crash-loop без cap/backoff, IPC hang 120s при dead primary, syncLock reentrancy deadlock + нет lease (monolith не использует lock), `parallelExecutor`/`parallelForEach` тихая потеря данных, shared-key race в `measureTime`, config NaN→default и отрицательные значения, logger debug→console.warn. |

## Рекомендуемый порядок выполнения (по риску)

1. **Step 4 → 4.1.A** (`unmod` authorization) — критичный authz gap: флаг сохраняется для ChatUI, но должен работать только для авторизованной ChatUI-сессии и оставлять audit log входа пользователя с ним.
2. **Step 5 → 5.2.A / 5.1.A–B** (safety net + graceful shutdown) — превращает recoverable ошибки в data-integrity риск; базовый фундамент.
3. **Step 4 → 4.1.E/D/B/C/F** (metrics fail-open, error leak, CORS, cookie Secure, rate-limit/trustProxy) — быстрые security фиксы.
4. **Step 5 → 5.6.D / 5.6.A–B** (config validation + executors) — убирает целый класс тихих сбоев и потерь данных в sync.
5. **Step 1** (P2P: race, LWW, lost updates, plaintext credentials, auth/TLS) — целостность репликации и безопасность P2P.
6. **Step 3** (DB atomicity, N+1, индексы, миграции) — целостность и производительность БД.
7. **Step 2** (sync: timeouts/retries, truncation, media race, дублирование) — надёжность синка.
8. **Step 0** (cross-cutting: циклическая зависимость, core-тесты, bigint precision, DB path, cluster-safe state) — архитектурные и инфраструктурные улучшения.

> Внутри каждого шага свой «Рекомендуемый порядок внутри шага» в конце документа.

## Как читать каждый пункт

- **Находка** — что именно не так, с точными `file:line` и вербальными сниппетами (проверено по текущему содержимому файлов).
- **План действий** — нумерованные шаги исправления/укрепления.
- **Критерий закрытия** — чек-лист (`- [ ]`) проверяемых условий, доказывающих закрытие пункта.
