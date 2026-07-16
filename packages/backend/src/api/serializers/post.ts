import type { EpdsPost, EpdsPostMedia } from "@umechan/shared";
import { EpdsPostMediaType } from "@umechan/shared";
import type { Media } from "../../db/entities/Media";
import type { Post } from "../../db/entities/Post";
import { buildPublicMediaUrl } from "../../media/paths";

const mediaTypeToEpds = (mediaType: string): EpdsPostMediaType => {
  if (mediaType === EpdsPostMediaType.YOUTUBE) return EpdsPostMediaType.YOUTUBE;
  if (mediaType === EpdsPostMediaType.VIDEO) return EpdsPostMediaType.VIDEO;
  return EpdsPostMediaType.PISSYKAKA_IMAGE;
};

export const serializeMedia = (media: Media): EpdsPostMedia => ({
  id: media.id,
  urlOrigin: buildPublicMediaUrl(media.localPath) ?? media.urlOrigin ?? "",
  urlPreview: buildPublicMediaUrl(media.localPreviewPath) ?? media.urlPreview ?? "",
  mediaType: mediaTypeToEpds(media.mediaType),
  postId: Number(media.postId),
});

export const serializePost = (post: Post | null | undefined): EpdsPost | null => {
  if (!post) return null;

  return {
    id: Number(post.id),
    poster: post.poster,
    posterVerified: post.posterVerified,
    subject: post.subject,
    message: post.message,
    messageTruncated: post.messageTruncated,
    timestamp: post.timestamp,
    updatedAt: post.updatedAt,
    boardId: Number(post.boardId),
    parentId: post.parentId != null ? Number(post.parentId) : null,
    isSticky: post.isSticky,
    isBlocked: post.isBlocked,
    board: post.board
      ? {
          id: Number(post.board.id),
          tag: post.board.tag,
          name: post.board.name,
        }
      : (undefined as unknown as EpdsPost["board"]),
    media: post.media?.map(serializeMedia),
    replies: post.replies?.map((reply) => serializePost(reply)).filter((item): item is EpdsPost => item != null),
  };
};

export const serializePosts = (posts: Post[]): EpdsPost[] =>
  posts.map((post) => serializePost(post)).filter((item): item is EpdsPost => item != null);
