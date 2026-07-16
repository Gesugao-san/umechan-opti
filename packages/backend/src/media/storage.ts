import fs from "node:fs";
import path from "node:path";
import { getMediaDataDir } from "../utils/config";

const MEDIA_DATA_PREFIX = "media-data";

export const getMediaDataRoot = (): string => path.resolve(process.cwd(), getMediaDataDir());

export const resolveAbsolutePath = (relativePath: string): string | null => {
  if (!relativePath.startsWith(`${MEDIA_DATA_PREFIX}/`)) {
    return null;
  }

  const root = getMediaDataRoot();
  const relativeFromRoot = relativePath.slice(`${MEDIA_DATA_PREFIX}/`.length);
  const absolute = path.resolve(root, relativeFromRoot);
  const relativeCheck = path.relative(root, absolute);

  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
    return null;
  }

  return absolute;
};

export const resolveAbsolutePathFromParts = (
  threadId: number,
  filename: string,
): string | null => resolveAbsolutePath(`${MEDIA_DATA_PREFIX}/${threadId}/${filename}`);

export const ensureThreadDir = async (threadId: number): Promise<string> => {
  const dir = path.join(getMediaDataRoot(), String(threadId));
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

export const fileExists = (relativePath: string): boolean => {
  const absolute = resolveAbsolutePath(relativePath);
  if (!absolute) return false;
  try {
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
};

export const deleteFile = async (relativePath: string | null): Promise<void> => {
  if (!relativePath) return;
  const absolute = resolveAbsolutePath(relativePath);
  if (!absolute) return;
  try {
    await fs.promises.unlink(absolute);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
};

export const deleteFilesForMedia = async (paths: {
  localPath: string | null;
  localPreviewPath: string | null;
}): Promise<void> => {
  await deleteFile(paths.localPath);
  await deleteFile(paths.localPreviewPath);
};
