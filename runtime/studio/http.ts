import { classroomPath, factId as classroomFactId } from './classroom.ts';
import type { ClassroomOperation } from '../../modules/activity/classroom.ts';
import type { openStudioNotion } from './notion.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import type { openMemoryManagement } from './memory-management.ts';
import { browseMcpTools } from '../../executors/teaching/mcp-client.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LifecycleError, type Db } from '../../kernel/src/index.ts';
import { cases, caseId, clientRequest, getSession, recentConversations, RequestError, type openStudio } from './sessions.ts';
import { TextbookConflictError, type openTextbook } from './textbook.ts';
import type { openRelationReview } from './workspace-relation.ts';
import { studioLearner } from './identity.ts';
import type { openLibrary } from './library.ts';
import type { openPractice } from './practice.ts';
import { handleIntakeRequest, readBody, type openIntake } from './intake.ts';
import { parseWorkbookAttachmentMultipart, workbookAttachmentErrorStatus, workbookAttachmentFileLimit } from '../../modules/activity/workbook-attachments.ts';
import type { openCapturePapers } from './capture-papers.ts';
import type { openWorkbook } from './workbook.ts';
import { openTakeaway } from './takeaway.ts';
import { issueGraphQuickPaperResponse } from './graph-quick-paper.ts';
import type { openPracticeAdmission } from './sealed-practice.ts';
import { readWorkbookDisplayAccess } from './workbook-display-access.ts';
import type { openOrganizer } from './organizer.ts';
import type { openMemory } from './memory.ts';
import type { openWorkspaceAccess } from './workspace-access.ts';
import type { openResearch } from './research.ts';
import type { openRetention } from './retention.ts';
import type { openRetentionComparison } from './retention-comparison.ts';
import type { openIqdb } from './iqdb.ts';
import { openTransparency } from './transparency.ts';
import type { openOnboarding } from './onboarding.ts';
import { recallDisplayToken, type RecallHttp } from './recall-http.ts';
import { RecallRequestError } from './recall.ts';
import type { CarePause } from './care-pause.ts';
import { offlineCrisisSupportCard } from '../../executors/teaching/crisis-support.ts';
import { ridingReview } from '../../modules/activity/workbook-views.ts';
import { serveSessionEvents } from './stream.ts';
import { freezeProviderAccount, saveLearnerSettings, publicSettings, loadSettings } from './settings.ts';
import { actOnArtifact } from './presentation-store.ts';

export const ulidPattern = '[0-9A-HJKMNP-TV-Z]{26}';
const ulidExact = new RegExp(`^${ulidPattern}$`);
const patternTypes: Record<string, string> = {
  ':ulid': `(${ulidPattern})`,
  ':slug': '([A-Za-z0-9][A-Za-z0-9_-]{0,79})',
  ':item': '([A-Za-z0-9_.-]{1,128})',
  ':seg': '([^/]+)',
};

export function compilePattern(path: string) {
  const source = path.replaceAll('/', '\\/').replaceAll(/:(ulid|slug|item|seg)/g, token => patternTypes[token]!);
  const regex = new RegExp(`^${source}$`);
  return { regex, match: (value: string) => regex.exec(value)?.slice(1) };
}

type RouteAction = (req: IncomingMessage, res: ServerResponse, params: readonly string[], url: URL) => Promise<void>;
type CompiledRoute = { readonly method: string; readonly match: (path: string) => string[] | undefined; readonly action: RouteAction };

function knownMountIds(query: URLSearchParams) {
  const ids = query.getAll('knownMountIds');
  if (ids.length > 64 || ids.some(id => !ulidExact.test(id)))
    throw new RequestError(400, '作品已见标识无效或过多。');
  return new Set(ids);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function sendJson(response: ServerResponse, status: number, data: unknown) {
  response
    .writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    .end(JSON.stringify(data));
}

async function runAbortable(res: ServerResponse, run: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    const result = await run(controller.signal);
    if (!controller.signal.aborted) sendJson(res, 200, result);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}

const root = fileURLToPath(new URL('../../surfaces/web/dist/', import.meta.url));
const types: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const pages = new Set([
  '/', '/today', '/papers', '/papers/new', '/papers/issued', '/plan', '/notes', '/review', '/intake',
  '/materials', '/materials/workspace', '/textbooks', '/textbooks/page', '/materials/riding',
  '/practice/riding', '/companion', '/me', '/classroom', '/classroom/first45',
]);
const appPageRegex = new RegExp(`^/(?:(?:classroom|papers)/${ulidPattern}(?:/print)?|materials/(?:saved|records)/${ulidPattern})$`);
const readingPathRegex = new RegExp(`^/api/materials/(${ulidPattern})/reading$`);

type StudioDeps = {
  notion: ReturnType<typeof openStudioNotion>;
  textbook: ReturnType<typeof openTextbook>;
  relationReview: ReturnType<typeof openRelationReview>;
  workbook: ReturnType<typeof openWorkbook>;
  takeaways: ReturnType<typeof openTakeaway>;
  practiceAdmission?: ReturnType<typeof openPracticeAdmission>;
  organizer: ReturnType<typeof openOrganizer>;
  memory: ReturnType<typeof openMemory>;
  memoryManagement: ReturnType<typeof openMemoryManagement>;
  intake: ReturnType<typeof openIntake>;
  capturePapers: ReturnType<typeof openCapturePapers>;
  workspace: ReturnType<typeof openWorkspaceAccess>;
  research: ReturnType<typeof openResearch>;
  recall: RecallHttp;
  retention: ReturnType<typeof openRetention>;
  retentionComparison: ReturnType<typeof openRetentionComparison>;
  iqdb: ReturnType<typeof openIqdb>;
  transparency?: ReturnType<typeof openTransparency>;
  carePause: CarePause;
  onboarding?: ReturnType<typeof openOnboarding>;
};

export function serve(
  db: Db,
  studio: Awaited<ReturnType<typeof openStudio>>,
  library: ReturnType<typeof openLibrary>,
  practice: ReturnType<typeof openPractice>,
  student: StudioDeps,
  port: number,
) {
  const transparency = student.transparency ?? openTransparency(db);
  const routes: CompiledRoute[] = [];
  const raw = (method: string, path: string, action: RouteAction) => {
    routes.push({ method, match: compilePattern(path).match, action });
  };
  const get = (path: string, run: (params: readonly string[], url: URL) => Promise<unknown> | unknown) =>
    raw('GET', path, async (_req, res, params, url) => sendJson(res, 200, await run(params, url)));
  const write = (method: 'POST' | 'PUT', path: string,
    run: (input: Record<string, unknown>, params: readonly string[], req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
    status: number | ((result: unknown) => number) = 200) =>
    raw(method, path, async (req, res, params) => {
      const result = await run(await readJsonBody(req), params, req, res);
      sendJson(res, typeof status === 'function' ? status(result) : status, result);
    });
  const post = (path: string,
    run: (input: Record<string, unknown>, params: readonly string[], req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
    status: number | ((result: unknown) => number) = 200) => write('POST', path, run, status);
  const put = (path: string, run: (input: Record<string, unknown>, params: readonly string[]) => Promise<unknown>) =>
    write('PUT', path, run);
  const offline = (path: string, run: (input: Record<string, unknown>, watermark: string, params: readonly string[]) => Promise<unknown>, status = 200) =>
    raw('POST', path, async (req, res, params) => {
      const input = await readJsonBody(req);
      const watermark = submittedWatermark(input);
      const result = await run(input, watermark, params);
      res.setHeader('X-Deletion-Watermark', watermark);
      sendJson(res, status, result);
    });
  const pendingStatus = (result: unknown) => (result as { state?: string }).state === 'pending' ? 202 : 200;
  const requireAdmission = () => {
    if (!student.practiceAdmission) throw new RequestError(404, '这个入口不存在。');
    return student.practiceAdmission;
  };
  const tb = (id: string) => ({ learner: studioLearner, id });

  get('/api/iqdb/questions', () => student.iqdb.questions());
  put('/api/iqdb/questions/:ulid/teaching', (input, [id]) => student.iqdb.setTeaching(id!, input));
  if (student.onboarding) {
    get('/api/onboarding/status', () => student.onboarding!.status());
    post('/api/onboarding/propose', input => student.onboarding!.propose(input));
    post('/api/onboarding/apply', input => student.onboarding!.apply(input));
  }
  get('/api/ai/activity', () => transparency.aiActivity());
  get('/api/knowledge/graph', (_p, url) => transparency.knowledgeGraph(url.searchParams));
  raw('POST', '/api/knowledge/graph/:seg/quick-paper', async (req, res, [id]) => {
    const result = await issueGraphQuickPaperResponse(db, student.workbook, id!, await readJsonBody(req));
    sendJson(res, result.status, result.body);
  });
  get('/api/memory/overview', () => transparency.memoryOverview());
  get('/api/care/support', async () => ({ card: offlineCrisisSupportCard, pause: await student.carePause.read() }));
  raw('POST', '/api/care/pause/resume', async (_req, res) => sendJson(res, 200, { pause: await student.carePause.resume() }));
  raw('DELETE', '/api/care/pause', async (_req, res) => sendJson(res, 200, { pause: await student.carePause.resume() }));
  offline('/api/iqdb/proposals', (input, wm) => student.iqdb.proposals(input, wm), 201);
  offline('/api/iqdb/papers', (input, wm) => student.iqdb.papers(input, wm), 201);
  get('/api/notion/settings', () => student.notion.settings());
  offline('/api/notion/selections/(grant|revoke|sync)', (input, _wm, [action]) => student.notion.mutate(action!, input));
  offline('/api/notion/sources/:ulid/(purpose|retract)', (input, _wm, [id, action]) => student.notion.mutate(action!, input, id!));
  raw('GET', '/api/notion/sources/:ulid', (_req, res, [id], url) => student.notion.read(id!, url.searchParams.get('view'), data => sendJson(res, 200, data)));
  get('/api/workspace/access', (_p, url) => student.workspace.list(url.searchParams));
  get('/api/workspace/records/:ulid/flow', ([id]) => student.workspace.flow(id!));
  get('/api/workspace/access/providers', () => student.workspace.providers());
  get('/api/workspace/access/records/:ulid', ([id], url) => student.workspace.record(id!, url.searchParams));
  put('/api/workspace/access/records/:ulid', (input, [id]) => student.workspace.setTeaching(id!, input));
  post('/api/workspace/observations/:ulid/undo', (input, [id]) => student.workspace.undoObservation(id!, input));
  get('/api/workspace/relations/proposals/:ulid', ([id]) => student.relationReview.proposal(id!));
  post('/api/workspace/relations/proposals/:ulid', ({ decision }, [id]) => {
    if (decision === 'accept') return student.relationReview.accept(id!);
    if (decision === 'reject') return student.relationReview.reject(id!);
    throw new RequestError(400, '请选择采纳或拒绝此提议。');
  });
  post('/api/workspace/relations/:ulid/undo', (input, [id]) => student.relationReview.undo(id!, input));
  put('/api/workspace/access/providers/:slug', (input, [id]) => student.workspace.setProvider(id!, input));
  get('/api/research/settings', () => student.research.read());
  put('/api/research/settings', input => student.research.configure(input));
  get('/api/papers/:ulid/attempts/:ulid/research-permission', ([paperId, attemptId]) => student.research.permission(paperId!, attemptId!));
  put('/api/papers/:ulid/attempts/:ulid/research-permission', (input, [paperId, attemptId]) => student.research.allow(paperId!, attemptId!, input));
  get('/api/papers/:ulid/attempts/:ulid/research', ([paperId, attemptId]) => student.research.worksheet(paperId!, attemptId!));
  get('/api/papers/:ulid/attempts/:ulid/research/:ulid/source', ([paperId, attemptId, id]) => student.research.source(paperId!, attemptId!, id!));
  get('/api/textbooks', () => student.textbook.list({ learner: studioLearner }));
  post('/api/textbooks', ({ requestId, clientEditSeq, page }) => student.textbook.create({ learner: studioLearner, requestId, clientEditSeq, page }), 201);
  offline('/api/textbooks/:ulid/pulse/questions', (input, _wm, [id]) => student.textbook.claim(tb(id!), input));
  get('/api/textbooks/:ulid/proposals', ([id]) => student.textbook.proposals(tb(id!)));
  get('/api/textbooks/:ulid/proposals/:ulid', ([id, proposalId]) => student.textbook.proposal(tb(id!), proposalId!));
  post('/api/textbooks/:ulid/proposals/:ulid', ({ blockIds }, [id, proposalId]) => student.textbook.proposal(tb(id!), proposalId!, { blockIds }));
  post('/api/textbooks/:ulid/undo', ({ undo_token }, [id]) => student.textbook.undo(tb(id!), undo_token));
  get('/api/textbooks/:ulid', ([id], url) => {
    const rev = url.searchParams.has('rev') ? Number(url.searchParams.get('rev')) : undefined;
    if (rev !== undefined && (!Number.isInteger(rev) || rev < 1 || rev > 2147483647)) throw new RequestError(400, '教材版本无效。');
    return student.textbook.get({ ...tb(id!), rev });
  });
  post('/api/textbooks/:ulid', ({ requestId, clientEditSeq, expectedRev, edits }, [id]) =>
    student.textbook.revise({ ...tb(id!), requestId, expectedRev, clientEditSeq, edits }));
  get('/api/capture/papers', () => student.capturePapers.list());
  post('/api/capture/papers/(issue|collect|reprint|displayed)', (input, [op]) =>
    student.capturePapers[op as 'issue' | 'collect' | 'reprint' | 'displayed'](input));
  get('/api/papers', () => student.workbook.list());
  post('/api/papers', input => student.workbook.save(input), 201);
  offline('/api/papers/sealed-practice', (input, wm) => requireAdmission().admit(input, wm), 201);
  get('/api/papers/sealed-practice/:ulid/teaching', ([id]) => requireAdmission().getTeaching(id!));
  put('/api/papers/sealed-practice/:ulid/teaching', (input, [id]) => requireAdmission().teaching(id!, input));
  get('/api/papers/:ulid/attempts/:ulid/answer-displays', ([paperId, attemptId], url) =>
    readWorkbookDisplayAccess(db, paperId!, attemptId!, url.searchParams.get('after')));
  get('/api/retention/posttests', (_p, url) => student.retention.listPosttests(url.searchParams.get('forecastKey')));
  post('/api/retention/papers', input => student.retention.savePosttestPaper(input), 201);
  post('/api/retention/:ulid/posttest', (input, [id]) => student.retention.startPosttest(id!, input));
  post('/api/retention/:ulid/posttest/:ulid/submission', (input, [id, posttestId]) => student.retention.submitPosttest(id!, posttestId!, input));
  post('/api/papers/:ulid/retention', (input, [id]) => student.retention.freeze(id!, input), pendingStatus);
  get('/api/retention/:ulid/research', ([id]) => student.research.retentionReview(id!));
  put('/api/retention/:ulid/research', (input, [id]) => student.research.allowRetentionReview(id!, input));
  post('/api/retention/comparisons', input => student.retentionComparison.start(input), pendingStatus);
  get('/api/retention/comparisons/:ulid', ([id]) => student.retentionComparison.get(id!));
  get('/api/retention/:ulid', ([id]) => student.retention.get(id!));
  post('/api/retention/:ulid/(reconcile|followup)', (input, [id, action]) =>
    action === 'followup' ? student.retention.scheduleFollowup(id!, input) : student.retention.reconcile(id!, input), pendingStatus);
  post('/api/papers/:ulid/attempts/:ulid/assessments', (input, [paperId, attemptId]) => student.workbook.assess(paperId!, attemptId!, input));
  offline('/api/papers/:ulid/attempts/:ulid/corrections', (input, wm, [paperId, attemptId]) => student.workbook.correct(paperId!, attemptId!, input, wm));
  offline('/api/papers/:ulid/takeaways', (input, _wm, [id]) => student.takeaways.mutate(id!, undefined, 'save', input));
  offline('/api/papers/:ulid/takeaways/(open|display|undo)', (input, _wm, [id, action]) =>
    student.takeaways.mutate(id!, undefined, action as 'open' | 'display' | 'undo', input));
  offline('/api/papers/:ulid/attempts/:ulid/takeaways', (input, _wm, [paperId, attemptId]) => student.takeaways.mutate(paperId!, attemptId!, 'save', input));
  offline('/api/papers/:ulid/attempts/:ulid/takeaways/(open|display|undo)', (input, _wm, [paperId, attemptId, action]) =>
    student.takeaways.mutate(paperId!, attemptId!, action as 'open' | 'display' | 'undo', input));
  get('/api/papers/:ulid/attempts/:ulid/takeaways/:item', ([paperId, attemptId, itemId]) => student.takeaways.read(paperId!, attemptId!, itemId!));
  get('/api/papers/:ulid', ([id]) => student.workbook.get(id!));
  get('/api/papers/:ulid/print', ([id]) => student.workbook.sheet(id!));
  get('/api/papers/:ulid/pre-submit-pitfalls', ([id]) => student.workbook.preSubmitPitfalls(id!));
  offline('/api/papers/:ulid/attempts', (input, _wm, [id]) => student.workbook.submit(id!, input));
  raw('POST', '/api/papers/:ulid/attachments', async (req, res, [id]) => {
    const rawWatermark = typeof req.headers['x-deletion-watermark'] === 'string' ? req.headers['x-deletion-watermark'] : undefined;
    const upload = await parseWorkbookAttachmentMultipart(await readBody(req, workbookAttachmentFileLimit + 256 * 1024), req.headers['content-type'], rawWatermark)
      .catch(error => { const status = workbookAttachmentErrorStatus(error); if (status) throw new RequestError(status, (error as Error).message); throw error; });
    const { receipt, watermark } = await student.workbook.uploadAttachment(id!, { ...upload, bytes: Buffer.from(upload.bytes) });
    res.setHeader('X-Deletion-Watermark', watermark);
    sendJson(res, 201, receipt);
  });
  raw('GET', '/api/papers/:ulid/reading-context', (_req, res, [id], url) =>
    runAbortable(res, signal => student.workbook.readingLabels(id!, url.searchParams, signal)));
  raw('POST', '/api/papers/:ulid/reading-context', async (req, res, [id]) => {
    const input = await readJsonBody(req);
    await runAbortable(res, signal => student.workbook.readingContext(id!, input, signal));
  });
  post('/api/papers/:ulid/presentation', (input, [id]) => student.workbook.recordPresentation(id!, input));
  get('/api/review', async () => {
    const [mine, riding] = await Promise.all([student.workbook.review(), practice.read()]);
    return [...mine, ...ridingReview(riding)];
  });
  get('/api/today', (_p, url) => student.organizer.today(url.searchParams));
  get('/api/today/open', (_p, url) => student.organizer.open(url.searchParams));
  post('/api/today/rules', input => student.organizer.rule(input));
  post('/api/today/goal', input => student.organizer.goal(input));
  offline('/api/today/submit', input => student.organizer.submit(input));
  get('/api/organizer/index', async () => {
    const { tasks, notes } = await student.organizer.snapshot(false);
    return { tasks, notes: notes.map(({ id, title }) => ({ id, title })) };
  });
  get('/api/organizer', () => student.organizer.snapshot());
  post('/api/organizer/tasks', input => student.organizer.task(input));
  post('/api/organizer/notes', input => student.organizer.note(input));
  get('/api/memory/claims', (_p, url) => student.memoryManagement.list(url.searchParams.get('before')));
  post('/api/memory/claims/sources/:ulid/revoke', (input, [id]) => student.memoryManagement.revokeSource(id!, input));
  post('/api/memory/claims/:ulid', (input, [id]) => student.memoryManagement.manage(id!, input));
  post('/api/memory/claims/:ulid/undo', (input, [id]) => student.memoryManagement.undo(id!, input));
  get('/api/memory', () => student.memory.read());
  post('/api/memory', input => student.memory.save(input));
  get('/api/cases', () => ({ cases }));
  get('/api/workspace', () => library.snapshot());
  get('/api/conversations', () => recentConversations(db));
  offline('/api/materials', ({ requestId, title, text }, wm) => library.capture({ requestId, title, text }, wm), 201);
  post('/api/goal', ({ requestId, text }) => library.setGoal({ requestId, text }));
  get('/api/practice/riding', () => practice.read());
  offline('/api/practice/riding', input => practice.submit(input));
  get('/api/settings', async () => publicSettings((await db.tx({ learner: studioLearner }, tx => freezeProviderAccount(tx))).settings));
  post('/api/settings/mcp-tools', async input => {
    if (typeof input.id !== 'string' || typeof input.url !== 'string' ||
        (input.token !== undefined && typeof input.token !== 'string')) throw new RequestError(400, 'MCP 地址或凭据无效。');
    const saved = (await loadSettings()).mcpServers.find(item => item.id === input.id && item.url === input.url);
    const token = input.token === undefined ? saved?.token : input.token;
    try { return await browseMcpTools({ id: input.id, url: input.url, allowedTools: [], ...(token ? { token } : {}) }); }
    catch { throw new RequestError(422, '无法读取 MCP 工具。请核对 Streamable HTTP 地址和访问令牌。'); }
  });
  put('/api/settings', async input => {
    try { return await saveLearnerSettings(db, input); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '设置无效。'); }
  });
  get('/api/classrooms', (_p, url) => {
    if (url.searchParams.get('status') === 'active') return studio.classrooms.listActive();
    throw new RequestError(404, '这个入口不存在。');
  });
  post('/api/classrooms', input => studio.classrooms.start(input), 202);
  post('/api/sessions', input => studio.start(
    caseId(input.caseId), clientRequest(input.requestId), input.question, input.attachment,
    input.mcpGrants, input.route, input.currentObject, input.allowBackgroundUnderstanding), 202);
  post('/api/sessions/:ulid/artifact-actions', (input, [id]) => actOnArtifact(db, id!, input));
  raw('GET', '/api/sessions/:ulid/events', (_req, res, [id], url) =>
    serveSessionEvents(db, id!, url.searchParams.get('watchMounts') === '1', res, student.recall.project, knownMountIds(url.searchParams)));
  get('/api/sessions/:ulid/recall/state', ([id], url) => student.recall.readState(id!, url.searchParams));
  raw('POST', '/api/sessions/:ulid/recall/reveal', async (req, res, [id]) => {
    const { data, token } = await student.recall.reveal(id!, await readJsonBody(req));
    res.setHeader(recallDisplayToken, token);
    sendJson(res, 200, data);
  });
  post('/api/sessions/:ulid/recall/display', (input, [id], req) => student.recall.display(id!, input, req.headers));
  post('/api/sessions/:ulid/recall/submit', (input, [id]) => student.recall.submit(id!, input));
  get('/api/sessions/:ulid', ([id], url) => getSession(db, id!, student.recall.project, knownMountIds(url.searchParams)));
  post('/api/sessions/:ulid/answers', (input, [id]) => studio.answer(
    id!, input.parentId, input.answer, clientRequest(input.requestId), input.mcpGrants, input.route,
    input.currentObject, input.allowBackgroundUnderstanding), 202);

  const extraHosts = new Set(
    (process.env.MANGEKYO_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
  );
  const hosts = new Set([...['localhost', '127.0.0.1', '[::1]'].map(host => host + ':' + port), ...extraHosts]);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    try {
      const host = req.headers.host?.toLowerCase();
      const origin = req.headers.origin?.toLowerCase();
      const allowedOrigin = !origin || origin === 'http://' + host || (Boolean(host) && extraHosts.has(host!) && origin === 'https://' + host);
      if (!host || !hosts.has(host) || !allowedOrigin)
        throw new RequestError(403, '此入口仅供本机页面使用。');
      const url = new URL(req.url ?? '/', 'http://' + host);
      const path = url.pathname;
      const method = req.method;
      const crossSiteNav = method === 'GET' && path !== '/api' && !path.startsWith('/api/') &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !crossSiteNav)
        throw new RequestError(403, '此入口仅供本机页面使用。');

      const reading = method === 'GET' ? readingPathRegex.exec(path) : null;
      if (reading?.[1]) return sendJson(res, 200, await library.reading(reading[1]));
      if (await handleIntakeRequest(student.intake, req, res, path, method, student.capturePapers, student.workbook)) return;

      const room = classroomPath.exec(path);
      if (room?.[1]) {
        const [, id, op] = room;
        if (!op && method === 'GET') return sendJson(res, 200, await studio.classrooms.get(classroomFactId(id)));
        if (op === 'print' && method === 'GET') return sendJson(res, 200, await studio.classrooms.print(classroomFactId(id)));
        if (op && op !== 'print' && method === 'POST')
          return sendJson(res, 200, await studio.classrooms.mutate(classroomFactId(id), op as ClassroomOperation, await readJsonBody(req)));
      }

      for (const entry of routes) {
        if (entry.method !== method) continue;
        const params = entry.match(path);
        if (params) return await entry.action(req, res, params, url);
      }

      if (method !== 'GET' || path.startsWith('/api/')) throw new RequestError(404, '这个入口不存在。');
      const file = resolve(root, '.' + decodeURIComponent(pages.has(path) || appPageRegex.test(path) ? '/index.html' : path));
      if (!file.startsWith(resolve(root) + sep) || !types[extname(file)]) throw new RequestError(404, '找不到页面。');
      const bytes = await readFile(file).catch(() => { throw new RequestError(404, '找不到页面，请先构建界面。'); });
      res.writeHead(200, { 'Content-Type': types[extname(file)]! }).end(bytes);
    } catch (error) {
      if (error instanceof TextbookConflictError) return sendJson(res, 409, error.toJSON());
      if (error instanceof LifecycleError) return sendJson(res, error.status, { error: error.message, code: error.code });
      const expected = error instanceof RequestError || error instanceof RecallRequestError;
      if (!expected) console.error('studio request failed', error instanceof Error ? error.name : 'error');
      sendJson(res, expected ? error.status : 500, {
        error: expected ? error.message : '服务未能完成请求。',
        ...(error instanceof RequestError && error.responseCode ? { code: error.responseCode } : {}),
      });
    }
  });
  // Long synchronous model turns can exceed the Node 5s default keep-alive
  // window; keep reused connections open across them and require the header
  // timeout to stay strictly above the keep-alive timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
