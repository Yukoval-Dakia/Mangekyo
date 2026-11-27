import { factId, isFactUnavailable, type FactId, type FactSnapshot, type JsonObject, type ReadContext, type ReadTransaction, type Revision } from '@mangekyo/kernel';
import {
  attachCalcBindingsToInteractionView, extractCalcHandlesFromView, parseCalcArtifactBinding, verifyCalcBindingsFrozen,
  type CalcArtifactBinding, type CalcArtifactCurrentSnapshot, type CalcBindingsFreezeVerification,
} from './calc-artifact-binding.ts';

/**
 * Pure host glue for frozen @calc_* verification bindings.
 * - Uses caller-provided authorized reader (`teaching` purpose + Notion check) so purpose narrowing,
 *   retraction, tombstoning or upstream Notion withdrawal never leaks new revs or hashes.
 * - Canonical JSON omits `undefined` keys to match PostgreSQL `jsonb` serialization 1:1.
 * - Multi-handle bindings pointing to the same `artifactId` are deduplicated before freeze verification.
 */

const unavailableErrorNames = new Set(['FactNotFoundError', 'FactReadDeniedError', 'FactRevisionNotFoundError']);
const isUnavailableError = (error: unknown): boolean =>
  isFactUnavailable(error) || (error instanceof Error &&
    (unavailableErrorNames.has(error.name) || unavailableErrorNames.has(error.constructor?.name ?? '')));

export class CalcBindingUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'CalcBindingUnavailableError'; }
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const row = value as Record<string, unknown>;
  return '{' + Object.keys(row).filter(key => row[key] !== undefined).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(row[key])).join(',') + '}';
};

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

/** Canonical output digest of one artifact revision payload (matches PG jsonb key omission). */
export function calcOutputDigest(data: unknown): Promise<string> {
  return sha256Hex(canonicalJson(data));
}

type WitnessUse = { readonly id: string; readonly rev: number; readonly accessEpoch?: string | number };

function collectWitnessUses(data: unknown, out: WitnessUse[] = []): WitnessUse[] {
  if (Array.isArray(data)) {
    for (const item of data) collectWitnessUses(item, out);
    return out;
  }
  if (data && typeof data === 'object') {
    const row = data as Record<string, unknown>;
    const epoch = typeof row.accessEpoch === 'string' || typeof row.accessEpoch === 'number' ? row.accessEpoch : row.epoch;
    if (typeof row.id === 'string' && row.id.length === 26 && typeof row.rev === 'number' &&
        (typeof epoch === 'string' || typeof epoch === 'number')) {
      out.push({ id: row.id, rev: row.rev, accessEpoch: epoch });
    }
    for (const value of Object.values(row)) collectWitnessUses(value, out);
  }
  return out;
}

/** Verify an opened fact and every transitive `{ id, rev, accessEpoch|epoch }` witness through the authorized reader. */
async function verifyTransitiveWitnesses(
  read: Pick<ReadContext, 'fact'>, fact: FactSnapshot, visited = new Set<string>(),
): Promise<void> {
  for (const use of collectWitnessUses(fact.value)) {
    const key = `${use.id}:${use.rev}:${use.accessEpoch ?? ''}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const dep = await read.fact(factId(use.id), { mode: 'pinned', rev: use.rev as Revision });
    if (use.accessEpoch !== undefined && dep.accessEpoch !== String(use.accessEpoch))
      throw new CalcBindingUnavailableError(`验算工件上游依据 ${use.id} 访问代次已变更。`);
    await verifyTransitiveWitnesses(read, dep, visited);
  }
}

/** Read already-persisted calcBindings on an existing mounted artifact for idempotent replay. */
export async function readExistingMountCalcBindings(
  tx: ReadTransaction, mountId: FactId,
): Promise<readonly CalcArtifactBinding[] | undefined> {
  const { rows: [row] } = await tx.query<{ data: unknown }>(
    `SELECT r.data FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
       WHERE f.learner_id=$1 AND f.id=$2 AND f.type='content.mountedArtifact' AND f.retracted_rev IS NULL AND r.kind='value'`,
    [tx.learner, mountId]);
  const raw = row?.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>).calcBindings : undefined;
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return Object.freeze(raw.map(entry => parseCalcArtifactBinding(entry)));
}

/**
 * Validate caller-supplied bindings for one interaction view under the caller's authorized reader:
 * zero spoiler keys, every handle bound, and each referenced artifact revision authorized for
 * teaching (including transitive upstream witnesses) and digest-matching.
 */
export async function freezeCalcBindingsForMount(
  read: Pick<ReadContext, 'fact'>, view: JsonObject, rawBindings: unknown,
): Promise<readonly CalcArtifactBinding[]> {
  if (!Array.isArray(rawBindings) || !rawBindings.length) throw new CalcBindingUnavailableError('验算绑定列表为空或缺失。');
  const attached = attachCalcBindingsToInteractionView(view, rawBindings as CalcArtifactBinding[]);
  const out: CalcArtifactBinding[] = [];
  for (const binding of attached.calcBindings) {
    let fact: FactSnapshot;
    try {
      fact = await read.fact(binding.artifactId, { mode: 'pinned', rev: binding.artifactRev });
      await verifyTransitiveWitnesses(read, fact);
    } catch (error) {
      if (isUnavailableError(error))
        throw new CalcBindingUnavailableError(`验算工件 ${binding.artifactId} 不可读或未授权。`);
      throw error;
    }
    const digest = await calcOutputDigest(fact.value);
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

/**
 * Re-read the current authorized teaching snapshot of every distinct frozen binding source.
 * Narrowed, revoked, tombstoned or upstream-withdrawn artifacts are omitted so freeze verification
 * degrades to `missing_keep_frozen` and never leaks new revs or hashes. Transient Notion errors propagate.
 */
export async function readCalcBindingCurrents(
  read: Pick<ReadContext, 'fact'>, bindings: readonly CalcArtifactBinding[],
): Promise<readonly CalcArtifactCurrentSnapshot[]> {
  const out: CalcArtifactCurrentSnapshot[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.artifactId)) continue;
    seen.add(binding.artifactId);
    let fact: FactSnapshot;
    try {
      fact = await read.fact(binding.artifactId, { mode: 'following' });
      await verifyTransitiveWitnesses(read, fact);
    } catch (error) {
      if (isUnavailableError(error) || error instanceof CalcBindingUnavailableError) continue;
      throw error;
    }
    out.push(Object.freeze({
      artifactId: factId(binding.artifactId), artifactRev: fact.ref.rev, outputSha256: await calcOutputDigest(fact.value),
    }));
  }
  return Object.freeze(out);
}

/** Parse frozen bindings from mount data and compute the fresh freeze verification. */
export async function verifyStoredCalcBindings(
  read: Pick<ReadContext, 'fact'>, rawBindings: unknown,
): Promise<{ bindings: readonly CalcArtifactBinding[]; verification: CalcBindingsFreezeVerification } | undefined> {
  if (!Array.isArray(rawBindings) || !rawBindings.length) return undefined;
  const bindings = Object.freeze((rawBindings as unknown[]).map(entry => parseCalcArtifactBinding(entry)));
  const verification = verifyCalcBindingsFrozen(bindings, await readCalcBindingCurrents(read, bindings));
  return { bindings, verification };
}
