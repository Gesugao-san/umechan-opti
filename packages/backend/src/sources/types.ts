import type { ResponseBoard } from "../types/responseBoardsList";
import type { ResponsePost } from "../types/responseThreadsList";

/**
 * Контракт источника данных для синка.
 */
export type SyncSource = {
  getBoardsList: () => Promise<ResponseBoard[]>;
  getThreadsList: (params: { tag: string; offset: number; limit: number }) => Promise<ResponsePost[]>;
  getThreadPostsList: (params: { threadId: number }) => Promise<ResponsePost>;
};
