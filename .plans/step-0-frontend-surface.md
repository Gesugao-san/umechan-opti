# Step 0 — Frontend surface, routing и boundaries

## Scope

- `packages/frontend/src/app/layout.tsx`, `page.tsx`, `feed/page.tsx`
- `packages/frontend/src/app/board/[board_tag]/page.tsx`
- `packages/frontend/src/app/board/[board_tag]/[thread_id]/page.tsx`
- `packages/frontend/src/app/chat/page.tsx`
- `packages/frontend/src/app/moderka/**`
- `packages/frontend/src/components/layout/**`
- `packages/frontend/src/components/providers/index.tsx`
- `packages/frontend/src/proxy.ts`
- `packages/frontend/next.config.mjs`

## План действий

1. Построить таблицу маршрутов: path, route params, query params, server/client component boundary, API calls и expected failure states.
2. Проверить parsing/encoding `board_tag`, `thread_id`, pagination и сохранение `unmod` при навигации; убедиться, что включение флага в ChatUI не обходится прямым ручным query-запросом и что авторизованный вход с ним имеет audit log на backend.
3. Проверить server/client serialization, использование env vars, область действия глобальных providers и hydration behavior.
4. Проверить наличие и пригодность loading/error/not-found boundaries для feed, board, thread, chat и moderation.
5. Разобрать matcher proxy: обычный request pass-through, `/metrics`, static/page counters, auth failure и влияние на служебные запросы.
6. Сверить frontend assumptions с backend route status/error contracts.

## Доказательства и проверки

- Для каждой страницы зафиксировать входные значения и ожидаемый результат на valid/invalid/empty/API-error cases.
- Проверить production build и lint после последующих изменений; на этом этапе только зафиксировать отсутствующие checks.
- Проверить, что moderation и metrics имеют явно определенную auth boundary.

## Критерий закрытия

- Все route segments и параметры имеют владельца validation.
- Для каждого API failure определено user-visible поведение.
- Server/client boundary и provider scope документированы.
- Proxy security и metrics semantics проверены отдельно от page rendering.
