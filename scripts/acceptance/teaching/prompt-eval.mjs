import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const modes = new Set(['quiet', 'balanced', 'navigator']);
const skills = new Set([
  'knowledge-bridge', 'boundary-probe', 'spiral-revisit', 'concept-crystallizer',
  'curiosity-seeder', 'gap-scout', 'micro-sprint-guide', 'living-asset-expander',
]);
const dimensions = new Set([
  'bridge_truthfulness', 'extension_hook', 'boundary_respect', 'tool_efficiency',
]);
const categories = new Set([
  'skill_bridge', 'skill_proactive', 'skill_background', 'safety_boundary', 'navigator_flow',
]);
const defaultPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'eval-scenarios.json');
const usage = `用法：
  node scripts/acceptance/teaching/prompt-eval.mjs --mode validate [--scenarios <path>]
  node scripts/acceptance/teaching/prompt-eval.mjs --mode live [选项]

live 选项：--base-url <url>  --timeout-ms <ms>  --probe-path <path>  --json
默认地址来自 MANGEKYO_STUDIO_URL，未设置时为 http://127.0.0.1:3000。`;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(args) {
  const out = {mode: '', scenarios: defaultPath, baseUrl: process.env.MANGEKYO_STUDIO_URL ||
    'http://127.0.0.1:3000', timeoutMs: 10000, json: false, probePath: null};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inline] = arg.split('=', 2);
    const next = () => args[++index];
    if (key === '-h' || key === '--help') return {help: true};
    if (key === '--json') out.json = true;
    else if (key === '--mode') out.mode = inline ?? next();
    else if (key === '--scenarios') out.scenarios = inline ?? next();
    else if (key === '--base-url') out.baseUrl = inline ?? next();
    else if (key === '--timeout-ms') out.timeoutMs = Number(inline ?? next());
    else if (key === '--probe-path') out.probePath = inline ?? next();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['validate', 'live'].includes(out.mode)) throw new Error('必须指定 --mode validate 或 --mode live。');
  if (!Number.isInteger(out.timeoutMs) || out.timeoutMs < 1) throw new Error('timeout-ms 必须是正整数。');
  if (out.mode === 'live') {
    const url = new URL(out.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('base-url 只允许 http 或 https。');
    out.baseUrl = url.toString().replace(/\/$/, '');
    if (out.probePath && !out.probePath.startsWith('/api/')) {
      throw new Error('probe-path 必须是只读 API 路径。');
    }
  }
  return out;
}

function checkRule(rule, label, errors) {
  if (!isRecord(rule) || typeof rule.id !== 'string' || typeof rule.description !== 'string' ||
    !dimensions.has(rule.rubricDimension)) errors.push(`${label} 规则字段不完整。`);
  if (rule?.pattern !== undefined && typeof rule.pattern !== 'string') errors.push(`${label} pattern 必须是字符串。`);
  if (typeof rule?.pattern === 'string') {
    try { new RegExp(rule.pattern, rule.flags ?? 'i'); }
    catch (error) { errors.push(`${label} 正则无效：${error.message}`); }
  }
}

function validateScenario(scenario, index, ids, patterns) {
  const errors = [];
  const label = `场景 ${index + 1}`;
  if (!isRecord(scenario)) return [`${label} 必须是对象。`];
  if (typeof scenario.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id)) {
    errors.push(`${label} id 必须是唯一 kebab-case。`);
  } else if (ids.has(scenario.id)) errors.push(`${label} id 重复：${scenario.id}`);
  else ids.add(scenario.id);
  if (typeof scenario.title !== 'string' || !scenario.title.trim()) errors.push(`${label} 缺少 title。`);
  if (!categories.has(scenario.category)) errors.push(`${label} category 无效。`);
  if (!Array.isArray(scenario.rubricFocus) || !scenario.rubricFocus.length ||
    scenario.rubricFocus.some(value => !dimensions.has(value))) errors.push(`${label} rubricFocus 无效。`);
  const signal = scenario.signals;
  if (!isRecord(signal) || !modes.has(signal.proactivityExpected)) errors.push(`${label} 主动度无效。`);
  if (!Array.isArray(signal?.expectedSkills) || signal.expectedSkills.some(value => !skills.has(value))) {
    errors.push(`${label} expectedSkills 无效。`);
  } else {
    if (signal.proactivityExpected === 'quiet' && signal.expectedSkills.length !== 0) {
      errors.push(`${label} quiet 必须没有扩展 Skill。`);
    }
    if (signal.proactivityExpected !== 'quiet' && signal.expectedSkills.length > 2) {
      errors.push(`${label} 非 quiet 最多两个 Skill。`);
    }
  }
  if (typeof scenario.userInput !== 'string' || !scenario.userInput.trim()) errors.push(`${label} 缺少 userInput。`);
  if (!isRecord(scenario.mockContext)) errors.push(`${label} mockContext 必须是对象。`);
  for (const field of ['mustExhibit', 'mustAvoid']) {
    if (!Array.isArray(scenario[field]) || !scenario[field].length) errors.push(`${label} ${field} 不能为空。`);
    else for (const [ruleIndex, rule] of scenario[field].entries()) {
      checkRule(rule, `${label} ${field}[${ruleIndex}]`, errors);
      if (typeof rule?.pattern === 'string') patterns.count += 1;
    }
  }
  return errors;
}

async function validateScenarioFile(filePath) {
  const errors = [];
  let data;
  try { data = JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { return {errors: [`无法读取或解析场景 JSON：${error.message}`]}; }
  if (!isRecord(data) || !Array.isArray(data.scenarios)) return {errors: ['顶层必须含 scenarios 数组。']};
  if (data.scenarios.length !== 16) errors.push(`场景数量必须恰好为 16，实际为 ${data.scenarios.length}。`);
  if (!Array.isArray(data.rubricDimensions) || dimensions.size !== data.rubricDimensions.length ||
    data.rubricDimensions.some(value => !dimensions.has(value))) errors.push('rubricDimensions 未覆盖四个维度。');
  const ids = new Set();
  const patterns = {count: 0};
  for (const [index, scenario] of data.scenarios.entries()) {
    errors.push(...validateScenario(scenario, index, ids, patterns));
  }
  const modeCounts = Object.fromEntries([...modes].map(mode => [mode, 0]));
  const skillCoverage = new Set();
  const rubricCoverage = new Set();
  let safetyCount = 0;
  for (const scenario of data.scenarios) {
    const signal = scenario?.signals;
    if (modes.has(signal?.proactivityExpected)) modeCounts[signal.proactivityExpected] += 1;
    for (const skill of signal?.expectedSkills ?? []) skillCoverage.add(skill);
    for (const dimension of scenario?.rubricFocus ?? []) rubricCoverage.add(dimension);
    if (scenario?.category === 'safety_boundary') safetyCount += 1;
  }
  for (const mode of modes) if (!modeCounts[mode]) errors.push(`缺少主动度覆盖：${mode}`);
  for (const skill of skills) if (!skillCoverage.has(skill)) errors.push(`缺少 Skill 覆盖：${skill}`);
  if (safetyCount < 5) errors.push(`安全边界场景至少 5 个，实际为 ${safetyCount}。`);
  for (const dimension of dimensions) if (!rubricCoverage.has(dimension)) errors.push(`缺少 Rubric 覆盖：${dimension}`);
  return {data, errors, modeCounts, skillCoverage, safetyCount, rubricCoverage, patternCount: patterns.count};
}

function printValidation(result, filePath) {
  if (result.errors.length) {
    console.error(result.errors.map(error => `ERROR ${error}`).join('\n'));
    return 1;
  }
  console.log(`校验通过：${result.data.scenarios.length} 个场景，主动度 ${JSON.stringify(result.modeCounts)}，` +
    `Skill ${result.skillCoverage.size}/8，安全边界 ${result.safetyCount}，正则 ${result.patternCount}，文件 ${filePath}`);
  return 0;
}

function submitted(value) {
  return isRecord(value) && ['submitted', 'graded', 'completed'].includes(String(value.status).toLowerCase());
}

function leakPaths(value, current = '') {
  if (value === null || typeof value !== 'object' || submitted(value)) return [];
  const leaks = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = current ? `${current}.${key}` : key;
    if (['answer', 'solution', 'rubric'].includes(key.toLowerCase())) leaks.push(childPath);
    leaks.push(...leakPaths(child, childPath));
  }
  return leaks;
}

async function getJson(baseUrl, requestPath, timeoutMs) {
  const started = Date.now();
  const response = await fetch(baseUrl + requestPath, {method: 'GET', signal: AbortSignal.timeout(timeoutMs)});
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return {path: requestPath, status: response.status, elapsed: Date.now() - started, body};
}

async function runLive(options) {
  const paths = ['/api/today', '/api/memory/overview', '/api/ai/activity', '/api/papers', '/api/care/support'];
  if (options.probePath) paths.push(options.probePath);
  const results = [];
  for (const requestPath of paths) {
    try { results.push(await getJson(options.baseUrl, requestPath, options.timeoutMs)); }
    catch (error) { results.push({path: requestPath, status: 0, error: error.message}); }
  }
  const byPath = new Map(results.map(result => [result.path, result]));
  const checks = [
    {dimension: 'bridge_truthfulness', paths: ['/api/today', '/api/memory/overview'],
      pass: result => result.status === 200 && isRecord(result.body)},
    {dimension: 'extension_hook', paths: ['/api/today'], pass: result => result.status === 200},
    {dimension: 'boundary_respect', paths: ['/api/papers', '/api/care/support'],
      pass: result => result.status === 200 && !leakPaths(result.body).length},
    {dimension: 'tool_efficiency', paths: ['/api/ai/activity'], pass: result => result.status === 200},
  ];
  const rubric = checks.map(check => {
    const observed = check.paths.map(pathName => byPath.get(pathName));
    const missing = observed.some(result => !result);
    const passed = !missing && observed.every(result => check.pass(result));
    return {dimension: check.dimension, status: passed ? 'passed' : 'failed', paths: check.paths};
  });
  const custom = options.probePath ? byPath.get(options.probePath) : null;
  const report = {mode: 'live', baseUrl: options.baseUrl, validation: 'passed', probes: results,
    rubric, customProbe: custom ? custom.status === 200 ? 'passed' : 'failed' : 'not_requested'};
  const failed = results.some(result => result.status !== 200) || rubric.some(item => item.status === 'failed');
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`实机只读探针：${failed ? '失败' : '通过'}，${results.length} 个 GET，` +
      `Rubric ${rubric.filter(item => item.status === 'passed').length}/4`);
    for (const result of results) console.log(`${result.status === 200 ? 'PASS' : 'FAIL'} GET ${result.path} ${result.status}`);
    for (const item of rubric) console.log(`${item.status.toUpperCase()} ${item.dimension}`);
  }
  return failed ? 1 : 0;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n\n${usage}`); return 1; }
  if (options.help) { console.log(usage); return 0; }
  const validation = await validateScenarioFile(options.scenarios);
  if (options.mode === 'validate') return printValidation(validation, options.scenarios);
  if (validation.errors.length) return printValidation(validation, options.scenarios);
  return runLive(options);
}

process.exitCode = await main();
