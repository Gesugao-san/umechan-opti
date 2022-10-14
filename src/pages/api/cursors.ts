import axios from 'axios';
import { NextApiRequest, NextApiResponse } from 'next';
import { BoardService, ThreadData } from 'src/services';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cursors = JSON.parse(req.query.cursors as string) as Record<string, string>;
  const threads = [] as ThreadData[];
  const response = {} as Record<string, { title: string; currentCursor: string; tag: string }>;

  axios.defaults.baseURL = 'http://pissykaka.scheoble.xyz';

  for (let cursor of Object.entries(cursors)) {
    const [threadId, _lastPostId] = cursor;

    const thread = (await BoardService.getThread(threadId)).payload.thread_data;
    threads.push(thread);
  }

  for (let thread of threads) {
    response[thread.id?.toString() || ''] = {
      title: thread.subject || `${thread.id} thread without subject`,
      currentCursor: thread.replies?.at(-1)?.id?.toString() || '',
      tag: thread.board_id?.toString() || '',
    };
  }

  res.json(response);
}