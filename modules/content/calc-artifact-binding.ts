import type { FactId, Json, JsonObject, Revision } from '@mangekyo/kernel';
import { fields, list, pageId, record, revision, text } from './parse.ts';

export const calcHandlePattern = /^@calc_[a-zA-Z0-9_-]{1,64}$/;
export const calcOutputSha256Pattern = /^[a-f0-9]{64}$/;
export const calcMediaKinds = ['table_json', 'series_json', 'svg_plot', 'png_plot'] as const;
export const calcSpoilerForbiddenKeys = ['answer', 'solution', 'rubric', 'expectedOutput'] as const;

export class CalcArtifactSpoilerError extends Error {
  constructor(message: string) { super(message); this.name = 'CalcArtifactSpoilerError'; }
}

export type CalcArtifactMediaKind = (typeof calcMediaKinds)[number];
export type CalcSeriesSummary = { readonly pointCount: number; readonly unit?: string; readonly xLabel?: string; readonly yLabel?: string };
export type CalcArtifactBinding = {
  readonly handle: string; readonly artifactId: FactId; readonly artifactRev: Revision;
  readonly outputSha256: string; readonly producer: 'python_calculation_sandbox';
  readonly mediaKind: CalcArtifactMediaKind; readonly frozenAtIso: string; readonly seriesSummary?: CalcSeriesSummary;
};
export type CalcArtifactCurrentSnapshot = { readonly artifactId: FactId; readonly artifactRev: Revision; readonly outputSha256: string };
export type CalcBindingFreezeStatus = 'exact' | 'drifted_keep_frozen' | 'missing_keep_frozen';
export type CalcBindingVerificationEntry = {
  readonly handle: string; readonly artifactId: FactId; readonly frozenRev: Revision; readonly frozenSha256: string;
  readonly currentRev?: Revision; readonly currentSha256?: string; readonly status: CalcBindingFreezeStatus; readonly reason: string;
};
export type CalcBindingsFreezeVerification = {
  readonly status: CalcBindingFreezeStatus; readonly preservedFrozen: true; readonly entries: readonly CalcBindingVerificationEntry[];
};

const forbiddenKeySet: ReadonlySet<string> = new Set(calcSpoilerForbiddenKeys);
const handleScanPattern = /@calc_[a-zA-Z0-9_-]*/g;
const isoPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function requireIso(value: unknown, label: string): string {
  const m = typeof value === 'string' ? isoPattern.exec(value) : null;
  if (!m) throw new Error(`${label}不是合法的 ISO 时间戳。`);
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const maxD = [31, ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  const tz = m[7]!, tzBad = tz !== 'Z' && (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(4, 6)) > 59);
  if (mo < 1 || mo > 12 || d < 1 || d > maxD || h > 23 || mi > 59 || s > 59 || tzBad) throw new Error(`${label}不是合法的 ISO 时间戳。`);
  return value as string;
}
function assertNoSpoilerKeys(value: unknown, label: string, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${label}不能包含循环引用。`);
  seen.add(value);
  if (Array.isArray(value)) { for (const item of value) assertNoSpoilerKeys(item, label, seen); }
  else {
    for (const [k, entry] of Object.entries(value)) {
      if (forbiddenKeySet.has(k)) throw new CalcArtifactSpoilerError(`${label}包含禁止的剧透字段：${k}。`);
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
  if (typeof row.pointCount !== 'number' || !Number.isSafeInteger(row.pointCount) || row.pointCount < 0) {
    throw new Error('数据序列点数必须是非负整数。');
  }
  const unit = row.unit === undefined ? undefined : text(row.unit, '数据单位');
  const xLabel = row.xLabel === undefined ? undefined : text(row.xLabel, '横轴标签');
  const yLabel = row.yLabel === undefined ? undefined : text(row.yLabel, '纵轴标签');
  return Object.freeze({
    pointCount: row.pointCount, ...(unit === undefined ? {} : { unit }),
    ...(xLabel === undefined ? {} : { xLabel }), ...(yLabel === undefined ? {} : { yLabel }),
  });
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
  const mediaKind = calcMediaKinds.find(kind => kind === row.mediaKind);
  if (mediaKind === undefined) throw new Error('验算工件媒体类型无效。');
  const frozenAtIso = requireIso(row.frozenAtIso, '验算绑定冻结时间');
  const seriesSummary = row.seriesSummary === undefined ? undefined : parseSeriesSummary(row.seriesSummary);
  return Object.freeze({
    handle, artifactId, artifactRev, outputSha256, producer: 'python_calculation_sandbox' as const,
    mediaKind, frozenAtIso, ...(seriesSummary === undefined ? {} : { seriesSummary }),
  });
}

function collectHandles(value: unknown, out: Set<string>, seen: Set<object>): void {
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
  for (const item of Array.isArray(value) ? value : Object.values(value)) collectHandles(item, out, seen);
  seen.delete(value);
}

export function extractCalcHandlesFromView(view: JsonObject): readonly string[] {
  record(view);
  const handles = new Set<string>();
  collectHandles(view, handles, new Set<object>());
  return Object.freeze(Array.from(handles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function attachCalcBindingsToInteractionView(
  view: JsonObject,
  bindings: readonly CalcArtifactBinding[],
): JsonObject & { readonly calcBindings: readonly CalcArtifactBinding[] } {
  record(view);
  assertNoSpoilerKeys(view, '课堂交互视图');
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
  const currentMap = new Map<FactId, CalcArtifactCurrentSnapshot>();
  for (const entry of currentArtifacts instanceof Map ? currentArtifacts.values() : list(currentArtifacts)) {
    const row = record(entry);
    fields(row, 'artifactId', 'artifactRev', 'outputSha256');
    const artifactId = pageId(row.artifactId), artifactRev = revision(row.artifactRev);
    const outputSha256 = text(row.outputSha256, '当前工件 SHA256');
    if (!calcOutputSha256Pattern.test(outputSha256)) throw new Error('当前工件 SHA256 格式无效。');
    currentMap.set(artifactId, { artifactId, artifactRev, outputSha256 });
  }
  let aggregate: CalcBindingFreezeStatus = 'exact';
  const entries: CalcBindingVerificationEntry[] = parsedFrozen.map(binding => {
    const current = currentMap.get(binding.artifactId);
    if (!current) {
      aggregate = 'missing_keep_frozen';
      return Object.freeze({
        handle: binding.handle, artifactId: binding.artifactId, frozenRev: binding.artifactRev,
        frozenSha256: binding.outputSha256, status: 'missing_keep_frozen' as const,
        reason: '当前源工件已缺失，继续保留历史冻结验算绑定。',
      });
    }
    if (current.artifactRev !== binding.artifactRev || current.outputSha256 !== binding.outputSha256) {
      if (aggregate === 'exact') aggregate = 'drifted_keep_frozen';
      return Object.freeze({
        handle: binding.handle, artifactId: binding.artifactId, frozenRev: binding.artifactRev,
        frozenSha256: binding.outputSha256, currentRev: current.artifactRev, currentSha256: current.outputSha256,
        status: 'drifted_keep_frozen' as const, reason: '当前源工件修订或输出摘要已漂移，继续保留历史冻结验算绑定。',
      });
    }
    return Object.freeze({
      handle: binding.handle, artifactId: binding.artifactId, frozenRev: binding.artifactRev,
      frozenSha256: binding.outputSha256, currentRev: current.artifactRev, currentSha256: current.outputSha256,
      status: 'exact' as const, reason: '冻结验算绑定与当前源工件修订及输出摘要完全一致。',
    });
  });
  return Object.freeze({ status: aggregate, preservedFrozen: true as const, entries: Object.freeze(entries) });
}
