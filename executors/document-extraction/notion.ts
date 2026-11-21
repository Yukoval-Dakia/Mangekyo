// The host supplies an authorized stream of document reads and checks its grant before each request.
type DocumentRequest =
  | { readonly method: 'GET'; readonly path: string }
  | { readonly method: 'POST'; readonly path: `/v1/data_sources/${string}/query`; readonly body: unknown };
type DocumentResponse = { readonly status: number; readonly body: unknown };
type Requests<T> = Generator<DocumentRequest, T, DocumentResponse> | AsyncGenerator<DocumentRequest, T, DocumentResponse>;

export function openNotionReadTransport(origin: string, token: string | undefined, version: string,
  unavailable: (status: 502 | 503, message: string) => Error) {
  return {
    configured: Boolean(token),
    async read<T>(requests: Requests<T>, authorize: () => Promise<unknown>, cancelled?: AbortSignal): Promise<T> {
      if (!token) throw unavailable(503, '尚未配置服务端 Notion 只读连接。');
      let step = await requests.next();
      while (!step.done) {
        const request = step.value;
        const url = new URL(request.path, origin);
        if (url.origin !== origin || !url.pathname.startsWith('/v1/')) throw new Error('Invalid Notion read destination');
        await authorize();
        let reply: DocumentResponse;
        const headers = new Headers({authorization: 'Bearer ' + token, 'Notion-Version': version, 'Content-Type':'application/json'});
        try {
          const timeout = AbortSignal.timeout(15_000);
          const signal = cancelled ? AbortSignal.any([cancelled, timeout]) : timeout;
          const response = await fetch(url, {method: request.method, redirect: 'manual', signal, headers,
            ...(request.method === 'POST' ? {body: JSON.stringify(request.body)} : {})});
          if (response.ok) {
            reply = {status: response.status, body: await response.text()};
          } else {
            await response.body?.cancel();
            reply = {status: response.status, body: null};
          }
        } catch {
          cancelled?.throwIfAborted();
          step = await requests.throw(unavailable(502, '未能确认 Notion 来源。'));
          continue;
        }
        if (typeof reply.body === 'string') {
          const body: unknown = JSON.parse(reply.body);
          if (JSON.stringify(body).includes(token)) throw new Error('Invalid Notion response');
          reply = {status: reply.status, body};
        }
        step = await requests.next(reply);
      }
      return step.value;
    },
  };
}
