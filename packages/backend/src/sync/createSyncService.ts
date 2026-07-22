import { createDbConnection } from "../db/connection";
import { createRestSource } from "../sources";
import { logger } from "../utils/logger";
import { getFullThreads, getFullThreadsV2 } from "./getFullThreads";
import { processBoards } from "./processors/processBoards";
import { processPosts } from "./processors/processPosts";

export type CreateSyncServiceReturn = Awaited<ReturnType<typeof createSyncService>>;

export const createSyncService = async (baseUrl: string) => {
  const source = createRestSource({ baseUrl });
  const db = await createDbConnection();

  let isFirstFullSync = true;

  const updateAll = async () => {
    if (isFirstFullSync) {
      isFirstFullSync = false;
      logger.info("Full sync (initial via getFullThreads, no heuristics)...");
      const { boards, fullThreads } = await getFullThreads(source);
      logger.info("Update database (boards)...");
      await processBoards(boards, db);
      logger.info(`Update database (posts), threads=${fullThreads.length}...`);
      await processPosts(fullThreads, db);
      return;
    }

    logger.info("Full sync (streaming via getFullThreadsV2)...");
    await getFullThreadsV2(source, {
      onBoards: async (boards) => {
        logger.info("Update database (boards)...");
        await processBoards(boards, db);
      },
      onFullThread: async (thread) => {
        logger.debug(`Update database (posts), thread id=${thread.id}`);
        await processPosts([thread], db);
      },
    }, db);
  };

  const updatePartial = async (threadId: number) => {
    if (!Number.isFinite(threadId) || threadId <= 0) {
      throw new Error(`invalid threadId: ${threadId}`);
    }
    logger.info(`Partial sync: fetch thread ${threadId}...`);
    const thread = await source.getThreadPostsList({ threadId });
    logger.info("Update database (posts, single thread)...");
    await processPosts([thread], db);
  };

  return { updateAll, updatePartial };
};
