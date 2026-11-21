import type { BusWitness, FactSnapshot, LearnerId, Tick } from '@mangekyo/kernel';
import { instant } from './memory-evidence.ts';
import { learnerPreferenceType, type PreferenceScope } from './preference-values.ts';
import type { RetentionForecast } from './retention.ts';
import { classifyFrozenCrossing } from './retention-view.ts';
import { preferenceUnderstanding } from './understanding.ts';

const researchPurpose = 'background-research';
const factIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const dayMs = 86_400_000;

export type SentinelAccess = {
  learner: LearnerId;
  recipient: string;
  purpose: typeof researchPurpose;
  maySend(fact: FactSnapshot): boolean;
};

export type SentinelFact = { fact: FactSnapshot; witness: BusWitness };

function admitted(access: SentinelAccess, {fact, witness}: SentinelFact) {
  return access.purpose === researchPurpose && fact.ref.learner === access.learner && witness.learner === access.learner &&
    fact.ref.id === witness.id && fact.ref.rev === witness.rev && fact.type === witness.type &&
    fact.accessEpoch === witness.accessEpoch && fact.purpose.includes(researchPurpose) && access.maySend(fact) === true;
}

function shortText(value: string, size: number) {
  return Array.from(value).slice(0, size).join('');
}

// Same fields as the owner preference projection used by Memory Gateway. Scope
// comes from the current research target. An empty scope admits general preferences.
export function projectSentinelPreference(access: SentinelAccess, source: SentinelFact, scope: PreferenceScope) {
  if (source.fact.type !== learnerPreferenceType || source.witness.mode !== 'following' || !admitted(access, source)) return;
  const value = preferenceUnderstanding(source.fact.value);
  if (!Object.entries(value.scope).every(([key, field]) => scope[key as keyof PreferenceScope] === field)) return;
  return { id: source.witness.id, rev: source.witness.rev, ...value, text: shortText(value.text, 80) };
}

type OpenUnderstanding = {
  kind: string;
  text: string | null;
  scope: { kind: 'general' } | { kind: 'unknown' } | { kind: 'object'; object: string };
  ttl: string | null;
  sticky: boolean;
};

// The owner reader supplies scope and basis already resolved in this snapshot:
// current claim through companion, or the presentation of an extracted assertion
// after every citation was opened. A superseded/forgotten claim is not a source.
export type SentinelUnderstanding = {
  source: SentinelFact;
  basis: readonly SentinelFact[];
  current: OpenUnderstanding;
  origin: 'learner-directive' | 'extracted-observation';
};

function openUnderstanding(access: SentinelAccess, row: SentinelUnderstanding, at: string, objectId?: string) {
  const { source, basis, current, origin } = row;
  const expectedType = origin === 'learner-directive' ? 'companion.claim' : 'companion.memoryAssertion';
  if (source.fact.type !== expectedType || source.witness.mode !== 'following' || !admitted(access, source) ||
      !basis.every(item => admitted(access, item)) || (origin === 'extracted-observation' && !basis.length)) return;
  if (current.scope.kind === 'unknown' || (current.scope.kind === 'object' &&
      (objectId !== current.scope.object || !basis.some(item => item.fact.ref.id === objectId)))) return;
  if (!current.text?.trim() || (current.ttl !== null && instant(current.ttl) <= instant(at))) return;
  return { ...current, text: current.text, scope: current.scope.kind === 'general' ? 'general' : current.scope.object };
}

export function projectSentinelUnderstandingPreference(access: SentinelAccess, row: SentinelUnderstanding, at: string, objectId?: string) {
  const current = openUnderstanding(access, row, at, objectId);
  if (current?.kind !== 'preference') return;
  return { id: row.source.witness.id, rev: row.source.witness.rev, kind: current.kind, origin: row.origin,
    text: shortText(current.text, 80), scope: row.current.scope, ttl: current.ttl, sticky: current.sticky };
}

export function projectSentinelSignal(access: SentinelAccess, row: SentinelUnderstanding, at: string, objectId?: string) {
  const current = openUnderstanding(access, row, at, objectId);
  if (current?.kind !== 'state' || current.ttl === null) return;
  return { signal_id: row.source.witness.id, kind: current.kind, scope: current.scope, expires_at: current.ttl,
    fact_rev: String(row.source.witness.rev), text: shortText(current.text, 30), origin: row.origin };
}

// The host opens the effective owner selection with the retention reader, which
// validates the manifest and its historical inputs. The KC comes from the same
// basis, as resolved by Content. A frozen item bucket alone has no KC identity.
export type SentinelForecast = {
  learner: LearnerId;
  selection: { id: string; effectiveTick: Tick; value: RetentionForecast };
  basis: readonly SentinelFact[];
  knowledgePoint: SentinelFact;
  opensAt: string;
};

export function projectSentinelForecast(access: SentinelAccess, row: SentinelForecast, at: string, watermark: Tick) {
  const { learner, selection, basis, knowledgePoint, opensAt } = row;
  const { estimate, input } = selection.value;
  const { fact: concept, witness: conceptRef } = knowledgePoint;
  const kcId = conceptRef.id;
  const isConcept = (concept.type === 'content.asset' || concept.type === 'activity.workspaceEntry') &&
    concept.value !== null && typeof concept.value === 'object' && 'kind' in concept.value && concept.value.kind === 'concept';
  if (learner !== access.learner || !factIdPattern.test(selection.id) ||
      !basis.length || !basis.every(item => admitted(access, item)) || !admitted(access, knowledgePoint) ||
      !isConcept || !basis.some(({witness}) => witness.id === kcId && witness.type === conceptRef.type &&
        witness.rev === conceptRef.rev && witness.accessEpoch === conceptRef.accessEpoch && witness.mode === conceptRef.mode) ||
      BigInt(selection.effectiveTick) > BigInt(watermark) || estimate.kind !== 'probabilistic' ||
      input.target.activity !== 'frozen-workbook-item' || input.target.dimensions?.kcId !== kcId || estimate.bucket.kcId !== kcId ||
      !(estimate.uncertainty >= 0 && estimate.uncertainty <= 1)) return;
  const paper = input.target.paper;
  if (!basis.some(({witness}) => witness.id === paper.id && witness.rev === paper.rev &&
      (witness.type === 'activity.workbookPaper' || witness.type === 'activity.retentionPaper'))) return;
  const now = Date.parse(instant(at));
  const crossing = classifyFrozenCrossing(selection.value, opensAt, selection.effectiveTick, now, now + dayMs);
  if (!crossing?.inHorizon) return;
  return { forecast_id: selection.id, knowledge_point_id: kcId, predicted_crossing_at: crossing.at,
    // The method's evidence uncertainty is distinct from predicted recall probability.
    confidence: 1 - estimate.uncertainty, confidence_basis: 'one_minus_evidence_uncertainty' };
}

type Coverage = 'complete' | 'partial' | 'unknown' | 'unavailable';

// Coverage is the owner's attestation for the authorized view. Candidate totals
// before permission checks cannot establish either completeness or missing history.
export function sentinelReadRegion<T>(items: readonly T[], coverage: Coverage) {
  if (items.length) return { state: coverage === 'complete' ? 'available' as const : 'partial' as const, items };
  if (coverage === 'complete') return { state: 'empty' as const, items };
  if (coverage === 'unknown') return { state: 'unknown' as const, reason: 'missing_evidence' as const, items };
  return { state: 'unavailable' as const, reason: 'authorization_or_coverage' as const, items };
}

// At this baseline the coordinator has no owner-backed memo store.
export const sentinelMemos = { state: 'unavailable', reason: 'memo_owner_reader_unavailable', items: [] } as const;

export type SentinelReadBasis = {
  scope: Pick<SentinelAccess, 'learner' | 'recipient' | 'purpose'>;
  deletionWatermark: string;
  facts: readonly BusWitness[];
};

// Call with the send transaction's deletion watermark and an exact reopen using
// its recipient. The host also revalidates owner membership (claim supersession,
// TTL, current forecast selection) or builds a fresh projection under the lock.
export async function sentinelBasisCurrent(access: SentinelAccess, prepared: SentinelReadBasis, deletionWatermark: string,
  reopen: (witness: BusWitness) => Promise<FactSnapshot | undefined>) {
  if (access.purpose !== researchPurpose || prepared.scope.learner !== access.learner ||
      prepared.scope.purpose !== access.purpose || prepared.scope.recipient !== access.recipient ||
      prepared.deletionWatermark !== deletionWatermark) return false;
  for (const witness of prepared.facts) {
    if (witness.learner !== access.learner) return false;
    const fact = await reopen(witness);
    if (!fact || !admitted(access, {fact, witness})) return false;
  }
  return true;
}
