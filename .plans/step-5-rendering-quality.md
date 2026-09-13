# Step 5 — Rendering, utilities, accessibility и quality

## Scope

- `src/components/common/PostMDContent/PostMDContent.tsx`
- `src/utils/formatters/tunePostMessage.ts`
- `PostPointer.tsx`, `PostPointer.hook.ts`
- `Message.tsx`, `PostProto.tsx`, `ThreadProto.tsx`
- `src/utils/chatViewModel.ts`, `makeReplyMap.ts`, `makeMediaMap.ts`
- `formatDateTime.ts`, `Paginator.hook.tsx`, `Box.tsx`
- `src/app/globals.css`, chat/list components and all frontend test locations

## План действий

1. Проверить markdown/AST behavior на malformed input, неожиданных node types, URL schemes, quotes и reply pointers; зафиксировать отсутствие опасного HTML rendering.
2. Проверить media/post rendering на missing, duplicate, stale и oversized data; отдельно проверить cache lifetime `postsStorage` и media maps.
3. Проверить utility invariants: ordering, duplicate IDs, pagination offsets, date/timezone/DST, truncation и URL handling.
4. Провести accessibility pass для labels, semantic controls, keyboard navigation, focus management, live/loading/error states, alt text и responsive message layout.
5. Оценить rerender/performance hotspots: global context value, AST parsing, large rosters/messages, scroll/resize/image handlers, polling и unbounded in-memory caches.
6. Составить test inventory; добавить в будущий remediation plan focused tests для security-sensitive rendering, utilities, modal and accessibility behavior.
7. После findings прогнать frontend lint/build и targeted tests, затем отдельно проверить production-like navigation and error states.

## Критерий закрытия

- Недоверенный текст и URLs имеют проверяемую rendering policy.
- Utility invariants и boundary cases покрыты тестами.
- Основные интерактивные flows доступны без мыши и имеют ясные состояния.
- Performance risks измерены на realistic list sizes, а не только по чтению кода.
- Остаточные test gaps явно перечислены.
