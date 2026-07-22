import axios from "axios";
import type { ApiTemplate } from "../types/apiTemplate";
import type { ResponseBoardsList } from "../types/responseBoardsList";
import type { ResponseThreadsList } from "../types/responseThreadsList";
import type { ResponseThreadPostsList } from "../types/responseThreadPostsList";
import { fetchEntitiesFromApiBaseLimit, ignoredBoardTags } from "../utils/config";
import type { SyncSource } from "./types";

export type CreateRestSourceParams = {
  baseUrl: string;
};

export const createRestSource = (params: CreateRestSourceParams): SyncSource => {
  const request = axios.create({
    baseURL: params.baseUrl,
  });

  return {
    getBoardsList: async () => {
      const response = await request.get<ApiTemplate<ResponseBoardsList>>("/v2/board?exclude_tags[]=", {
        params: { limit: fetchEntitiesFromApiBaseLimit },
      });
      return response.data.payload.boards;
    },

    getThreadsList: async ({ tag, offset, limit }) => {
      if (ignoredBoardTags.includes(tag)) {
        return [];
      }

      const response = await request.get<ApiTemplate<ResponseThreadsList>>(`/v2/board/${tag}`, {
        params: {
          offset,
          limit,
          no_board_list: "true",
        },
      });

      return response.data.payload?.posts || [];
    },

    getThreadPostsList: async ({ threadId }) => {
      const response = await request.get<ApiTemplate<ResponseThreadPostsList>>(`/v2/post/${threadId}`);
      return response.data.payload.thread_data;
    },
  };
};
