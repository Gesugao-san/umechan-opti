# Step 1 — API clients и contracts

## Scope

- `packages/frontend/src/api/epds.ts`
- `packages/frontend/src/api/pissykaka.ts`
- `packages/shared/src/epds.ts`
- `packages/backend/src/api/routes/boards.ts`
- `packages/backend/src/api/routes/util.ts`
- `packages/backend/src/api/routes/media.ts`
- `packages/backend/src/api/serializers/post.ts`
- callers in `src/app/**`, `PostForm.tsx`, `ChatAppProvider.tsx`, `PostPointer.hook.ts`

## План действий

1. Составить endpoint matrix: method, URL, params/body, credentials, success envelope, error statuses и caller.
2. Сверить TypeScript generics Axios с runtime response shapes, optional/nullable fields и `{ error }` responses.
3. Проверить path construction и encoding для board/thread/post IDs, pagination, `unmod` и folder identifiers; зафиксировать contract: `unmod` остаётся поддерживаемым флагом, но его effect возможен только после успешной ChatUI authorization.
4. Определить policy для timeout, cancellation, retry и error normalization отдельно для GET, mutations, upload и `force_sync`.
5. Проверить env-based base URLs, trailing slash/path-prefix variants и build-time exposure `NEXT_PUBLIC_*`.
6. Зафиксировать минимальные contract tests для нестабильного post response и filestore response.

## Критерий закрытия

- Для каждого client method есть проверенный server/shared contract.
- Runtime-invalid responses не приводят к неясному или опасному UI state.
- URL/env behavior проверен для local, Docker и production-like configurations.
- Retry/timeout semantics явно различают idempotent reads и mutations.
