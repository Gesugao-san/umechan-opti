import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  getMediaDownloadMaxRetries,
  getMediaDownloadRetryDelayMs,
  getMediaDownloadTimeoutMs,
} from "../utils/config";
import { buildRelativePath, type MediaFileType, buildMediaFileName } from "./paths";
import { ensureThreadDir, fileExists, resolveAbsolutePath } from "./storage";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableStatus = (status: number): boolean => status >= 500;

export const downloadToAbsolutePath = async (
  url: string,
  absolutePath: string,
): Promise<boolean> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= getMediaDownloadMaxRetries(); attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), getMediaDownloadTimeoutMs());

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.status === 404) {
        return false;
      }

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < getMediaDownloadMaxRetries()) {
          await sleep(getMediaDownloadRetryDelayMs());
          continue;
        }
        return false;
      }

      if (!response.body) {
        return false;
      }

      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream);
      await pipeline(nodeStream, fs.createWriteStream(absolutePath));
      return true;
    } catch (err) {
      lastError = err;
      if (attempt < getMediaDownloadMaxRetries()) {
        await sleep(getMediaDownloadRetryDelayMs());
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError) {
    return false;
  }
  return false;
};

export const downloadMediaFile = async (params: {
  url: string;
  threadId: number;
  postId: number;
  fileType: MediaFileType;
}): Promise<string | null> => {
  const fileName = buildMediaFileName({
    postId: params.postId,
    fileType: params.fileType,
    sourceUrl: params.url,
  });
  const relativePath = buildRelativePath(params.threadId, fileName);

  if (fileExists(relativePath)) {
    return relativePath;
  }

  await ensureThreadDir(params.threadId);
  const absolutePath = resolveAbsolutePath(relativePath);
  if (!absolutePath) return null;

  const ok = await downloadToAbsolutePath(params.url, absolutePath);
  return ok ? relativePath : null;
};
