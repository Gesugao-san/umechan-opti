import type { ResponseMedia } from "../../types/responseThreadsList";
import { MediaType } from "@umechan/shared";
import { DataSource, In } from "typeorm";
import { Media } from "../entities/Media";
import { deleteFilesForMedia } from "../../media/storage";

const SQL_IN_CHUNK_SIZE = 500;

const chunkArray = <T>(items: T[], chunkSize: number): T[][] => {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
};

export const dbModelMedia = (dataSource: DataSource) => ({
  insert: async (mediaData: ResponseMedia, postId: number, mediaType: MediaType) => {
    const mediaRepository = dataSource.getRepository(Media);
    const newMedia = mediaRepository.create({
      mediaType,
      urlOrigin: mediaData.link,
      urlPreview: mediaData.preview,
      postId,
    });
    return mediaRepository.save(newMedia);
  },
  getByPostIds: async (postIds: number[]): Promise<Media[]> => {
    if (!postIds.length) return [];
    const result: Media[] = [];
    for (const chunk of chunkArray(postIds, SQL_IN_CHUNK_SIZE)) {
      const rows = await dataSource.getRepository(Media).find({
        where: { postId: In(chunk) },
      });
      result.push(...rows);
    }
    return result;
  },
  getByPostId: async (postId: number): Promise<Media[]> => {
    return dataSource.getRepository(Media).find({ where: { postId } });
  },
  deleteLocalFilesByPostId: async (postId: number) => {
    const rows = await dataSource.getRepository(Media).find({ where: { postId } });
    for (const row of rows) {
      await deleteFilesForMedia(row);
    }
  },
  dropByPostId: async (postId: number) => {
    const mediaRepository = dataSource.getRepository(Media);
    return mediaRepository.delete({
      postId,
    });
  },
  replaceForPosts: async (
    mediaItems: Array<{
      postId: number;
      mediaType: MediaType;
      link: string | null;
      preview: string | null;
      localPath?: string | null;
      localPreviewPath?: string | null;
    }>,
    postIds: number[]
  ) => {
    if (postIds.length) {
      await dataSource
        .getRepository(Media)
        .createQueryBuilder()
        .delete()
        .where("postId IN (:...postIds)", { postIds })
        .execute();
    }

    if (!mediaItems.length) return;

    await dataSource
      .createQueryBuilder()
      .insert()
      .into(Media)
      .values(
        mediaItems.map((item) => ({
          mediaType: item.mediaType,
          urlOrigin: item.link,
          urlPreview: item.preview,
          localPath: item.localPath ?? null,
          localPreviewPath: item.localPreviewPath ?? null,
          postId: item.postId,
        }))
      )
      .execute();
  },
});
