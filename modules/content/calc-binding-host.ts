import { factId, type FactId, type Json, type JsonObject, type ReadTransaction, type Revision } from '@mangekyo/kernel';
import {
  attachCalcBindingsToInteractionView, extractCalcHandlesFromView, parseCalcArtifactBinding, verifyCalcBindingsFrozen,
  type CalcArtifactBinding, type CalcArtifactCurrentSnapshot, type CalcBindingsFreezeVerification,
} from './calc-artifact-binding.ts';

/**
 * Pure host glue for frozen @calc_* verification bindings. The output digest rule is the sha256 of the
 * canonical JSON of the bound artifact revision data; both the mount-time freeze check and every later
 * drift re-check use this one rule, so historical mounts stay verifiable without any executor dependency.
 */

export class CalcBindingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'CalcBindingUnavailableError'; }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(row[key])).join(',') + '}';
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/** Canonical output digest of one artifact revision payload. */
export function calcOutputDigest(data: unknown): Promise<string> {
  return sha256Hex(canonicalJson(data));
}

type ArtifactRow = { id: string; current_rev: number; granted: boolean; retracted: boolean; tombstoned: boolean };

async function artifactRow(tx: ReadTransaction, id: FactId): Promise<ArtifactRow | undefined> {
  const { rows: [row] } = await tx.query<ArtifactRow>(
    `SELECT f.id, f.current_rev, (f.purpose && ARRAY['teaching','storage','all']::text[]) AS granted,
       (f.retracted_rev IS NOT NULL) AS retracted,
       EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id) AS tombstoned
       FROM facts f WHERE f.learner_id=$1 AND f.id=$2`,
    [tx.learner, id]);
  return row;
}

const readable = (row: ArtifactRow | undefined): row is ArtifactRow =>
  row !== undefined && row.granted && !row.retracted && !row.tombstoned;

async function revisionData(tx: ReadTransaction, id: FactId, rev: number): Promise<unknown> {
  const { rows: [row] } = await tx.query<{ data: unknown }>(
    `SELECT data FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3 AND kind='value'`,
    [tx.learner, id, rev]);
  return row?.data;
}

/**
 * Validate the caller-supplied bindings for one interaction view: zero spoiler keys, every handle bound,
 * and each referenced artifact revision present, authorized and digest-matching. Returns the parsed,
 * frozen bindings (with digests recomputed and enforced) to persist beside the mount data.
 */
export async function freezeCalcBindingsForMount(
  tx: ReadTransaction, view: JsonObject, rawBindings: unknown,
): Promise<readonly CalcArtifactBinding[]> {
  if (!Array.isArray(rawBindings) || !rawBindings.length) throw new CalcBindingUnavailableError('验算绑定列表为空或缺失。');
  const attached = attachCalcBindingsToInteractionView(view, rawBindings as CalcArtifactBinding[]);
  const out: CalcArtifactBinding[] = [];
  for (const binding of attached.calcBindings) {
    const row = await artifactRow(tx, binding.artifactId);
    if (!readable(row)) throw new CalcBindingUnavailableError(`验算工件 ${binding.artifactId} 不可读或未授权。`);
    if (row.current_rev < binding.artifactRev) throw new CalcBindingUnavailableError(`验算工件 ${binding.artifactId} 缺少冻结修订。`);
    const data = await revisionData(tx, binding.artifactId, binding.artifactRev);
    if (data === undefined) throw new CalcBindingUnavailableError(`验算工件 ${binding.artifactId} 的冻结修订不可读。`);
    const digest = await calcOutputDigest(data);
    if (digest !== binding.outputSha256)
      throw new CalcBindingUnavailableError(`验算工件 ${binding.artifactId} 的输出摘要与事实不符。`);
    out.push(parseCalcArtifactBinding(binding));
  }
  return Object.freeze(out);
}

/** True when the mount arguments need calc binding validation at all. */
export function calcBindingsNeeded(view: JsonObject, rawBindings: unknown): boolean {
  return rawBindings !== undefined || extractCalcHandlesFromView(view).length > 0;
}

export type CalcCurrentRead = { readonly artifactId: FactId; readonly artifactRev: Revision; readonly outputSha256: string };

/**
 * Re-read the current authorized snapshot of every frozen binding source. Revoked, tombstoned or missing
 * artifacts are simply absent from the returned map, so the frozen verification degrades to
 * `missing_keep_frozen` and never re-leaks withdrawn content.
 */
export async function readCalcBindingCurrents(
  tx: ReadTransaction, bindings: readonly CalcArtifactBinding[],
): Promise<readonly CalcArtifactCurrentSnapshot[]> {
  const out: CalcArtifactCurrentSnapshot[] = [];
  for (const binding of bindings) {
    const row = await artifactRow(tx, binding.artifactId);
    if (!readable(row)) continue;
    const data = await revisionData(tx, binding.artifactId, row.current_rev);
    if (data === undefined) continue;
    out.push(Object.freeze({
      artifactId: factId(binding.artifactId), artifactRev: row.current_rev as Revision, outputSha256: await calcOutputDigest(data),
    }));
  }
  return Object.freeze(out);
}

/** Parse frozen bindings from mount data and compute the fresh freeze verification. */
export async function verifyStoredCalcBindings(
  tx: ReadTransaction, rawBindings: unknown,
): Promise<{ bindings: readonly CalcArtifactBinding[]; verification: CalcBindingsFreezeVerification } | undefined> {
  if (!Array.isArray(rawBindings) || !rawBindings.length) return undefined;
  const bindings = Object.freeze((rawBindings as unknown[]).map(entry => parseCalcArtifactBinding(entry)));
  const verification = verifyCalcBindingsFrozen(bindings, await readCalcBindingCurrents(tx, bindings));
  return { bindings, verification };
}
