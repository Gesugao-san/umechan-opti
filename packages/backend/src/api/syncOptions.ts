import type { CreateSyncServiceReturn } from "../sync";

export type ApiServerSyncOptions = {
  syncService?: CreateSyncServiceReturn;
  requestForceSync?: (threadId: number) => Promise<void>;
};
