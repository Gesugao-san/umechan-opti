# Step 3 — Chat state, cache и concurrency

## Scope

- `packages/frontend/src/components/chat/context/ChatAppProvider.tsx`
- `ChatAppContext.tsx`, `useChatApp.ts`
- `src/components/chat/rosterPagination.ts`
- `ChatRoster.tsx`, `ChatMessages.tsx`, `InfiniteScroll.tsx`
- `PrettyScrollbarContainer.tsx`, `ChatPane.tsx`, `ChatBoardSelector.tsx`

## План действий

1. Описать state machine: initial session, board selection, thread selection, roster loading, background sync, unread polling и logout/error.
2. Для `fetchRosterPage`, `syncBoardInBackground`, `selectBoard`, `loadMoreRoster`, `ensureRosterFillsViewport`, `pollBoardsUnread`, `refreshOpenThreadContent` построить request/result matrix.
3. Проверить stale response protection при смене board/thread, overlapping initial load, infinite scroll, polling и refresh.
4. Проверить `boardCacheRef`, pagination snapshots, `nextOffset`, `hasMore`, deduplication, hidden threads и локальные unread updates.
5. Проверить mutation ordering: mark read, hide, alias, folder actions, own post, send message и повторная загрузка выбранного треда.
6. Проверить polling при hidden tab, slow/failing API, 401/429/5xx и unmount; отдельно оценить cleanup timers/listeners.
7. Определить focused tests на pagination merge, stale responses, board switch race и recovery after failed mutation.

## Критерий закрытия

- Для каждого async flow определены owner, cancellation/ignore rule и state transition.
- Cache invalidation и pagination invariants проверяются тестами.
- Polling не создаёт неконтролируемых overlapping requests и корректно освобождает ресурсы.
- Ошибки не остаются невидимыми для пользователя и не затирают более свежий state.
