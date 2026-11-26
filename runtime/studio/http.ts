import { factId as classroomFactId } from './classroom.ts';
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
import { studioLearner, ulidExact, ulidPattern } from './identity.ts';
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
import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { ridingReview } from '../../modules/activity/workbook-views.ts';
import { serveSessionEvents } from './stream.ts';
import { freezeProviderAccount, saveLearnerSettings, publicSettings, loadSettings } from './settings.ts';
import { actOnArtifact } from './presentation-store.ts';
import type { openKnowledgeMaintenance } from './research-maintenance.ts';
import { compilePattern, createStudioRouteKit, readJsonBody, runAbortable, sendJson, type RoutePack } from './endpoint-kit.ts';
export { ulidPattern };
export { compilePattern };
function knownMountIds(query: URLSearchParams) {
  const ids = query.getAll('knownMountIds');
  if (ids.length > 64 || ids.some(id => !ulidExact.test(id))) throw new RequestError(400, '作品已见标识无效或过多。');
  return new Set(ids);
}
export { readJsonBody, sendJson };
const root = fileURLToPath(new URL('../../surfaces/web/dist/', import.meta.url));
const types: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const pages = new Set([
  '/', '/today', '/onboarding', '/papers', '/papers/new', '/papers/issued', '/plan', '/notes', '/review', '/intake', '/materials',
  '/materials/workspace', '/textbooks', '/textbooks/page', '/materials/riding', '/practice/riding', '/companion', '/me', '/classroom',
  '/classroom/first45',
]);
const appPageRegex = new RegExp(`^/(?:(?:classroom|papers)/${ulidPattern}(?:/print)?|materials/(?:saved|records)/${ulidPattern})$`);
const readingPathRegex = new RegExp(`^/api/materials/(${ulidPattern})/reading$`);
type StudioDeps = {
  notion: ReturnType<typeof openStudioNotion>; textbook: ReturnType<typeof openTextbook>;
  relationReview: ReturnType<typeof openRelationReview>; workbook: ReturnType<typeof openWorkbook>;
  takeaways: ReturnType<typeof openTakeaway>; practiceAdmission?: ReturnType<typeof openPracticeAdmission>;
  organizer: ReturnType<typeof openOrganizer>; memory: ReturnType<typeof openMemory>;
  memoryManagement: ReturnType<typeof openMemoryManagement>; intake: ReturnType<typeof openIntake>;
  capturePapers: ReturnType<typeof openCapturePapers>; workspace: ReturnType<typeof openWorkspaceAccess>;
  research: ReturnType<typeof openResearch>; recall: RecallHttp; retention: ReturnType<typeof openRetention>;
  retentionComparison: ReturnType<typeof openRetentionComparison>; iqdb: ReturnType<typeof openIqdb>;
  transparency?: ReturnType<typeof openTransparency>; carePause: CarePause;
  onboarding?: ReturnType<typeof openOnboarding>; maintenance?: ReturnType<typeof openKnowledgeMaintenance>;
  pythonHost?: PythonDeriverHost;
  /** Optional declarative route packs mounted after the built-in routes (see endpoint-kit.ts). */
  routePacks?: readonly RoutePack[];
};
export function serve(
  db: Db, studio: Awaited<ReturnType<typeof openStudio>>, library: ReturnType<typeof openLibrary>,
  practice: ReturnType<typeof openPractice>, student: StudioDeps, port: number,
) {
  const transparency = student.transparency ?? openTransparency(db);
  const kit = createStudioRouteKit([]);
  const { routes, raw, json, get, post, put, offline, pendingStatus, getOne, putOne, postOne } = kit;
  const requireAdmission = () => { if (!student.practiceAdmission) throw new RequestError(404, '这个入口不存在。'); return student.practiceAdmission; };
  const tb = (id: string) => ({ learner: studioLearner, id });
  const { notion, textbook, relationReview, workbook, takeaways, organizer, memory, memoryManagement,
    capturePapers, workspace, research, recall, retention, retentionComparison, iqdb, carePause } = student;
  get('/api/iqdb/questions', () => iqdb.questions());
  raw('POST', '/api/iqdb/author', async (req, res) => {
    const input = await readJsonBody(req); await runAbortable(res, s => iqdb.author(input, s), 201);
  });
  putOne('/api/iqdb/questions/:ulid/teaching', (id, input) => iqdb.setTeaching(id, input));
  const ob = student.onboarding;
  if (ob) {
    get('/api/onboarding/status', () => ob.status());
    post('/api/onboarding/propose', input => ob.propose(input));
    raw('POST', '/api/onboarding/propose/stream', async (req, res) => ob.proposeStream(await readJsonBody(req), req, res));
    post('/api/onboarding/apply', input => ob.apply(input));
  }
  get('/api/ai/activity', () => transparency.aiActivity());
  get('/api/knowledge/graph', (_p, url) => transparency.knowledgeGraph(url.searchParams));
  raw('POST', '/api/knowledge/graph/:seg/quick-paper', async (req, res, [id]) => {
    const r = await issueGraphQuickPaperResponse(db, workbook, id!, await readJsonBody(req), student.pythonHost);
    sendJson(res, r.status, r.body);
  });
  get('/api/memory/overview', () => transparency.memoryOverview());
  get('/api/care/support', async () => ({ card: offlineCrisisSupportCard, pause: await carePause.read() }));
  const resumePause = async () => ({ pause: await carePause.resume() });
  json('POST', '/api/care/pause/resume', resumePause);
  json('DELETE', '/api/care/pause', resumePause);
  offline('/api/iqdb/proposals', (input, wm) => iqdb.proposals(input, wm), 201);
  offline('/api/iqdb/papers', (input, wm) => iqdb.papers(input, wm), 201);
  get('/api/notion/settings', () => notion.settings());
  offline('/api/notion/selections/(grant|revoke|sync)', (input, _wm, [action]) => notion.mutate(action!, input));
  offline('/api/notion/sources/:ulid/(purpose|retract)', (input, _wm, [id, action]) => notion.mutate(action!, input, id!));
  raw('GET', '/api/notion/sources/:ulid', (_req, res, [id], url) => notion.read(id!, url.searchParams.get('view'), d => sendJson(res, 200, d)));
  get('/api/workspace/access', (_p, url) => workspace.list(url.searchParams));
  getOne('/api/workspace/records/:ulid/flow', id => workspace.flow(id));
  get('/api/workspace/access/providers', () => workspace.providers());
  get('/api/workspace/access/records/:ulid', ([id], url) => workspace.record(id!, url.searchParams));
  putOne('/api/workspace/access/records/:ulid', (id, input) => workspace.setTeaching(id, input));
  postOne('/api/workspace/observations/:ulid/undo', (id, input) => workspace.undoObservation(id, input));
  getOne('/api/workspace/relations/proposals/:ulid', id => relationReview.proposal(id));
  postOne('/api/workspace/relations/proposals/:ulid', (id, { decision }) => decision === 'accept'
    ? relationReview.accept(id) : decision === 'reject' ? relationReview.reject(id) : (() => { throw new RequestError(400, '请选择采纳或拒绝此提议。'); })());
  postOne('/api/workspace/relations/:ulid/undo', (id, input) => relationReview.undo(id, input));
  putOne('/api/workspace/access/providers/:slug', (id, input) => workspace.setProvider(id, input));
  get('/api/research/settings', () => research.read());
  put('/api/research/settings', input => research.configure(input));
  if (student.maintenance) json('POST', '/api/research/maintenance/run', () => student.maintenance!.run({ force: true }));
  get('/api/papers/:ulid/attempts/:ulid/research-permission', ([paperId, attemptId]) => research.permission(paperId!, attemptId!));
  put('/api/papers/:ulid/attempts/:ulid/research-permission', (input, [paperId, attemptId]) => research.allow(paperId!, attemptId!, input));
  get('/api/papers/:ulid/attempts/:ulid/research', ([paperId, attemptId]) => research.worksheet(paperId!, attemptId!));
  get('/api/papers/:ulid/attempts/:ulid/research/:ulid/source', ([paperId, attemptId, id]) => research.source(paperId!, attemptId!, id!));
  get('/api/textbooks', () => textbook.list({ learner: studioLearner }));
  raw('POST', '/api/textbooks/generate', async (req, res) => {
    const input = await readJsonBody(req); await runAbortable(res, s => textbook.generate({ ...input, learner: studioLearner }, s), 201);
  });
  post('/api/textbooks', ({ requestId, clientEditSeq, page }) => textbook.create({ learner: studioLearner, requestId, clientEditSeq, page }), 201);
  offline('/api/textbooks/:ulid/pulse/questions', (input, _wm, [id]) => textbook.claim(tb(id!), input));
  getOne('/api/textbooks/:ulid/proposals', id => textbook.proposals(tb(id)));
  get('/api/textbooks/:ulid/proposals/:ulid', ([id, proposalId]) => textbook.proposal(tb(id!), proposalId!));
  post('/api/textbooks/:ulid/proposals/:ulid', ({ blockIds }, [id, proposalId]) => textbook.proposal(tb(id!), proposalId!, { blockIds }));
  postOne('/api/textbooks/:ulid/undo', (id, { undo_token }) => textbook.undo(tb(id), undo_token));
  get('/api/textbooks/:ulid', ([id], url) => {
    const rev = url.searchParams.has('rev') ? Number(url.searchParams.get('rev')) : undefined;
    if (rev !== undefined && (!Number.isInteger(rev) || rev < 1 || rev > 2147483647)) throw new RequestError(400, '教材版本无效。');
    return textbook.get({ ...tb(id!), rev });
  });
  postOne('/api/textbooks/:ulid', (id, { requestId, clientEditSeq, expectedRev, edits }) =>
    textbook.revise({ ...tb(id), requestId, expectedRev, clientEditSeq, edits }));
  get('/api/capture/papers', () => capturePapers.list());
  post('/api/capture/papers/(issue|collect|reprint|displayed)', (input, [op]) =>
    capturePapers[op as 'issue' | 'collect' | 'reprint' | 'displayed'](input));
  get('/api/papers', () => workbook.list());
  post('/api/papers', input => workbook.save(input), 201);
  offline('/api/papers/sealed-practice', (input, wm) => requireAdmission().admit(input, wm), 201);
  getOne('/api/papers/sealed-practice/:ulid/teaching', id => requireAdmission().getTeaching(id));
  putOne('/api/papers/sealed-practice/:ulid/teaching', (id, input) => requireAdmission().teaching(id, input));
  get('/api/papers/:ulid/attempts/:ulid/answer-displays', ([p, a], url) =>
    readWorkbookDisplayAccess(db, p!, a!, url.searchParams.get('after')));
  get('/api/retention/posttests', (_p, url) => retention.listPosttests(url.searchParams.get('forecastKey')));
  post('/api/retention/papers', input => retention.savePosttestPaper(input), 201);
  postOne('/api/retention/:ulid/posttest', (id, input) => retention.startPosttest(id, input));
  post('/api/retention/:ulid/posttest/:ulid/submission', (input, [id, posttestId]) => retention.submitPosttest(id!, posttestId!, input));
  postOne('/api/papers/:ulid/retention', (id, input) => retention.freeze(id, input), pendingStatus);
  getOne('/api/retention/:ulid/research', id => research.retentionReview(id));
  putOne('/api/retention/:ulid/research', (id, input) => research.allowRetentionReview(id, input));
  post('/api/retention/comparisons', input => retentionComparison.start(input), pendingStatus);
  getOne('/api/retention/comparisons/:ulid', id => retentionComparison.get(id));
  getOne('/api/retention/:ulid', id => retention.get(id));
  post('/api/retention/:ulid/(reconcile|followup)', (input, [id, action]) =>
    action === 'followup' ? retention.scheduleFollowup(id!, input) : retention.reconcile(id!, input), pendingStatus);
  post('/api/papers/:ulid/attempts/:ulid/assessments', (input, [p, a]) => workbook.assess(p!, a!, input));
  offline('/api/papers/:ulid/attempts/:ulid/corrections', (input, wm, [p, a]) => workbook.correct(p!, a!, input, wm));
  offline('/api/papers/:ulid(?:/attempts/:ulid)?/takeaways(?:/(open|display|undo))?', (input, _wm, [p, a, action]) =>
    takeaways.mutate(p!, a, (action ?? 'save') as 'save' | 'open' | 'display' | 'undo', input));
  get('/api/papers/:ulid/attempts/:ulid/takeaways/:item', ([paperId, attemptId, itemId]) => takeaways.read(paperId!, attemptId!, itemId!));
  get('/api/papers/:ulid(?:/(print|pre-submit-pitfalls))?', ([id, op]) =>
    op === 'print' ? workbook.sheet(id!) : op ? workbook.preSubmitPitfalls(id!) : workbook.get(id!));
  offline('/api/papers/:ulid/attempts', (input, _wm, [id]) => workbook.submit(id!, input));
  raw('POST', '/api/papers/:ulid/attachments', async (req, res, [id]) => {
    const rawWatermark = typeof req.headers['x-deletion-watermark'] === 'string' ? req.headers['x-deletion-watermark'] : undefined;
    const upload = await parseWorkbookAttachmentMultipart(
      await readBody(req, workbookAttachmentFileLimit + 256 * 1024), req.headers['content-type'], rawWatermark,
    ).catch(e => { const s = workbookAttachmentErrorStatus(e); if (s) throw new RequestError(s, (e as Error).message); throw e; });
    const { receipt, watermark } = await workbook.uploadAttachment(id!, { ...upload, bytes: Buffer.from(upload.bytes) });
    res.setHeader('X-Deletion-Watermark', watermark);
    sendJson(res, 201, receipt);
  });
  raw('GET', '/api/papers/:ulid/reading-context', (_req, res, [id], url) => runAbortable(res, s => workbook.readingLabels(id!, url.searchParams, s)));
  raw('POST', '/api/papers/:ulid/reading-context', async (req, res, [id]) => {
    const input = await readJsonBody(req);
    await runAbortable(res, s => workbook.readingContext(id!, input, s));
  });
  postOne('/api/papers/:ulid/presentation', (id, input) => workbook.recordPresentation(id, input));
  get('/api/review', async () => [...await workbook.review(), ...ridingReview(await practice.read())]);
  get('/api/today', (_p, url) => organizer.today(url.searchParams));
  get('/api/today/open', (_p, url) => organizer.open(url.searchParams));
  post('/api/today/(rules|goal)', (input, [k]) => organizer[k === 'rules' ? 'rule' : 'goal'](input));
  offline('/api/today/submit', input => organizer.submit(input));
  get('/api/organizer/index', async () => {
    const { tasks, notes } = await organizer.snapshot(false);
    return { tasks, notes: notes.map(({ id, title }) => ({ id, title })) };
  });
  get('/api/organizer', () => organizer.snapshot());
  post('/api/organizer/(tasks|notes)', (input, [k]) => organizer[k === 'tasks' ? 'task' : 'note'](input));
  get('/api/memory/claims', (_p, url) => memoryManagement.list(url.searchParams.get('before')));
  postOne('/api/memory/claims/sources/:ulid/revoke', (id, input) => memoryManagement.revokeSource(id, input));
  postOne('/api/memory/claims/:ulid', (id, input) => memoryManagement.manage(id, input));
  postOne('/api/memory/claims/:ulid/undo', (id, input) => memoryManagement.undo(id, input));
  get('/api/memory', () => memory.read());
  post('/api/memory', input => memory.save(input));
  get('/api/cases', () => ({ cases }));
  get('/api/workspace', () => library.snapshot());
  get('/api/conversations', () => recentConversations(db));
  offline('/api/materials', ({ requestId, title, text }, wm) => library.capture({ requestId, title, text }, wm), 201);
  post('/api/goal', ({ requestId, text }) => library.setGoal({ requestId, text }));
  get('/api/practice/riding', () => practice.read());
  offline('/api/practice/riding', input => practice.submit(input));
  get('/api/settings', async () => publicSettings((await db.tx({ learner: studioLearner }, tx => freezeProviderAccount(tx))).settings));
  post('/api/settings/mcp-tools', async input => {
    if (typeof input.id !== 'string' || typeof input.url !== 'string' || (input.token !== undefined && typeof input.token !== 'string'))
      throw new RequestError(400, 'MCP 地址或凭据无效。');
    const saved = (await loadSettings()).mcpServers.find(item => item.id === input.id && item.url === input.url);
    const token = input.token === undefined ? saved?.token : input.token;
    try { return await browseMcpTools({ id: input.id, url: input.url, allowedTools: [], ...(token ? { token } : {}) }); }
    catch { throw new RequestError(422, '无法读取 MCP 工具。请核对 Streamable HTTP 地址和访问令牌。'); }
  });
  put('/api/settings', input => saveLearnerSettings(db, input)
    .catch(error => { throw new RequestError(400, error instanceof Error ? error.message : '设置无效。'); }));
  get('/api/classrooms', (_p, url) => {
    if (url.searchParams.get('status') === 'active') return studio.classrooms.listActive();
    throw new RequestError(404, '这个入口不存在。');
  });
  post('/api/classrooms', input => studio.classrooms.start(input), 202);
  getOne('/api/classrooms/:ulid', id => studio.classrooms.get(classroomFactId(id)));
  getOne('/api/classrooms/:ulid/print', id => studio.classrooms.print(classroomFactId(id)));
  post('/api/classrooms/:ulid/(adjust|advance|skip|finish|archive)', (input, [id, op]) =>
    studio.classrooms.mutate(classroomFactId(id!), op as ClassroomOperation, input));
  const turnTail = (i: Record<string, unknown>) =>
    [clientRequest(i.requestId), i.mcpGrants, i.route, i.currentObject, i.allowBackgroundUnderstanding] as const;
  post('/api/sessions', i => studio.start(caseId(i.caseId), turnTail(i)[0], i.question, i.attachment,
    i.mcpGrants, i.route, i.currentObject, i.allowBackgroundUnderstanding), 202);
  postOne('/api/sessions/:ulid/artifact-actions', (id, input) => actOnArtifact(db, id, input));
  raw('GET', '/api/sessions/:ulid/events', (_req, res, [id], url) =>
    serveSessionEvents(db, id!, url.searchParams.get('watchMounts') === '1', res, recall.project, knownMountIds(url.searchParams)));
  get('/api/sessions/:ulid/recall/state', ([id], url) => recall.readState(id!, url.searchParams));
  post('/api/sessions/:ulid/recall/reveal', async (input, [id], _req, res) => {
    const { data, token } = await recall.reveal(id!, input);
    res.setHeader(recallDisplayToken, token);
    return data;
  });
  post('/api/sessions/:ulid/recall/display', (input, [id], req) => recall.display(id!, input, req.headers));
  postOne('/api/sessions/:ulid/recall/submit', (id, input) => recall.submit(id, input));
  get('/api/sessions/:ulid', ([id], url) => getSession(db, id!, recall.project, knownMountIds(url.searchParams)));
  postOne('/api/sessions/:ulid/answers', (id, i) => studio.answer(id, i.parentId, i.answer, ...turnTail(i)), 202);
  for (const pack of student.routePacks ?? []) pack(kit);
  const extraHosts = new Set((process.env.MANGEKYO_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
  const hosts = new Set([...['localhost', '127.0.0.1', '[::1]'].map(host => host + ':' + port), ...extraHosts]);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    try {
      const host = req.headers.host?.toLowerCase(), origin = req.headers.origin?.toLowerCase();
      const allowedOrigin = !origin || origin === 'http://' + host || (Boolean(host) && extraHosts.has(host!) && origin === 'https://' + host);
      if (!host || !hosts.has(host) || !allowedOrigin) throw new RequestError(403, '此入口仅供本机页面使用。');
      const url = new URL(req.url ?? '/', 'http://' + host), path = url.pathname, method = req.method;
      const crossSiteNav = method === 'GET' && path !== '/api' && !path.startsWith('/api/') &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !crossSiteNav) throw new RequestError(403, '此入口仅供本机页面使用。');
      const reading = method === 'GET' ? readingPathRegex.exec(path) : null;
      if (reading?.[1]) return sendJson(res, 200, await library.reading(reading[1]));
      if (await handleIntakeRequest(student.intake, req, res, path, method, student.capturePapers, student.workbook)) return;
      for (const entry of routes) if (entry.method === method) {
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
        ...(error instanceof RequestError && error.responseCode === 'model_unavailable' ? { next: 'settings' } : {}),
      });
    }
  });
  // Long synchronous model turns can exceed the Node 5s default keep-alive window;
  // keep reused connections open across them with headersTimeout strictly higher.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
