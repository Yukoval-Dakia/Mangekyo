import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../kernel/src/db/types.ts';
import {
  cases,
  caseId,
  clientRequest,
  getSession,
  recentConversations,
  RequestError,
  type openStudio,
} from './sessions.ts';
import type { openLibrary } from './library.ts';
import type { openPractice } from './practice.ts';
import { serveSessionEvents } from './stream.ts';
import { saveSettings, publicSettings, loadSettings } from './settings.ts';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new RequestError(415, '需要 JSON 请求。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new RequestError(413, '请求内容过长。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new RequestError(400, '请求格式无效。');
  }
}
function json(response: ServerResponse, status: number, data: unknown) {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(data));
}
const root = fileURLToPath(new URL('../../surfaces/web/dist/', import.meta.url));
const types: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const pages = new Set([
  '/',
  '/today',
  '/materials',
  '/materials/riding',
  '/practice/riding',
  '/companion',
  '/me',
  '/classroom/first45',
]);
export function serve(
  db: Db,
  studio: Awaited<ReturnType<typeof openStudio>>,
  library: ReturnType<typeof openLibrary>,
  practice: ReturnType<typeof openPractice>,
  port: number,
) {
  const hosts = new Set(['localhost', '127.0.0.1'].map((host) => host + ':' + port));
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    );
    try {
      const host = req.headers.host;
      if (
        !host ||
        !hosts.has(host) ||
        (req.headers.origin && req.headers.origin !== 'http://' + host) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new RequestError(403, '此入口仅供本机页面使用。');
      const path = new URL(req.url ?? '/', 'http://' + host).pathname;
      const method = req.method;
      if (path === '/api/cases' && method === 'GET') return json(res, 200, { cases });
      if (path === '/api/workspace' && method === 'GET') return json(res, 200, await library.snapshot());
      if (path === '/api/conversations' && method === 'GET')
        return json(res, 200, await recentConversations(db));
      if (path === '/api/materials' && method === 'POST') {
        const { requestId, title, text } = await body(req);
        return json(res, 201, await library.capture({ requestId, title, text }));
      }
      if (path === '/api/goal' && method === 'POST') {
        const { requestId, text } = await body(req);
        return json(res, 200, await library.setGoal({ requestId, text }));
      }
      if (path === '/api/practice/riding' && method === 'GET') return json(res, 200, await practice.read());
      if (path === '/api/practice/riding' && method === 'POST')
        return json(res, 200, await practice.submit(await body(req)));
      if (path === '/api/settings' && method === 'GET')
        return json(res, 200, publicSettings(await loadSettings()));
      if (path === '/api/settings' && method === 'PUT') {
        const input = await body(req);
        try {
          return json(res, 200, await saveSettings(input));
        } catch (error) {
          throw new RequestError(400, error instanceof Error ? error.message : '设置无效。');
        }
      }
      if (path === '/api/sessions' && method === 'POST') {
        const input = await body(req);
        return json(
          res,
          202,
          await studio.start(caseId(input.caseId), clientRequest(input.requestId), input.question),
        );
      }
      const eventPath = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})\/events$/.exec(path);
      if (eventPath?.[1] && method === 'GET') return await serveSessionEvents(db, eventPath[1], req, res);
      const match = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})(\/answers)?$/.exec(path);
      if (match?.[1] && !match[2] && method === 'GET') return json(res, 200, await getSession(db, match[1]));
      if (match?.[1] && match[2] && method === 'POST') {
        const input = await body(req);
        return json(
          res,
          202,
          await studio.answer(match[1], input.parentId, input.answer, clientRequest(input.requestId)),
        );
      }
      if (method !== 'GET' || path.startsWith('/api/')) throw new RequestError(404, '这个入口不存在。');
      const appPage = pages.has(path) || /^\/materials\/saved\/[0-9A-HJKMNP-TV-Z]{26}$/.test(path);
      const file = resolve(root, '.' + decodeURIComponent(appPage ? '/index.html' : path));
      if (!file.startsWith(resolve(root) + sep) || !types[extname(file)])
        throw new RequestError(404, '找不到页面。');
      const bytes = await readFile(file).catch(() => {
        throw new RequestError(404, '找不到页面，请先构建界面。');
      });
      res.writeHead(200, { 'Content-Type': types[extname(file)]! }).end(bytes);
    } catch (error) {
      if (!(error instanceof RequestError))
        console.error('studio request failed', error instanceof Error ? error.name : 'error');
      json(res, error instanceof RequestError ? error.status : 500, {
        error: error instanceof RequestError ? error.message : '服务未能完成请求。',
      });
    }
  });
}
