const WAVES = ['w1', 'w2', 'w3', 'w4', 'w5'];
const HTML_PATHS = ['/today', '/materials', '/companion', '/me'];
const LEAK_KEYS = new Set(['answer', 'solution', 'rubric']);
const BAD_HTML = /cannot get|error overlay|vite-error-overlay|failed to resolve import|internal server error|enoent/i;
const usage = `用法: node scripts/acceptance/studio/wave-vertical-smoke.mjs [选项]

  --base-url <url>       Studio 地址，或 MANGEKYO_STUDIO_URL，默认 http://127.0.0.1:3000
  --wave <w1|w2|w3|w4|w5> 目标波次，默认 w1，逐级启用此前波次探针
  --timeout-ms <ms>      单次请求超时，默认 10000
  -h, --help             显示本说明

波次范围: w1 四处页面、六个只读 JSON API 与题面防剧透，w2 题库出题路由，
w3 今天/记忆增量与错题回溯，w4 园艺待审箱，w5 学法模板与课堂列表。`;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function submitted(value) {
  return record(value) && (['submitted', 'graded', 'completed'].includes(String(value.status).toLowerCase()) ||
    (Array.isArray(value.attempts) && value.attempts.length > 0));
}
function leakPaths(value, path = '') {
  if (value === null || typeof value !== 'object' || submitted(value)) return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (LEAK_KEYS.has(key.toLowerCase())) found.push(childPath);
    found.push(...leakPaths(child, Array.isArray(value) ? `${path}[${key}]` : childPath));
  }
  return found;
}
function listFrom(body) {
  if (Array.isArray(body)) return body;
  if (!record(body)) return null;
  for (const key of ['papers', 'items', 'data']) if (Array.isArray(body[key])) return body[key];
  return null;
}
function parseArgs(args) {
  const out = { baseUrl: process.env.MANGEKYO_STUDIO_URL || 'http://127.0.0.1:3000', wave: 'w1', timeoutMs: 10000 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i], next = () => args[++i];
    if (arg === '-h' || arg === '--help') return { help: true };
    const [key, inline] = arg.split('=', 2);
    if (key === '--base-url') out.baseUrl = inline ?? next();
    else if (key === '--wave') out.wave = inline ?? next();
    else if (key === '--timeout-ms') out.timeoutMs = Number(inline ?? next());
    else throw new Error(`未知参数: ${arg}`);
  }
  let url;
  try { url = new URL(out.baseUrl); } catch { throw new Error('base URL 不是合法 URL。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base URL 只允许 http 或 https。');
  if (!WAVES.includes(out.wave)) throw new Error(`wave 必须是 ${WAVES.join('|')}。`);
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1) throw new Error('timeout-ms 必须是正整数。');
  out.baseUrl = url.toString().replace(/\/$/, '');
  return out;
}
function failure(message, response) {
  const error = new Error(message);
  if (response) Object.assign(error, { status: response.status, elapsed: response.elapsed });
  return error;
}
async function request(ctx, path, init = {}) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(ctx.baseUrl + path, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (error) { throw failure(error.name === 'TimeoutError' ? '请求超时' : `连接失败: ${error.message}`); }
  const text = await response.text();
  const result = { status: response.status, elapsed: Date.now() - started, text, type: response.headers.get('content-type') || '' };
  try { result.body = text ? JSON.parse(text) : undefined; } catch { result.body = undefined; }
  return result;
}
async function json(ctx, path, init = {}) {
  const result = await request(ctx, path, init);
  if (result.body === null || (typeof result.body !== 'object')) throw failure('响应不是合法 JSON 对象或数组', result);
  return result;
}
function okJson(result, name, shape = () => true) {
  if (result.status !== 200) throw failure(`HTTP ${result.status}`, result);
  if (!shape(result.body)) throw failure(`${name} JSON 顶层结构不符`, result);
  return result;
}
function hasAny(body, keys) { return keys.some(key => Object.prototype.hasOwnProperty.call(body, key)); }
async function papersProbe(ctx) {
  const result = okJson(await json(ctx, '/api/papers'), '/api/papers', body => Boolean(listFrom(body)));
  const papers = listFrom(result.body);
  ctx.paperSummaries = papers;
  const pending = papers.find(paper => record(paper) && !submitted(paper) && paper.attemptCount !== undefined ? paper.attemptCount === 0 : record(paper) && !submitted(paper));
  if (pending?.id) {
    const detail = okJson(await json(ctx, `/api/papers/${encodeURIComponent(pending.id)}`), '未交卷试卷');
    ctx.details.set(String(pending.id), detail.body);
    const leaks = leakPaths(detail.body);
    if (leaks.length) throw failure(`未交卷题面泄漏 ${leaks[0]}`, result);
  }
  const leaks = leakPaths(result.body);
  if (leaks.length) throw failure(`未交卷试卷列表泄漏 ${leaks[0]}`, result);
  return result;
}
async function todayProbe(ctx) { return okJson(await json(ctx, '/api/today'), '/api/today', record); }
async function memoryProbe(ctx) { return okJson(await json(ctx, '/api/memory/overview'), '/api/memory/overview', record); }
async function activityProbe(ctx) { return okJson(await json(ctx, '/api/ai/activity'), '/api/ai/activity', record); }
async function questionsProbe(ctx) {
  const result = okJson(await json(ctx, '/api/iqdb/questions'), '/api/iqdb/questions', body => record(body) && Array.isArray(body.questions));
  const leaks = leakPaths(result.body.questions, 'questions');
  if (leaks.length) throw failure(`未交卷题面泄漏 ${leaks[0]}`, result);
  return result;
}
const WAVE_PROBES = [
  ...HTML_PATHS.map(path => ({ wave: 'w1', name: `HTML ${path}`, run: async ctx => {
    const result = await request(ctx, path);
    if (result.status !== 200) throw failure(`HTTP ${result.status}`, result);
    if (!result.text.trim() || (!result.type.toLowerCase().includes('text/html') && !/<(?:!doctype html|html[\s>])/i.test(result.text)))
      throw failure('响应不是非空 HTML', result);
    if (BAD_HTML.test(result.text)) throw failure('检测到构建或服务端错误标记', result);
    return result;
  }})),
  { wave: 'w1', name: 'JSON /api/today', run: todayProbe },
  { wave: 'w1', name: 'JSON /api/iqdb/questions', run: questionsProbe },
  { wave: 'w1', name: 'JSON /api/memory/overview', run: memoryProbe },
  { wave: 'w1', name: 'JSON /api/ai/activity', run: activityProbe },
  { wave: 'w1', name: 'JSON /api/papers', run: papersProbe },
  { wave: 'w1', name: 'JSON /api/care/support', run: async ctx => okJson(await json(ctx, '/api/care/support'), '/api/care/support', body => record(body) && record(body.card)) },
  { wave: 'w2', name: 'POST /api/iqdb/author 无污染路由', run: async ctx => {
    const result = await request(ctx, '/api/iqdb/author', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (result.status === 404 || result.status >= 500) throw failure(`HTTP ${result.status}`, result);
    return result;
  }},
  { wave: 'w3', name: '今天 campaignState/reentry', run: async ctx => {
    const result = await todayProbe(ctx);
    if (!hasAny(result.body, ['campaignState', 'campaign_state']) || !hasAny(result.body, ['reentry']))
      throw failure('缺少 campaignState 或 reentry 字段', result);
    return result;
  }},
  { wave: 'w3', name: '记忆 metacognitiveHabits/masteryIllusionAlerts', run: async ctx => {
    const result = await memoryProbe(ctx);
    if (!hasAny(result.body, ['metacognitiveHabits', 'metacognitive_habits']) || !hasAny(result.body, ['masteryIllusionAlerts', 'mastery_illusion_alerts']))
      throw failure('缺少元认知习惯或掌握幻觉字段', result);
    return result;
  }},
  { wave: 'w3', name: 'GET 题目双通道回溯', run: async ctx => {
    const summary = ctx.paperSummaries?.[0];
    if (!summary?.id) return { skip: '没有可只读复查的试卷' };
    const detail = ctx.details.get(String(summary.id)) || (await json(ctx, `/api/papers/${encodeURIComponent(summary.id)}`)).body;
    const question = detail?.questions?.[0];
    if (!question?.id) return { skip: '试卷没有题目 ID，跳过只读回溯' };
    return okJson(await json(ctx, `/api/papers/${encodeURIComponent(summary.id)}/items/${encodeURIComponent(question.id)}/backtrace`), 'backtrace', record);
  }},
  { wave: 'w4', name: 'GET /api/kb/gardening', run: async ctx => okJson(await json(ctx, '/api/kb/gardening'), '/api/kb/gardening') },
  { wave: 'w5', name: 'GET /api/study-method-templates', run: async ctx => okJson(await json(ctx, '/api/study-method-templates'), '/api/study-method-templates') },
  { wave: 'w5', name: 'GET /api/classrooms?status=active', run: async ctx => okJson(await json(ctx, '/api/classrooms?status=active'), '/api/classrooms') },
];
function print(state, probe, result, reason = '') {
  const status = result?.status === undefined ? '-' : result.status;
  const elapsed = result?.elapsed === undefined ? '-' : `${result.elapsed}ms`;
  console.log(`[${state}] ${probe.wave} ${probe.name} HTTP ${status} ${elapsed}${reason ? ` ${reason}` : ''}`);
}
async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n\n${usage}`); return 1; }
  if (options.help) { console.log(usage); return 0; }
  const ctx = { ...options, details: new Map() }, target = WAVES.indexOf(options.wave);
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const probe of WAVE_PROBES) {
    if (WAVES.indexOf(probe.wave) > target) { counts.skipped += 1; print('SKIP', probe, null, '目标波次未启用'); continue; }
    try {
      const result = await probe.run(ctx);
      if (result?.skip) { counts.skipped += 1; print('SKIP', probe, result, result.skip); }
      else { counts.passed += 1; print('PASS', probe, result); }
    } catch (error) { counts.failed += 1; print('FAIL', probe, error, error.message); }
  }
  console.log(`Summary Passed=${counts.passed} Failed=${counts.failed} Skipped=${counts.skipped} URL=${options.baseUrl} Wave=${options.wave}`);
  return counts.failed ? 1 : 0;
}
process.exitCode = await main();
