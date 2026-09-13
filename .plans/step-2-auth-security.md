# Step 2 — Auth, credentials и security boundaries

## Scope

- `packages/frontend/src/api/epds.ts`
- `packages/frontend/src/components/chat/context/ChatAppProvider.tsx`
- `packages/frontend/src/components/chat/components/ChatLogin/ChatLogin.tsx`
- `packages/frontend/src/components/common/ModalPostForm/PostForm.tsx`
- `packages/frontend/src/proxy.ts`
- `packages/frontend/src/app/moderka/**`
- backend touchpoints: `api/server.ts`, `api/routes/boards.ts`, auth/rate-limit and media routes

## План действий

1. Нарисовать credential flow: identify → cookie/session → session check → read/mutation → expiry/401 recovery.
2. Сопоставить cookie auth и client-provided `profileToken`; проверить, где он попадает в body/query и какая сторона является source of truth.
3. Проверить CSRF assumptions для credentialed cross-origin requests вместе с backend CORS and cookie settings.
4. Проверить доступность moderation routes и `/metrics`, fail-closed behavior при missing/malformed secrets и отсутствие лишних данных в error responses.
5. Проверить input boundaries для passphrase, post fields, IDs, `unmod`, upload metadata и external URLs; отдельно проверить, что `unmod=true` без авторизованной ChatUI-сессии не открывает модерационный контент.
6. Составить focused security checks: unauthenticated/expired ChatUI session with `unmod`, authorized ChatUI session with `unmod`, wrong origin, replayed token, repeated submit, malformed payload.
7. Проверить structured audit log при входе пользователя с `unmod`: user/session identity без секретов, timestamp, route/context и результат authorization.

## Критерий закрытия

- Auth/session state transitions и recovery paths определены.
- CSRF/CORS/cookie assumptions подтверждены совместно с backend.
- Moderation, metrics и mutation endpoints имеют явные access checks.
- `unmod` сохранён как функциональный флаг, но доступен только через авторизованный ChatUI flow; каждый такой вход оставляет проверяемую audit-запись.
- Пользовательский UI не раскрывает внутренние error details и не считает mutation успешной без подтвержденного результата.
