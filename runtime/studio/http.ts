import type { openMemoryManagement } from './memory-management.ts';
import { browseMcpTools } from '../../executors/teaching/mcp-client.ts';
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
import { TextbookConflictError, type openTextbook } from './textbook.ts';
import type { openRelationReview } from './workspace-relation.ts';
import { studioLearner } from './identity.ts';
import type { openLibrary } from './library.ts';
import type { openPractice } from './practice.ts';
import { handleIntakeRequest, type openIntake } from './intake.ts';
import type { openWorkbook } from './workbook.ts';
import type { openOrganizer } from './organizer.ts';
import type { openMemory } from './memory.ts';
import type { openWorkspaceAccess } from './workspace-access.ts';
import type { openResearch } from './research.ts';
import type { openRetention } from './retention.ts';
import type { openRetentionComparison } from './retention-comparison.ts';
import { recallDisplayToken, type RecallHttp } from './recall-http.ts';
import { RecallRequestError } from './recall.ts';
import { ridingReview } from './review.ts';
import { serveSessionEvents } from './stream.ts';
import { saveSettings, publicSettings, loadSettings } from './settings.ts';

import {actOnArtifact} from './presentation-store.ts';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new RequestError(415, '需要 JSON 请求。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new RequestError(413, '请求内容过长。');
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
  '/today', '/papers', '/papers/new', '/plan', '/notes', '/review', '/intake',
  '/materials', '/materials/workspace',
  '/textbooks', '/textbooks/page',
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
  student: {
    textbook: ReturnType<typeof openTextbook>;
    relationReview: ReturnType<typeof openRelationReview>;
    workbook: ReturnType<typeof openWorkbook>;
    organizer: ReturnType<typeof openOrganizer>;
    memory: ReturnType<typeof openMemory>;
    memoryManagement: ReturnType<typeof openMemoryManagement>;
    intake: ReturnType<typeof openIntake>;
    workspace: ReturnType<typeof openWorkspaceAccess>;
    research: ReturnType<typeof openResearch>;
    recall: RecallHttp;
    retention: ReturnType<typeof openRetention>;
    retentionComparison: ReturnType<typeof openRetentionComparison>;
  },
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
      const url = new URL(req.url ?? '/', 'http://' + host);
      const path = url.pathname;
      const method = req.method;
      if (path === '/api/workspace/access' && method === 'GET') {
        return json(res, 200, await student.workspace.list(url.searchParams));
      }
      if (path === '/api/workspace/access/providers' && method === 'GET') {
        return json(res, 200, await student.workspace.providers());
      }
      const accessRecord = /^\/api\/workspace\/access\/records\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
      if (accessRecord?.[1] && method === 'GET') {
        return json(res, 200, await student.workspace.record(accessRecord[1], url.searchParams));
      }
      if (accessRecord?.[1] && method === 'PUT') {
        return json(res, 200, await student.workspace.setTeaching(accessRecord[1], await body(req)));
      }
      const observationUndo = /^\/api\/workspace\/observations\/([0-9A-HJKMNP-TV-Z]{26})\/undo$/.exec(path);
      if (observationUndo?.[1] && method === 'POST')
        return json(res, 200, await student.workspace.undoObservation(observationUndo[1],await body(req)));
      const relationProposal = /^\/api\/workspace\/relations\/proposals\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path)?.[1];
      if (relationProposal && method === 'GET')
        return json(res, 200, await student.relationReview.proposal(relationProposal));
      if (relationProposal && method === 'POST') {
        const {decision} = await body(req);
        if (decision === 'accept') return json(res, 200, await student.relationReview.accept(relationProposal));
        if (decision === 'reject') return json(res, 200, await student.relationReview.reject(relationProposal));
        throw new RequestError(400, '请选择采纳或拒绝此提议。');
      }
      const relationUndo = /^\/api\/workspace\/relations\/([0-9A-HJKMNP-TV-Z]{26})\/undo$/.exec(path)?.[1];
      if (relationUndo && method === 'POST')
        return json(res, 200, await student.relationReview.undo(relationUndo,await body(req)));
      const accessProvider = /^\/api\/workspace\/access\/providers\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(path);
      if (accessProvider?.[1] && method === 'PUT') {
        return json(res, 200, await student.workspace.setProvider(accessProvider[1], await body(req)));
      }
      if (path === '/api/research/settings' && method === 'GET') return json(res, 200, await student.research.read());
      if (path === '/api/research/settings' && method === 'PUT') return json(res, 200, await student.research.configure(await body(req)));
      const research = /^\/api\/papers\/([0-9A-HJKMNP-TV-Z]{26})\/attempts\/([0-9A-HJKMNP-TV-Z]{26})\/(research-permission|research)(?:\/([0-9A-HJKMNP-TV-Z]{26})\/source)?$/.exec(path);
      if (research?.[1] && research[2]) {
        const [, paperId, attemptId, resource, id] = research;
        if (resource === 'research-permission' && !id && method === 'GET')
          return json(res, 200, await student.research.permission(paperId!, attemptId!));
        if (resource === 'research-permission' && !id && method === 'PUT')
          return json(res, 200, await student.research.allow(paperId!, attemptId!, await body(req)));
        if (resource === 'research' && method === 'GET') {
          if (id) return json(res, 200, await student.research.source(paperId!, attemptId!, id));
          return json(res, 200, { worksheet: await student.research.worksheet(paperId!, attemptId!) });
        }
      }
      if (path === '/api/textbooks' && method === 'GET')
        return json(res, 200, await student.textbook.list({ learner: studioLearner }));
      if (path === '/api/textbooks' && method === 'POST') {
        const { requestId, clientEditSeq, page } = await body(req);
        return json(res, 201, await student.textbook.create({ learner: studioLearner, requestId, clientEditSeq, page }));
      }
      const textbookAction = /^\/api\/textbooks\/([0-9A-HJKMNP-TV-Z]{26})\/(proposals(?:\/([0-9A-HJKMNP-TV-Z]{26}))?|undo)$/.exec(path);
      if (textbookAction?.[1]) {
        const [,id,action,proposalId] = textbookAction;
        const input = {learner:studioLearner,id};
        if (proposalId && method === 'GET') return json(res,200,await student.textbook.proposal(input,proposalId));
        if (proposalId && method === 'POST') {
          const {blockIds} = await body(req);
          return json(res,200,await student.textbook.proposal(input,proposalId,{blockIds}));
        }
        if (action === 'proposals' && method === 'GET') return json(res,200,await student.textbook.proposals(input));
        if (action === 'undo' && method === 'POST')
          return json(res,200,await student.textbook.undo(input,(await body(req)).undo_token));
      }
      const textbook = /^\/api\/textbooks\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
      if (textbook?.[1] && method === 'GET') {
        const rev = url.searchParams.has('rev') ? Number(url.searchParams.get('rev')) : undefined;
        if (rev !== undefined && (!Number.isInteger(rev) || rev < 1 || rev > 2147483647))
          throw new RequestError(400, '教材版本无效。');
        return json(res, 200, await student.textbook.get({ learner: studioLearner, id: textbook[1], rev }));
      }
      if (textbook?.[1] && method === 'POST') {
        const { requestId, clientEditSeq, expectedRev, edits } = await body(req);
        return json(res, 200, await student.textbook.revise({ learner: studioLearner, id: textbook[1],
          requestId, expectedRev, clientEditSeq, edits }));
      }
      const reading = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})\/reading$/.exec(path);
      if (reading?.[1] && method === 'GET') return json(res, 200, await library.reading(reading[1]));
      if (await handleIntakeRequest(student.intake, req, res, path, method)) return;
      if (path === '/api/papers' && method === 'GET') return json(res, 200, await student.workbook.list());
      if (path === '/api/papers' && method === 'POST') return json(res, 201, await student.workbook.save(await body(req)));
      if (path === '/api/retention/posttests' && method === 'GET')
        return json(res, 200, await student.retention.listPosttests());
      if (path === '/api/retention/papers' && method === 'POST') {
        return json(res, 201, await student.retention.savePosttestPaper(await body(req)));
      }
      const posttest = /^\/api\/retention\/([0-9A-HJKMNP-TV-Z]{26})\/posttest(?:\/([0-9A-HJKMNP-TV-Z]{26})\/submission)?$/.exec(path);
      if (posttest?.[1] && method === 'POST') {
        return posttest[2]
          ? json(res, 200, await student.retention.submitPosttest(posttest[1], posttest[2], await body(req)))
          : json(res, 200, await student.retention.startPosttest(posttest[1], await body(req)));
      }
      const freeze = /^\/api\/papers\/([0-9A-HJKMNP-TV-Z]{26})\/retention$/.exec(path);
      if (freeze?.[1] && method === 'POST') {
        const result = await student.retention.freeze(freeze[1], await body(req));
        return json(res, result.state === 'pending' ? 202 : 200, result);
      }
      const retentionReview = /^\/api\/retention\/([0-9A-HJKMNP-TV-Z]{26})\/research$/.exec(path);
      if (retentionReview?.[1] && method === 'GET')
        return json(res, 200, await student.research.retentionReview(retentionReview[1]));
      if (retentionReview?.[1] && method === 'PUT')
        return json(res, 200, await student.research.allowRetentionReview(retentionReview[1], await body(req)));
      if (path === '/api/retention/comparisons' && method === 'POST') {
        const result = await student.retentionComparison.start(await body(req));
        return json(res, result.state === 'pending' ? 202 : 200, result);
      }
      const comparison = /^\/api\/retention\/comparisons\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
      if (comparison?.[1] && method === 'GET')
        return json(res, 200, await student.retentionComparison.get(comparison[1]));
      const retention = /^\/api\/retention\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(reconcile|followup))?$/.exec(path);
      if (retention?.[1] && !retention[2] && method === 'GET')
        return json(res, 200, await student.retention.get(retention[1]));
      if (retention?.[1] && retention[2] && method === 'POST') {
        const input = await body(req);
        const result = retention[2] === 'followup'
          ? await student.retention.scheduleFollowup(retention[1], input)
          : await student.retention.reconcile(retention[1], input);
        return json(res, result.state === 'pending' ? 202 : 200, result);
      }
      const assessment = /^\/api\/papers\/([0-9A-HJKMNP-TV-Z]{26})\/attempts\/([0-9A-HJKMNP-TV-Z]{26})\/assessments$/.exec(path);
      if (assessment?.[1] && assessment[2] && method === 'POST') {
        return json(res, 200, await student.workbook.assess(assessment[1], assessment[2], await body(req)));
      }
      const paper = /^\/api\/papers\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(attempts|print))?$/.exec(path);
      if (paper?.[1] && method === 'GET' && !paper[2]) return json(res, 200, await student.workbook.get(paper[1]));
      if (paper?.[1] && method === 'GET' && paper[2] === 'print') return json(res, 200, await student.workbook.sheet(paper[1]));
      if (paper?.[1] && method === 'POST' && paper[2] === 'attempts') return json(res, 200, await student.workbook.submit(paper[1], await body(req)));
      if (path === '/api/review' && method === 'GET') {
        const [mine, riding] = await Promise.all([student.workbook.review(), practice.read()]);
        return json(res, 200, [...mine, ...ridingReview(riding)]);
      }
      if (path === '/api/organizer/index' && method === 'GET') {
        const { tasks, notes } = await student.organizer.snapshot(false);
        return json(res, 200, { tasks, notes: notes.map(({id, title}) => ({id, title})) });
      }
      if (path === '/api/organizer' && method === 'GET') return json(res, 200, await student.organizer.snapshot());
      if (path === '/api/organizer/tasks' && method === 'POST') return json(res, 200, await student.organizer.task(await body(req)));
      if (path === '/api/organizer/notes' && method === 'POST') return json(res, 200, await student.organizer.note(await body(req)));
      if (path === '/api/memory/claims' && method === 'GET')
        return json(res, 200, await student.memoryManagement.list(url.searchParams.get('before')));
      const memorySource = /^\/api\/memory\/claims\/sources\/([0-9A-HJKMNP-TV-Z]{26})\/revoke$/.exec(path);
      if (memorySource?.[1] && method === 'POST')
        return json(res, 200, await student.memoryManagement.revokeSource(memorySource[1], await body(req)));
      const claim = /^\/api\/memory\/claims\/([0-9A-HJKMNP-TV-Z]{26})(\/undo)?$/.exec(path);
      if (claim?.[1] && method === 'POST')
        return json(res, 200, await (claim[2] ? student.memoryManagement.undo : student.memoryManagement.manage)(claim[1], await body(req)));
      if (path === '/api/memory' && method === 'GET') return json(res, 200, await student.memory.read());
      if (path === '/api/memory' && method === 'POST') return json(res, 200, await student.memory.save(await body(req)));
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
      if (path === '/api/settings/mcp-tools' && method === 'POST') {
        const input = await body(req);
        if (typeof input.id !== 'string' || typeof input.url !== 'string' ||
            (input.token !== undefined && typeof input.token !== 'string')) throw new RequestError(400, 'MCP 地址或凭据无效。');
        const saved = (await loadSettings()).mcpServers.find(item => item.id === input.id && item.url === input.url);
        const token = input.token === undefined ? saved?.token : input.token;
        try {
          return json(res, 200, await browseMcpTools({id: input.id, url: input.url, allowedTools: [], ...(token ? {token} : {})}));
        } catch {
          throw new RequestError(422, '无法读取 MCP 工具。请核对 Streamable HTTP 地址和访问令牌。');
        }
      }
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
          await studio.start(caseId(input.caseId), clientRequest(input.requestId), input.question, input.attachment, input.mcpGrants, input.route,
            input.currentObject, input.allowBackgroundUnderstanding),
        );
      }
      const actionPath = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})\/artifact-actions$/.exec(path);
      if (actionPath?.[1] && method === 'POST') return json(res,200,await actOnArtifact(db,actionPath[1],await body(req)));
      const eventPath = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})\/events$/.exec(path);
      if (eventPath?.[1] && method === 'GET') return await serveSessionEvents(db, eventPath[1], req, res, student.recall.project);
      const recall = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})\/recall\/(state|reveal|display|submit)$/.exec(path);
      if (recall?.[1] && recall[2] === 'state' && method === 'GET') {
        return json(res, 200, await student.recall.readState(recall[1], url.searchParams));
      }
      if (recall?.[1] && recall[2] !== 'state' && method === 'POST') {
        const input = await body(req);
        if (recall[2] === 'reveal') {
          const { data, token } = await student.recall.reveal(recall[1], input);
          res.setHeader(recallDisplayToken, token);
          return json(res, 200, data);
        }
        if (recall[2] === 'display') return json(res, 200, await student.recall.display(recall[1], input, req.headers));
        return json(res, 200, await student.recall.submit(recall[1], input));
      }
      const match = /^\/api\/sessions\/([0-9A-HJKMNP-TV-Z]{26})(\/answers)?$/.exec(path);
      if (match?.[1] && !match[2] && method === 'GET') return json(res, 200, await getSession(db, match[1], student.recall.project));
      if (match?.[1] && match[2] && method === 'POST') {
        const input = await body(req);
        return json(
          res,
          202,
          await studio.answer(match[1], input.parentId, input.answer, clientRequest(input.requestId), input.mcpGrants, input.route, input.currentObject,
            input.allowBackgroundUnderstanding),
        );
      }
      if (method !== 'GET' || path.startsWith('/api/')) throw new RequestError(404, '这个入口不存在。');
      const appPage = pages.has(path) || /^\/papers\/[0-9A-HJKMNP-TV-Z]{26}(?:\/print)?$/.test(path) || /^\/materials\/(?:saved|records)\/[0-9A-HJKMNP-TV-Z]{26}$/.test(path);
      const file = resolve(root, '.' + decodeURIComponent(appPage ? '/index.html' : path));
      if (!file.startsWith(resolve(root) + sep) || !types[extname(file)])
        throw new RequestError(404, '找不到页面。');
      const bytes = await readFile(file).catch(() => {
        throw new RequestError(404, '找不到页面，请先构建界面。');
      });
      res.writeHead(200, { 'Content-Type': types[extname(file)]! }).end(bytes);
    } catch (error) {
      if (error instanceof TextbookConflictError) return json(res, 409, error.toJSON());
      const expected = error instanceof RequestError || error instanceof RecallRequestError;
      if (!expected)
        console.error('studio request failed', error instanceof Error ? error.name : 'error');
      json(res, expected ? error.status : 500, {
        error: expected ? error.message : '服务未能完成请求。',
      });
    }
  });
}
