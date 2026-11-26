import type {
  CalcArtifactBindingWire, CalcBindingsFreezeVerificationWire, FactId, Json, JsonObject, Revision,
} from '@mangekyo/kernel';
import { compareText } from './content-guard.ts';
import { choice, compact, fields, list, pageId, record, requireIso, revision, text } from './parse.ts';

export const calcHandlePattern = /^@calc_[a-zA-Z0-9_-]{1,64}$/;
export const calcOutputSha256Pattern = /^[a-f0-9]{64}$/;
export const calcMediaKinds = ['table_json', 'series_json', 'svg_plot', 'png_plot'] as const;
export const calcSpoilerForbiddenKeys = [
  'answer', 'answers', 'solution', 'solutions', 'rubric', 'rubrics',
  'expectedoutput', 'expected_output', 'hint_ladder', 'hintladder', 'model_answer', 'modelanswer',
] as const;

export class CalcArtifactSpoilerError extends Error {
  constructor(message: string) { super(message); this.name = 'CalcArtifactSpoilerError'; }
}

export type CalcArtifactMediaKind = CalcArtifactBindingWire['mediaKind'];
export type CalcSeriesSummary = NonNullable<CalcArtifactBindingWire['seriesSummary']>;
export type CalcArtifactBinding = Omit<CalcArtifactBindingWire, 'artifactId' | 'artifactRev'> & {
  readonly artifactId: FactId; readonly artifactRev: Revision;
};
export type CalcArtifactCurrentSnapshot = { readonly artifactId: FactId; readonly artifactRev: Revision; readonly outputSha256: string };
export type CalcBindingFreezeStatus = CalcBindingsFreezeVerificationWire['status'];
export type CalcBindingVerificationEntry = Omit<CalcBindingsFreezeVerificationWire['entries'][number], 'artifactId' | 'frozenRev' | 'currentRev'> & {
  readonly artifactId: FactId; readonly frozenRev: Revision; readonly currentRev?: Revision;
};
export type CalcBindingsFreezeVerification = Omit<CalcBindingsFreezeVerificationWire, 'entries'> & {
  readonly entries: readonly CalcBindingVerificationEntry[];
};

// Keys are compared case-insensitively so `expectedOutput`, `ExpectedOutput` and `EXPECTEDOUTPUT` are all intercepted.
const forbiddenKeySet: ReadonlySet<string> = new Set(calcSpoilerForbiddenKeys.map(key => key.toLowerCase()));
// The left boundary keeps email-like text such as `user@calc_team.com` out of handle scanning.
const handleScanPattern = /(?<![A-Za-z0-9._%+-])@calc_[a-zA-Z0-9_-]+/g;

function assertNoSpoilerKeys(value: unknown, label: string, seen = new Set<object>(), skipKeys?: ReadonlySet<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${label}不能包含循环引用。`);
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) assertNoSpoilerKeys(item, label, seen); }
  else {
    for (const [k, entry] of Object.entries(value)) {
      if (skipKeys?.has(k)) continue;
      if (forbiddenKeySet.has(k.toLowerCase())) throw new CalcArtifactSpoilerError(`${label}包含禁止的剧透字段：${k}。`);
      assertNoSpoilerKeys(entry, label, seen);
    }
  }
  seen.delete(value);
}
function cloneJson(value: Json, seen = new Set<object>()): Json {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('交互视图不能包含循环引用。');
  seen.add(value);
  const out: Json = Array.isArray(value)
    ? value.map(item => cloneJson(item, seen))
    : Object.fromEntries(Object.entries(value).map(([k, entry]) => [k, cloneJson(entry, seen)]));
  seen.delete(value);
  return out;
}
function parseSeriesSummary(value: unknown): CalcSeriesSummary {
  const row = record(value);
  fields(row, 'pointCount', 'unit', 'xLabel', 'yLabel');
  if (typeof row.pointCount !== 'number' || !Number.isSafeInteger(row.pointCount) || row.pointCount < 0) throw new Error('数据序列点数必须是非负整数。');
  return Object.freeze(compact({
    pointCount: row.pointCount, unit: row.unit === undefined ? undefined : text(row.unit, '数据单位'),
    xLabel: row.xLabel === undefined ? undefined : text(row.xLabel, '横轴标签'),
    yLabel: row.yLabel === undefined ? undefined : text(row.yLabel, '纵轴标签'),
  }));
}

export function parseCalcArtifactBinding(input: unknown): CalcArtifactBinding {
  assertNoSpoilerKeys(input, '验算工件绑定');
  const row = record(input);
  fields(row, 'handle', 'artifactId', 'artifactRev', 'outputSha256', 'producer', 'mediaKind', 'frozenAtIso', 'seriesSummary');
  const handle = text(row.handle, '验算句柄');
  if (!calcHandlePattern.test(handle)) throw new Error(`验算句柄格式无效：${handle}。`);
  const artifactId = pageId(row.artifactId), artifactRev = revision(row.artifactRev);
  const outputSha256 = text(row.outputSha256, '输出 SHA256');
  if (!calcOutputSha256Pattern.test(outputSha256)) throw new Error('输出 SHA256 必须是 64 位小写十六进制字符串。');
  if (row.producer !== 'python_calculation_sandbox') throw new Error('验算工件绑定 producer 必须为 python_calculation_sandbox。');
  const mediaKind = choice(row.mediaKind, calcMediaKinds, '验算工件媒体类型');
  const frozenAtIso = requireIso(row.frozenAtIso, '验算绑定冻结时间');
  return Object.freeze(compact({
    handle, artifactId, artifactRev, outputSha256, producer: 'python_calculation_sandbox' as const,
    mediaKind, frozenAtIso, seriesSummary: row.seriesSummary === undefined ? undefined : parseSeriesSummary(row.seriesSummary),
  }));
}

function collectHandles(value: unknown, out: Set<string>, seen: Set<object>, skipKeys?: ReadonlySet<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(handleScanPattern)) {
      if (!calcHandlePattern.test(match[0])) throw new Error(`检测到非法或超长的验算句柄片段：${match[0]}。`);
      out.add(match[0]);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('交互视图不能包含循环引用。');
  seen.add(value);
  const items = Array.isArray(value) ? value
    : Object.entries(value as Record<string, unknown>).filter(([key]) => !skipKeys?.has(key)).map(([, entry]) => entry);
  for (const item of items) collectHandles(item, out, seen);
  seen.delete(value);
}

export function extractCalcHandlesFromView(view: JsonObject): readonly string[] {
  record(view);
  const handles = new Set<string>();
  collectHandles(view, handles, new Set<object>(), new Set(['calcBindings']));
  return Object.freeze(Array.from(handles).sort(compareText));
}

export function attachCalcBindingsToInteractionView(
  view: JsonObject, bindings: readonly CalcArtifactBinding[]
): JsonObject & { readonly calcBindings: readonly CalcArtifactBinding[] } {
  record(view);
  // A previously attached top-level `calcBindings` array is replaced below, so rescanning it would break idempotence.
  assertNoSpoilerKeys(view, '课堂交互视图', new Set<object>(), new Set(['calcBindings']));
  const parsedBindings: CalcArtifactBinding[] = [], byHandle = new Map<string, CalcArtifactBinding>();
  for (const item of list(bindings)) {
    const parsed = parseCalcArtifactBinding(item);
    if (byHandle.has(parsed.handle)) throw new Error(`验算句柄重复：${parsed.handle}。`);
    byHandle.set(parsed.handle, parsed);
    parsedBindings.push(parsed);
  }
  const missing = extractCalcHandlesFromView(view).filter(handle => !byHandle.has(handle));
  if (missing.length > 0) throw new Error(`课堂交互视图引用了未绑定的验算句柄：${missing.join(', ')}。`);
  const cloned = cloneJson(view) as Record<string, Json>;
  return Object.freeze({ ...cloned, calcBindings: Object.freeze(parsedBindings) }) as JsonObject & {
    readonly calcBindings: readonly CalcArtifactBinding[];
  };
}

export function verifyCalcBindingsFrozen(
  frozenBindings: readonly CalcArtifactBinding[],
  currentArtifacts: ReadonlyMap<FactId, CalcArtifactCurrentSnapshot> | readonly CalcArtifactCurrentSnapshot[],
): CalcBindingsFreezeVerification {
  const parsedFrozen = list(frozenBindings).map(parseCalcArtifactBinding);
  if (new Set(parsedFrozen.map(binding => binding.handle)).size !== parsedFrozen.length) throw new Error('冻结验算绑定包含重复的句柄。');
  const currentMap = new Map<FactId, CalcArtifactCurrentSnapshot>();
  for (const entry of currentArtifacts instanceof Map ? currentArtifacts.values() : list(currentArtifacts)) {
    const row = record(entry);
    fields(row, 'artifactId', 'artifactRev', 'outputSha256');
    const artifactId = pageId(row.artifactId), artifactRev = revision(row.artifactRev);
    const outputSha256 = text(row.outputSha256, '当前工件 SHA256');
    if (!calcOutputSha256Pattern.test(outputSha256)) throw new Error('当前工件 SHA256 格式无效。');
    if (currentMap.has(artifactId)) throw new Error(`当前工件列表包含重复的工件标识：${artifactId}。`);
    currentMap.set(artifactId, { artifactId, artifactRev, outputSha256 });
  }
  let aggregate: CalcBindingFreezeStatus = 'exact';
  const entries: CalcBindingVerificationEntry[] = parsedFrozen.map(binding => {
    const current = currentMap.get(binding.artifactId);
    if (!current) {
      aggregate = 'missing_keep_frozen';
      return Object.freeze({
        handle: binding.handle, artifactId: binding.artifactId, frozenRev: binding.artifactRev,
        frozenSha256: binding.outputSha256, status: 'missing_keep_frozen' as const, reason: '当前源工件已缺失，继续保留历史冻结验算绑定。'
      });
    }
    const drifted = current.artifactRev !== binding.artifactRev || current.outputSha256 !== binding.outputSha256;
    if (drifted && aggregate === 'exact') aggregate = 'drifted_keep_frozen';
    return Object.freeze({
      handle: binding.handle, artifactId: binding.artifactId, frozenRev: binding.artifactRev,
      frozenSha256: binding.outputSha256, currentRev: current.artifactRev, currentSha256: current.outputSha256,
      status: drifted ? 'drifted_keep_frozen' as const : 'exact' as const,
      reason: drifted
        ? '当前源工件修订或输出摘要已漂移，继续保留历史冻结验算绑定。'
        : '冻结验算绑定与当前源工件修订及输出摘要完全一致。',
    });
  });
  return Object.freeze({ status: aggregate, preservedFrozen: true as const, entries: Object.freeze(entries) });
}
