import fs from "node:fs";
import path from "node:path";
import { FastifyInstance, FastifyRequest } from "fastify";
import { isSafeFilename } from "../../media/paths";
import { resolveAbsolutePathFromParts } from "../../media/storage";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
};

const contentTypeForFilename = (filename: string): string => {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
};

export const bindMediaRoutes = (fastify: FastifyInstance) => {
  type ReqMedia = FastifyRequest<{ Params: { threadId: string; filename: string } }>;

  fastify.get("/api/v2/media/:threadId/:filename", async (request: ReqMedia, reply) => {
    const threadId = Number(request.params.threadId);
    const filename = request.params.filename;

    if (!Number.isFinite(threadId) || threadId <= 0) {
      reply.status(400).send({ error: "invalid thread id" });
      return;
    }

    if (!isSafeFilename(filename)) {
      reply.status(400).send({ error: "invalid filename" });
      return;
    }

    const absolutePath = resolveAbsolutePathFromParts(threadId, filename);
    if (!absolutePath) {
      reply.status(400).send({ error: "invalid path" });
      return;
    }

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      reply.status(404).send({ error: "not found" });
      return;
    }

    reply
      .header("Content-Type", contentTypeForFilename(filename))
      .header("Cache-Control", "public, max-age=31536000, immutable");

    return reply.send(fs.createReadStream(absolutePath));
  });
};
