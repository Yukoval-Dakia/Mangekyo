import {
  factId, type CanonicalEvidenceSliceV1, type DerivationId, type FactId, type Json, type Outcome,
  type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import { validatesWorkbookHistory, workbookWitnessesBy, type ActivityEvidenceReadScope, type WorkbookHistoryTarget } from './evidence-read.ts';
import { insideFrozenPosttestWindow, posttestOpensAt, retentionPaperType, type posttestIssuance, type RetentionWindow } from './retention-posttest.ts';
import type { HelpRef } from './help-exposure-values.ts';
import { sameWorkbookJson } from './workbook-values.ts';
import type { ActivityEvidenceObservation, activityHelpProcess } from './evidence-slice.ts';

type Observation = {
  submission: { id: FactId; rev: Revision };
  admittedAt: Tick;
  submittedAt: string;
  result: ActivityEvidenceObservation['result'];
  exposure: { kind: 'independent' | 'unknown' } | {kind:'exposed'; refs: readonly HelpRef[]};
  novelty?: 'same-item' | 'variant' | 'fresh-context';
};
type FrozenInput = {
  target: WorkbookHistoryTarget & { condition: string; gradingVersion: string };
  window: RetentionWindow;
  observedThrough: Tick;
  observations: readonly Observation[];
  canonicalEvidence?: CanonicalEvidenceSliceV1;
};
type RecordedForecast = { method: { id: string; version: string }; input: FrozenInput };

export async function recordedWorkbookForecast(tx: ActivityEvidenceReadScope, slotType: string, id: DerivationId) {
  const { rows: [row] } = await tx.query<{
    value: Outcome<RecordedForecast>; manifest: unknown; slot_key: string; effective_tick: Tick; evidence_through: Tick | null;
  }>(
    `SELECT value,manifest,slot_key,effective_tick::text,scope_keys->>'evidenceThrough' AS evidence_through
       FROM derivations WHERE learner_id=$1 AND id=$2 AND slot_type=$3 AND NOT is_shadow
       AND effective_tick IS NOT NULL`, [tx.learner, id, slotType],
  );
  return row?.value.kind === 'value' ? { ...row, forecast: row.value.value } : undefined;
}

export function validWorkbookMethod({ method, input }: RecordedForecast, lookup: (ref: string) => object | undefined) {
  const selected = lookup(method.id + '@' + method.version);
  return Boolean(selected && (input.target.condition === 'same-item' ||
    (input.target.condition === 'variant' && 'deriver' in selected)));
}

type Witness = { kind: 'fact'; id: FactId; rev: number; mode: 'pinned' | 'following'; accessEpoch: Tick };

class FrozenWorkbookWitnessUnavailable extends Error {}

function frozenWorkbookReader(tx: ActivityEvidenceReadScope, base: ReadContext,
  inputs: readonly (Witness | { kind: 'slot' | 'range' })[], cutoff: Tick,
): ReadContext {
  const witnesses = new Map(inputs.flatMap(witness => witness.kind === 'fact'
    ? [[witness.id + '/' + witness.rev + '/' + witness.mode, witness] as const] : []));
  return { ...base, async fact<Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]) {
    const snapshot = await base.fact<Value>(id, options);
    const witness = witnesses.get(id + '/' + snapshot.ref.rev + '/' + options.mode);
    if (!witness || witness.accessEpoch !== snapshot.accessEpoch || !await workbookWitnessesBy(tx, [snapshot.ref], cutoff)) {
      throw new FrozenWorkbookWitnessUnavailable();
    }
    return snapshot;
  } };
}

type ReopenedEvidence = { observation: Observation; process: ReturnType<typeof activityHelpProcess> };
type ComparableWorkbook = { evidence: ReopenedEvidence; novelty: 'same' | 'isomorphic' };
type ReopenWorkbook = (id: FactId) => Promise<ComparableWorkbook | undefined>;

export async function verifiesOriginalSitting(
  tx: ActivityEvidenceReadScope, slotType: string,
  { observation, process, issuance: release }: ReopenedEvidence & {
    issuance: { fact: { ref: { id: FactId } }; issuance: ReturnType<typeof posttestIssuance> } | undefined;
  },
  lookup: Parameters<typeof validWorkbookMethod>[1],
  issuanceFor: (forecast: DerivationId) => FactId, attemptFor: (issuance: FactId) => FactId,
) {
  if (!release) return process.helpLevel !== 'independent';
  const { fact, issuance } = release;
  const own = await recordedWorkbookForecast(tx, slotType, issuance.forecastId);
  if (!own || !validWorkbookMethod(own.forecast, lookup) || fact.ref.id !== issuanceFor(issuance.forecastId) ||
      observation.submission.id !== attemptFor(fact.ref.id)) return false;
  const { target, window } = own.forecast.input;
  if (own.slot_key !== issuance.forecastKey || own.effective_tick !== issuance.effectiveTick ||
      target.paper.id !== issuance.paper.id || target.paper.rev !== issuance.paper.rev ||
      target.itemId !== issuance.itemId || target.gradingVersion !== issuance.gradingVersion ||
      window.through !== issuance.through || issuance.startedAt < posttestOpensAt(window) ||
      !insideFrozenPosttestWindow(observation, window, own.effective_tick)) return false;
  return validatesWorkbookHistory(tx, target, observation.admittedAt, fact.ref.id, process.helpLevel === 'independent');
}

async function claimsMatch(
  input: FrozenInput,
  cutoff: Tick,
  open: () => Promise<ReopenWorkbook | undefined>,
) {
  const observations = input.observations.filter(row => row.exposure.kind !== 'unknown' || row.novelty === 'variant');
  // Cross-item evidence is stored in the canonical slice, outside the legacy observations list.
  const events = input.canonicalEvidence?.events ?? [];
  if (!observations.length && !events.length) return true;
  if (BigInt(cutoff) > BigInt(input.observedThrough)) return false;
  const reopen = await open();
  if (!reopen) return false;
  const comparable = new Map<string, ComparableWorkbook>();
  const ids = new Set([...observations.map(row => row.submission.id), ...events.map(row => factId(row.ref))]);
  for (const id of ids) {
    const row = await reopen(id);
    if (!row || row.evidence.observation.submittedAt > input.window.requestedAt) return false;
    comparable.set(id, row);
  }
  return observations.every(claim => {
    const { evidence, novelty } = comparable.get(claim.submission.id)!;
    const { observation } = evidence;
    return claim.submission.rev === observation.submission.rev && claim.admittedAt === observation.admittedAt &&
      claim.submittedAt === observation.submittedAt && claim.result === observation.result &&
      claim.exposure.kind === observation.exposure.kind &&
      (claim.exposure.kind !== 'exposed' ||
        (observation.exposure.kind === 'exposed' && sameWorkbookJson(claim.exposure.refs,observation.exposure.refs))) &&
      (claim.novelty ?? 'same-item') === (novelty === 'same' ? 'same-item' : 'variant');
  }) && events.every(claim => {
    const { evidence, novelty } = comparable.get(claim.ref)!;
    const { observation, process } = evidence;
    return claim.rev === observation.submission.rev && claim.occurred_at === observation.submittedAt &&
      claim.outcome === observation.result && claim.help_level === process.helpLevel && claim.item_novelty === novelty;
  });
}

export async function verifyFrozenWorkbookClaims(
  tx: ActivityEvidenceReadScope, row: NonNullable<Awaited<ReturnType<typeof recordedWorkbookForecast>>>, base: ReadContext,
  witnesses: Parameters<typeof frozenWorkbookReader>[2],
  open: (read: ReadContext, cutoff: Tick) => Promise<ReopenWorkbook | undefined>,
  unavailable: (error: unknown) => boolean,
) {
  const { input } = row.forecast;
  const cutoff = row.evidence_through ?? input.observedThrough;
  try {
    return await claimsMatch(input, cutoff, () => open(frozenWorkbookReader(tx, base, witnesses, cutoff), cutoff));
  } catch (error) {
    if (error instanceof FrozenWorkbookWitnessUnavailable || unavailable(error)) return false;
    throw error;
  }
}

export type PosttestListItem = { forecastKey: string; title: string; through: string; scheduledAt?: string; sourceReconciliationKey?: string } &
  ({ state: 'preparing' | 'scheduled'; scheduledAt: string } | { state: 'ready' } | { state: 'submitted'; reconciliationKey: string });

export type SlotRow<T, S> = {
  scope_keys: S;
  pending: string;
  last_id: string | null;
  last_error: { reason: string } | null;
  current_id: string | null;
  effective_tick: Tick | null;
  value: Outcome<T> | null;
  manifest: unknown;
};

export async function findWorkbookRetentionSlot<T, S>(tx: ActivityEvidenceReadScope, type: string, key: string) {
  const { rows: [row] } = await tx.query<SlotRow<T, S>>(
    `SELECT s.scope_keys, s.pending, s.last_id, s.last_error, d.id AS current_id, d.value, d.manifest, d.effective_tick::text
     FROM slot_state s LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       AND d.slot_type=s.slot_type AND d.slot_key=s.slot_key
       AND d.lifecycle='effective' AND d.invalidated_tick IS NULL AND NOT d.is_shadow
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
    [tx.learner, type, key],
  );
  return row;
}

export async function workbookEvidenceWatermark(tx: ActivityEvidenceReadScope) {
  const { rows: [row] } = await tx.query<{ clock: Tick }>('SELECT clock::text FROM learners WHERE id=$1', [tx.learner]);
  if (!row) throw new Error('学习者证据水位缺失。');
  return row.clock;
}

export function listWorkbookPosttestSlots<Scope>(tx: ActivityEvidenceReadScope, slotType: string,
  forecastKey: string | null, parentReconciliation: string | null) {
  return tx.query<{ slot_key: string; scope_keys: Scope; current_id: string | null }>(
    `SELECT s.slot_key, s.scope_keys, s.current_id FROM slot_state s JOIN facts f
       ON f.learner_id=s.learner_id AND f.id=s.scope_keys->'target'->'paper'->>'id'
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND f.type=$3 AND f.retracted_rev IS NULL
       AND (s.current_id IS NOT NULL OR (s.pending <> 'none' AND s.scope_keys ? 'sourceReconciliationKey'))
       AND (($4::text IS NULL AND $5::text IS NULL) OR s.slot_key=$4 OR s.scope_keys->>'sourceReconciliationKey'=$5)
     ORDER BY s.changed_tick DESC, s.slot_key LIMIT 24`,
    [tx.learner, slotType, retentionPaperType, forecastKey, parentReconciliation],
  );
}
