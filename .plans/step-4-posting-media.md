# Step 4 — Posting, upload и media flows

## Scope

- `packages/frontend/src/components/common/ModalPostForm/PostForm.tsx`
- `ModalPostForm.tsx`, `CreateThread.tsx`, `QuickReplyLink.tsx`
- `packages/frontend/src/components/chat/components/Posting/Posting.tsx`
- `packages/frontend/src/api/pissykaka.ts`
- `packages/frontend/src/components/common/PostMedia/**`
- `MediaModal.tsx`, `MediaModalHost.tsx`, `mediaModalHost.ts`
- backend touchpoints: post, force-sync and media routes

## План действий

1. Разложить flows для thread, reply и chat message: validation → upload → send → created ID → force sync → own post/refresh → cleanup.
2. Проверить double-submit guards, disabled/loading state, draft/messageOverride, target board/thread и `parentId`.
3. Проверить partial failures: upload success/send failure, send success/force-sync failure, missing created ID, delayed external consistency и router refresh.
4. Сопоставить POST/PUT payloads и нестабильный response parser с backend/Pissykaka contracts.
5. Проверить file type/size/count, cancellation, sequential/parallel uploads и режим `separatePictures`.
6. Проверить media URL trust, image/video/iframe fallback, YouTube URL parsing, duplicate media mapping, modal focus/Escape/navigation и localStorage volume.
7. Подготовить tests для success, partial failure, retry/repeat submit и media modal lifecycle.

## Критерий закрытия

- Успех и частичный успех posting flow различимы в state и UI.
- Повторная отправка не создаёт неожиданных дублей.
- Upload/media inputs имеют определенные limits и trusted URL policy.
- Modal и media lifecycle корректно очищают state, listeners и focus.
