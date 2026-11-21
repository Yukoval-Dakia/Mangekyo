import type { BusWitness, CanonicalEvidenceSliceV1, FactSnapshot, Tick } from '@mangekyo/kernel';
import {
  extractionDecision, positiveEvidenceEdges, sameWitness, verifiedAttemptFromSlice, type BeliefEdge, type ExistingBelief,
} from './extraction.ts';
import { allows, instant, type Witness } from './memory-evidence.ts';

export const correctionCheckSuggestedMs = 30_000;
const dayMs = 86_400_000;
const research = 'background-research';
const teaching = 'teaching';
const retestGoal = '订正后补做一道同壳换数题';

// The host supplies the learner's recorded correction and the exact source question
// from the original incorrect submission, using the same admission clock as Activity.
export type RecordedCorrection = {
  source: BusWitness;
  originalQuestion: BusWitness;
  admittedAt: Tick;
  correctedAt: string;
};

export type CorrectionVariant = {
  question: BusWitness;
  // An opened Content knowledge edge with verified endpoints and proof.
  edge: BusWitness;
  kind: 'variant_of';
  from: Witness;
  to: Witness;
  verification: Witness;
  variant: { relation?: string; spoilsNext: string };
  basis: readonly BusWitness[];
  history: 'unseen' | 'seen' | 'unknown';
};

function isFreshNumbersVariant(original: BusWitness, candidate: CorrectionVariant) {
  const { question, edge, from, to, variant, verification, basis } = candidate;
  return question.id !== original.id && candidate.history === 'unseen' &&
    candidate.kind === 'variant_of' && edge.type === 'content.knowledgeEdge' &&
    variant.relation === 'numbers_only' && variant.spoilsNext === 'none' &&
    basis.some(ref => ref.type === 'content.knowledgeEdgeEvidence' && sameWitness(ref, verification)) &&
    ((sameWitness(original, from) && sameWitness(question, to)) ||
      (sameWitness(original, to) && sameWitness(question, from)));
}

// Use the recipient-authorized reader in the learner transaction. Missing or
// denied witnesses produce undefined. Transient failures propagate for retry.
export type CorrectionReopen = (ref: BusWitness, purpose: typeof teaching | typeof research) => Promise<FactSnapshot | undefined>;

async function matchesCurrent(reopen: CorrectionReopen, learner: BusWitness['learner'], ref: BusWitness,
  purpose: typeof teaching | typeof research) {
  if (ref.learner !== learner) return false;
  const opened = await reopen(ref, purpose);
  return opened?.ref.learner === learner && opened.type === ref.type && allows(opened.purpose, purpose) &&
    sameWitness({ ...opened.ref, accessEpoch: opened.accessEpoch }, ref);
}

async function current(reopen: CorrectionReopen, correction: RecordedCorrection, basis: readonly BusWitness[]) {
  const { source, originalQuestion } = correction;
  if (!await matchesCurrent(reopen, source.learner, { ...source, mode: 'following' }, research)) return false;
  for (const ref of [originalQuestion, ...basis])
    if (!await matchesCurrent(reopen, source.learner, ref, teaching)) return false;
  return true;
}

function variantBasis(candidate: CorrectionVariant) {
  return [candidate.question, candidate.edge, ...candidate.basis];
}

function todoSource({ id, rev, accessEpoch }: BusWitness) {
  return { id, revision: rev, accessEpoch };
}

function retestIntent(correction: RecordedCorrection, settingsRevision: number) {
  const fireAtMs = Date.parse(instant(correction.correctedAt)) + dayMs;
  return {
    dedupKey: `correction-retest:${correction.source.id}:${correction.source.rev}`,
    goal: retestGoal,
    workerProfile: 'deterministic_compute' as const,
    trigger: { kind: 'scheduled' as const, fireAtMs },
    sourceFactRev: todoSource(correction.source),
    refs: [todoSource(correction.originalQuestion)],
    autonomyTier: 1 as const,
    budgetCap: 0,
    settingsRevision,
    expiresAtMs: fireAtMs + dayMs,
  };
}

export type CorrectionRetest = ReturnType<typeof retestIntent>;
type TodoSource = { id: string; revision: number; accessEpoch: string };
type RetestSpec = Omit<CorrectionRetest, 'trigger' | 'workerProfile' | 'autonomyTier' | 'sourceFactRev' | 'refs'> & {
  trigger: { kind: string; fireAtMs?: number };
  workerProfile: string;
  autonomyTier: number;
  sourceFactRev: TodoSource;
  refs: readonly TodoSource[];
  parentTodoId?: string | undefined;
};

// The host supplies a successfully opened pool. An unavailable query must be
// retried by its caller. Schedule on the correction's first committed command.
export async function planCorrectionCheck(reopen: CorrectionReopen, correction: RecordedCorrection,
  pool: readonly CorrectionVariant[], settingsRevision: number, nowMs: number) {
  const correctedAtMs = Date.parse(instant(correction.correctedAt));
  if (!Number.isSafeInteger(nowMs) || nowMs < correctedAtMs ||
      !await current(reopen, correction, [])) return null;
  for (const candidate of pool) {
    if (isFreshNumbersVariant(correction.originalQuestion, candidate) && await current(reopen, correction, variantBasis(candidate))) {
      return { kind: 'offer' as const, variant: candidate, suggestedDurationMs: correctionCheckSuggestedMs };
    }
  }
  if (!Number.isSafeInteger(settingsRevision) || settingsRevision < 1) return null;
  const todo = retestIntent(correction, settingsRevision);
  return nowMs < todo.expiresAtMs ? { kind: 'scheduled' as const, todo } : null;
}

// Run in the Todo trigger's eligibility callback and again before accepting
// the dispatched generation. The coordinator checks enabled settings and the
// Work identity/state in the same learner transaction.
export async function correctionRetestDue(reopen: CorrectionReopen, correction: RecordedCorrection,
  spec: RetestSpec, settingsRevision: number, nowMs: number) {
  const expected = retestIntent(correction, settingsRevision);
  const matches = (actual: TodoSource | undefined, ref: TodoSource) =>
    actual?.id === ref.id && actual.revision === ref.revision && actual.accessEpoch === ref.accessEpoch;
  return Number.isSafeInteger(settingsRevision) && settingsRevision > 0 && spec.parentTodoId === undefined &&
    spec.dedupKey === expected.dedupKey && spec.goal === expected.goal &&
    spec.workerProfile === expected.workerProfile && spec.autonomyTier === expected.autonomyTier &&
    spec.budgetCap === 0 && spec.settingsRevision === settingsRevision && spec.trigger.kind === 'scheduled' &&
    spec.trigger.fireAtMs === expected.trigger.fireAtMs && spec.expiresAtMs === expected.expiresAtMs &&
    Number.isSafeInteger(nowMs) && nowMs >= expected.trigger.fireAtMs && nowMs < expected.expiresAtMs &&
    matches(spec.sourceFactRev, expected.sourceFactRev) && spec.refs.length === 1 &&
    matches(spec.refs[0], todoSource(correction.originalQuestion)) &&
    await current(reopen, correction, []);
}

export type ActiveMisconception = ExistingBelief & {
  ref: BusWitness;
  kind: 'misconception';
  evidenceSourceIds: readonly string[];
};

export type CorrectionObservation = {
  // The Activity reader has matched the immutable submission to the controlled
  // issuance for this correction, frozen item and formal grade. It supplies
  // the current basis at the same cutoff and the hypotheses assigned at issuance.
  source: BusWitness;
  // Explicit authorization for use of this result as durable memory evidence.
  authorization: BusWitness;
  issuance: BusWitness;
  issuedAt: Tick;
  itemId: string;
  basis: readonly BusWitness[];
  admittedAt: Tick;
  startedAt: string;
  through: string;
  window: 'immediate' | 'scheduled';
  variant: CorrectionVariant;
  cutoff: { tick: Tick; at: string };
  slice: CanonicalEvidenceSliceV1;
  fragment: { anchor: string; excerpt: string };
};

export type CorrectionContradiction = {
  edge: BeliefEdge;
  citation: Witness & { anchor: string; excerpt: string; direction: 'contradict' };
};

export async function correctionContradictions(reopen: CorrectionReopen, correction: RecordedCorrection,
  observation: CorrectionObservation, existing: readonly ActiveMisconception[]): Promise<CorrectionContradiction[]> {
  const { source, authorization, issuance, issuedAt, itemId, basis, admittedAt, startedAt,
    through, window, variant, cutoff, slice, fragment } = observation;
  const [event] = slice.events;
  const correctedMs = Date.parse(instant(correction.correctedAt));
  const startedMs = Date.parse(instant(startedAt));
  const dueMs = correctedMs + dayMs;
  if (!event || slice.events.length !== 1 || slice.omissions?.length || event.item_novelty !== 'isomorphic' ||
      slice.clock_watermark !== cutoff.tick || slice.as_of_at !== cutoff.at ||
      BigInt(issuedAt) < BigInt(correction.admittedAt) || BigInt(admittedAt) <= BigInt(issuedAt) ||
      BigInt(admittedAt) > BigInt(cutoff.tick) ||
      startedMs < correctedMs || (window === 'scheduled' && (startedMs < dueMs || startedMs >= dueMs + dayMs)) ||
      instant(through) <= startedAt || instant(event.occurred_at) < startedAt || event.occurred_at > through ||
      event.occurred_at > instant(cutoff.at) ||
      source.type !== 'activity.retentionPosttestSubmission' || issuance.type !== 'activity.retentionPosttest' ||
      fragment.anchor !== itemId || !itemId.trim() || itemId.length > 160 ||
      !fragment.excerpt.trim() || fragment.excerpt.length > 360 ||
      !isFreshNumbersVariant(correction.originalQuestion, variant)) return [];

  const attempt = verifiedAttemptFromSlice(source, [{ ref: source.id, rev: source.rev }], slice,
    { intervention: null, firstUnfamiliarPostLessonTransfer: false, mastery: null });
  if (!attempt?.independent || !attempt.allCorrect) return [];
  const openedBasis = [source, issuance, ...variantBasis(variant), ...basis];
  if (!await current(reopen, correction, openedBasis) ||
      !await matchesCurrent(reopen, correction.source.learner, { ...authorization, mode: 'following' }, research)) return [];

  const activity = { ref: source, admittedAt, kind: 'posttest', purpose: [research],
    conceptIds: event.concept_ids, occurredAt: event.occurred_at, origin: 'chronicle' } as const;
  const decision = extractionDecision(activity, {
    track: 'after-activity', explicitLearnerIntent: false, budgetAvailable: false,
    afterClock: correction.admittedAt, clockThrough: cutoff.tick, attempt,
  }, existing.filter(row => row.kind === 'misconception' && !row.evidenceSourceIds.includes(source.id)));

  const links: CorrectionContradiction[] = [];
  for (const entry of decision.contradictions) {
    const target = existing.find(row => sameWitness(row.ref, entry.hypothesis))?.ref;
    if (target?.type !== 'companion.memoryAssertion' || links.some(link => link.edge.to_ref.id === target.id) ||
        !await matchesCurrent(reopen, correction.source.learner, { ...target, mode: 'following' }, research)) continue;
    const [edge] = positiveEvidenceEdges({ ...decision, contradictions: [entry] }, [source, target]);
    if (!edge) continue;
    links.push({
      edge: { ...edge, basis: [correction.source, correction.originalQuestion, ...openedBasis, authorization] },
      citation: { id: source.id, rev: source.rev, accessEpoch: source.accessEpoch,
        anchor: fragment.anchor, excerpt: fragment.excerpt, direction: 'contradict' as const },
    });
  }
  return links;
}
