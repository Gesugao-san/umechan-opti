import axios from 'axios';
import { CUSTOM_NEWS, HIDDEN_BOARDS_TAGS, NEWS_THREAD, PAGE_SIZE } from 'src/constants';
import { ApiResponse } from 'src/types/utils/ApiResponse';

import { apiBaseUrl } from '../../../config';
import { Passport } from '../../hooks/usePassportContext';
import { PostPassword } from '../../hooks/usePostsPasswordsContext';
import {
  Board,
  BoardData,
  IcestatsResponse,
  Post,
  RadioStatus,
  ThreadData,
  TuiStatsResponse,
} from './types';

const request = axios.create({ baseURL: apiBaseUrl });

export const BoardService = {
  async getAll(page: number, filter = true) {
    const boards = await BoardService.getAllBoards(filter);
    const concatenated = boards.payload.boards.map((_) => _.tag).join('+');

    return (
      await request.get<ApiResponse<{ posts: Post[]; count: number }>>(
        `/v2/board/${concatenated}`,
        {
          params: {
            limit: 20,
            offset: page * 20,
          },
        },
      )
    ).data;
  },

  async getAllBoards(filter = true) {
    const boards = await request.get<ApiResponse<{ boards: Board[]; posts: Post[] }>>('/v2/board');
    if (filter) {
      boards.data.payload.boards = boards.data.payload.boards.filter(
        (_) => !HIDDEN_BOARDS_TAGS.includes(_.tag),
      );
    }

    return boards.data;
  },

  async getBoard(tag: string, page = 0, size = PAGE_SIZE) {
    return (
      await request.get<ApiResponse<BoardData>>(`/v2/board/${tag}`, {
        params: { offset: page * size, limit: size },
      })
    ).data;
  },

  async getThread(threadId: string) {
    return (
      await request.get<ApiResponse<{ thread_data: ThreadData }>>(`/v2/post/${threadId || '0'}`)
    ).data;
  },

  async getLatestNews() {
    const threadData = (
      await request.get<ApiResponse<{ thread_data: ThreadData }>>(
        `/v2/post/${NEWS_THREAD.threadId}`,
      )
    ).data;

    threadData.payload.thread_data.replies = threadData.payload.thread_data.replies
      .reverse()
      .filter((post) => NEWS_THREAD.whitelist.includes(Number(post.id).toString()));

    CUSTOM_NEWS.forEach((news) => {
      threadData.payload.thread_data.replies = [
        {
          truncated_message: news.text,
          message: news.text,
        },
        ...threadData.payload.thread_data.replies,
      ];
    });

    return threadData;
  },

  async createPost(data: Record<string, unknown>) {
    const method = data.parent_id ? request.put : request.post;
    const res = await method<ApiResponse<{ post_id: number; password: string }>>(
      data.parent_id ? `/v2/post/${data.parent_id as string}` : '/v2/post',
      data,
      {
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );

    return res.data;
  },

  async getRadioStatus(statusUrl: string) {
    return (await axios.get<RadioStatus>(statusUrl)).data;
  },

  async getRadioStatusTui(statusUrl: string) {
    const rawStatus = (await axios.get<TuiStatsResponse>(statusUrl)).data;
    const status: RadioStatus = {
      thumbnailPath: rawStatus.cover,
      syncing: false,
      streaming: true,
      scheduling: true,
      playing: true,
      playlistData: {
        id: 0,
        name: '',
        type: '',
      },
      currentPlaylistId: '0',
      currentFile: '',
      fileData: {
        duration: 0,
        filehash: '',
        id3Title: rawStatus.title,
        id3Artist: rawStatus.artist,
        name: '',
        path: '',
        trimEnd: 0,
        trimStart: 0,
        type: '',
      },
    };

    return status;
  },

  async getRadioStatusIceStats(statusUrl: string) {
    const rawStatus = (await axios.get<IcestatsResponse>(statusUrl)).data;
    const status: RadioStatus = {
      thumbnailPath: '',
      syncing: false,
      streaming: true,
      scheduling: true,
      playing: true,
      playlistData: {
        id: 0,
        name: '',
        type: '',
      },
      currentPlaylistId: '0',
      currentFile: '',
      fileData: {
        duration: 0,
        filehash: '',
        id3Title: rawStatus.icestats?.source?.at(0)?.title,
        id3Artist: '',
        name: '',
        path: '',
        trimEnd: 0,
        trimStart: 0,
        type: '',
      },
    };

    return status;
  },

  async registerPassport(passport: Passport) {
    const res = await request.post<ApiResponse<{ post_id: number; password: string }>>(
      '/v2/passport',
      passport,
      {
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );

    return res.data;
  },

  async deletePost(postPass: PostPassword) {
    const res = await request.delete<ApiResponse<{ post_id: number; password: string }>>(
      `/v2/post/${postPass.post_id}`,
      {
        validateStatus: (status) => status >= 200 && status < 300,
        params: {
          password: postPass.password,
        },
      },
    );

    return res.data;
  },
};
