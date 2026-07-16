import { createHash } from "node:crypto";
import { getApiPublicBaseUrl } from "../utils/config";

export type MediaFileType = "image" | "image_preview" | "video" | "video_preview";

const MAX_FILE_NAME_LENGTH = 100;
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const hash8 = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 8);

export const sanitizeFileName = (name: string): string => {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }

  const sanitized = decoded
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9._\u0400-\u04FF-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, MAX_FILE_NAME_LENGTH);

  return sanitized || "file";
};

export const parseFilenameFromUrl = (url: string): { name: string; extension: string } => {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).pop() ?? "file";
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex > 0 && dotIndex < lastSegment.length - 1) {
      return {
        name: sanitizeFileName(lastSegment.slice(0, dotIndex)),
        extension: sanitizeFileName(lastSegment.slice(dotIndex + 1)).toLowerCase(),
      };
    }
    return { name: sanitizeFileName(lastSegment), extension: "bin" };
  } catch {
    return { name: "file", extension: "bin" };
  }
};

export const buildMediaFileName = (params: {
  postId: number;
  fileType: MediaFileType;
  sourceUrl: string;
}): string => {
  const { name, extension } = parseFilenameFromUrl(params.sourceUrl);
  const urlHash = hash8(params.sourceUrl);
  return `${params.postId}_${params.fileType}_${urlHash}_${name}.${extension}`;
};

export const buildRelativePath = (threadId: number, fileName: string): string =>
  `media-data/${threadId}/${fileName}`;

export const parseRelativePath = (
  relativePath: string,
): { threadId: number; fileName: string } | null => {
  const match = relativePath.match(/^media-data\/(\d+)\/([^/]+)$/);
  if (!match) return null;
  return { threadId: Number(match[1]), fileName: match[2] };
};

export const buildPublicMediaUrl = (relativePath: string | null): string | null => {
  if (!relativePath) return null;
  const parsed = parseRelativePath(relativePath);
  if (!parsed) return null;
  const base = getApiPublicBaseUrl().replace(/\/$/, "");
  return `${base}/v2/media/${parsed.threadId}/${encodeURIComponent(parsed.fileName)}`;
};

export const isSafeFilename = (filename: string): boolean =>
  SAFE_FILENAME_PATTERN.test(filename) && !filename.includes("..");

export const originFileType = (mediaType: string): MediaFileType =>
  mediaType === "video" ? "video" : "image";

export const previewFileType = (mediaType: string): MediaFileType =>
  mediaType === "video" ? "video_preview" : "image_preview";
