# Frontend code review — multi-step plan

Это только план будущего ревью. Код фронтенда и бекенда в рамках подготовки не изменялся, подтвержденные findings не формулируются.

## Главные модули и границы ревью

| Шаг | Документ | Основные модули | Backend touchpoints |
|---|---|---|---|
| 0 | [step-0-frontend-surface.md](./step-0-frontend-surface.md) | `src/app/`, `src/proxy.ts`, layouts, providers | `api/server.ts`, route status contracts |
| 1 | [step-1-api-contracts.md](./step-1-api-contracts.md) | `src/api/epds.ts`, `src/api/pissykaka.ts`, shared types | `api/routes/boards.ts`, serializers, `shared/src/epds.ts` |
| 2 | [step-2-auth-security.md](./step-2-auth-security.md) | credentials, chat login, proxy, moderation routes | CORS, cookies, auth/rate-limit, media routes |
| 3 | [step-3-chat-state.md](./step-3-chat-state.md) | `ChatAppProvider`, roster pagination, chat components | chat read/hidden/folder/own-post semantics |
| 4 | [step-4-posting-media.md](./step-4-posting-media.md) | `PostForm`, Pissykaka client, media components | post/force-sync/media API behavior |
| 5 | [step-5-rendering-quality.md](./step-5-rendering-quality.md) | markdown, media, utilities, accessibility, performance, tests | serialized post/media shape |

## Рекомендуемый порядок

1. Step 0: зафиксировать route/server-client boundaries и наблюдаемость ошибок.
2. Step 1: сверить фактические API contracts до проверки flows, которые на них опираются.
3. Step 2: проверить credentialed requests, CSRF и доступ к moderation/metrics.
4. Step 3: разобрать state machine чата, polling, cache и stale responses.
5. Step 4: проверить posting/upload consistency и partial-failure behavior.
6. Step 5: завершить проверками недоверенного контента, media lifecycle, utility correctness, accessibility, performance и test gaps.

## Формат каждого шага

Для каждого пункта будущего ревью собрать: evidence с путями и строками, impact, confidence, минимальный reproduction/check, затем отдельный remediation plan. Не смешивать подтвержденные findings с гипотезами и не исправлять код в рамках этого плана.

## Приоритетные узлы

- `src/components/chat/context/ChatAppProvider.tsx`: auth/session, mutations, cache, polling и error recovery.
- `src/api/epds.ts` + `src/api/pissykaka.ts`: единая политика контрактов, credentials, timeout/retry и ошибок.
- `unmod` остаётся поддерживаемым флагом, но доступ к его effect должен проходить через авторизованный ChatUI flow; каждый разрешённый вход с ним должен оставлять audit log без credential values.
- `src/components/common/ModalPostForm/PostForm.tsx`: upload → post → force sync → refresh.
- `src/components/common/PostMDContent/PostMDContent.tsx` и media-компоненты: rendering недоверенных данных и внешних ресурсов.
- `src/proxy.ts` и `src/app/*`: metrics, URL params, server/client boundaries и route-level failures.
