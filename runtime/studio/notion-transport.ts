import { notionVersion, type NotionReadRequest, type NotionReadResponse } from '../../modules/capture/notion-api.ts';
import { RequestError } from './sessions.ts';

type Requests<T> = Generator<NotionReadRequest, T, NotionReadResponse> | AsyncGenerator<NotionReadRequest, T, NotionReadResponse>;

export function notionConnection() {
  const local = process.env.MANGEKYO_NOTION_TEST_ORIGIN;
  if (local && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(local)) throw new Error('Invalid local Notion test origin');
  const origin = local || 'https://api.notion.com';
  const token = local ? 'isolated-notion-fixture' : process.env.MANGEKYO_NOTION_TOKEN;
  return {
    configured: Boolean(token),
    async read<T>(requests: Requests<T>, authorize: () => Promise<unknown>): Promise<T> {
      if (!token) throw new RequestError(503, '尚未配置服务端 Notion 只读连接。');
      let step = await requests.next();
      while (!step.done) {
        const request = step.value;
        const url = new URL(request.path, origin);
        if (url.origin !== origin || !url.pathname.startsWith('/v1/')) throw new Error('Invalid Notion read destination');
        await authorize();
        let reply: NotionReadResponse;
        try {
          const response = await fetch(url, {method: request.method, redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: {authorization: 'Bearer ' + token, 'Notion-Version': notionVersion, 'Content-Type':'application/json'},
            ...(request.method === 'POST' ? {body: JSON.stringify(request.body)} : {})});
          if (response.ok) {
            const body: unknown = await response.json();
            if (JSON.stringify(body).includes(token)) throw new Error('Invalid Notion response');
            reply = {status: response.status, body};
          } else {
            await response.body?.cancel();
            reply = {status: response.status, body: null};
          }
        } catch {
          step = await requests.throw(new RequestError(502, '未能确认 Notion 来源。'));
          continue;
        }
        step = await requests.next(reply);
      }
      return step.value;
    },
  };
}
