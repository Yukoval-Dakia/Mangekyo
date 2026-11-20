import type { BusWitness, CanonicalEvidenceSliceV1, Edge } from '@mangekyo/kernel';
import { allows, integer, text, type Witness } from './memory-evidence.ts';
import type { HypothesisStage } from './belief-view.ts';

export type ActivitySource = 'conversation' | 'attempt' | 'posttest' | 'intake' | 'notes' | 'artifact' | 'feedback';
export type ExtractionActivity = {
  ref: Witness; admittedAt: string; kind: ActivitySource; purpose: readonly string[];
  conceptIds: readonly string[]; occurredAt: string; origin: 'chronicle' | 'consolidation';
};
export type ExistingBelief = {
  ref: Witness; conceptIds: readonly string[]; stage: HypothesisStage; sticky: boolean;
};

export type VerifiedAttempt = {
  source: Witness;
  independent: boolean | 'unknown'; allCorrect: boolean; novelty: 'same-item' | 'variant' | 'transfer' | 'unknown';
  // These links come from the frozen assessment and intervention assignments.
  testedHypotheses: readonly string[]; intervention: Witness | null;
  firstUnfamiliarPostLessonTransfer: boolean; mastery: number | null;
};

// Freeze the complete set of item observations at submission. A slice can omit
// an item when permission or help history is missing; that is not an all-correct run.
export function verifiedAttemptFromSlice(source: Witness, expected: readonly {ref: string; rev: number}[],
  slice: CanonicalEvidenceSliceV1, context: Pick<VerifiedAttempt,
  'intervention' | 'firstUnfamiliarPostLessonTransfer' | 'mastery'>): VerifiedAttempt | null {
  const key = (ref: string, rev: number) => JSON.stringify([ref, rev]);
  const required = new Set(expected.map(item => key(item.ref, item.rev)));
  if (!required.size || required.size !== expected.length) return null;
  const events = slice.events.filter(item => required.has(key(item.ref, item.rev)));
  if (events.length !== required.size || new Set(events.map(item => key(item.ref, item.rev))).size !== required.size ||
      slice.omissions?.some(item => required.has(key(item.ref.id, item.ref.rev)))) return null;
  const novelty = events.some(item => item.item_novelty === 'same') ? 'same-item'
    : events.every(item => item.item_novelty === 'transfer') ? 'transfer' : 'variant';
  return {source, ...context, novelty,
    allCorrect: events.every(item => item.outcome === 'correct' && (item.score_norm === undefined || item.score_norm === 1)),
    independent: events.every(item => item.help_level === 'independent'),
    testedHypotheses: [...new Set(events.flatMap(item => item.claim_ids))]};
}

export function sameWitness(a: Witness, b: Witness) {
  return a.id === b.id && a.rev === b.rev && a.accessEpoch === b.accessEpoch;
}

export function extractionCandidates(conceptIds: readonly string[], existing: readonly ExistingBelief[], topK = 6) {
  const concepts = new Set(conceptIds);
  return existing.map(belief => ({belief, overlap: new Set(belief.conceptIds.filter(id => concepts.has(id))).size}))
    .filter(entry => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.belief.ref.id.localeCompare(b.belief.ref.id))
    .slice(0, integer(topK, 0)).map(entry => entry.belief);
}

function inClockWindow(at: string, after: string, through: string) {
  for (const value of [at, after, through]) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('活动批次需要学习者时钟刻度。');
  }
  return BigInt(after) < BigInt(at) && BigInt(at) <= BigInt(through);
}

export type ExtractionDecision = {
  source: Witness; track: 'noop' | 'immediate' | 'batch';
  model: 'none' | 'save_belief' | 'extract' | 'one-success-strategy';
  existing: Witness[];
  contradictions: {hypothesis: Witness; evidence: Witness}[];
  evaluateLift: {intervention: Witness; posttest: Witness} | null;
  bridge: {evidence: Witness; conceptIds: readonly string[]} | null;
};

// Admission metadata is host-owned. Compute effects before paid-model budget
// admission; a depleted extraction budget must not lose independent positives.
export function extractionDecision(activity: ExtractionActivity, host: {
  track: 'in-turn' | 'after-activity'; explicitLearnerIntent: boolean;
  afterClock: string; clockThrough: string; budgetAvailable: boolean;
  feedback?: {samePatternCount: number; hasReason: boolean};
  attempt?: VerifiedAttempt;
}, existing: readonly ExistingBelief[]): ExtractionDecision {
  const output: ExtractionDecision = {source: activity.ref, track: 'noop', model: 'none', existing: [], contradictions: [], evaluateLift: null, bridge: null};
  if (activity.origin !== 'chronicle') return output;
  if (host.track === 'in-turn') {
    if (activity.kind === 'conversation' && host.explicitLearnerIntent && allows(activity.purpose, 'teaching')) {
      output.track = 'immediate';
      output.model = 'save_belief';
    }
    return output;
  }
  if (!allows(activity.purpose, 'background-research') || !inClockWindow(activity.admittedAt, host.afterClock, host.clockThrough)) return output;
  let model: ExtractionDecision['model'] = 'extract';
  const related = extractionCandidates(activity.conceptIds, existing, existing.length);
  if (activity.kind === 'feedback' && (!host.feedback ||
      (!host.feedback.hasReason && integer(host.feedback.samePatternCount, 0) < 2))) return output;
  const attempt = host.attempt;
  if (attempt && (activity.kind === 'attempt' || activity.kind === 'posttest')) {
    if (!sameWitness(attempt.source, activity.ref)) throw new Error('作答核验来源不符。');
    if (attempt.allCorrect && attempt.independent === true) {
      const transferEligible = attempt.novelty === 'variant' || attempt.novelty === 'transfer';
      if (transferEligible) {
        output.contradictions = related.filter(item => !item.sticky && attempt.testedHypotheses.includes(item.ref.id)
          && (item.stage === 'supported' || item.stage === 'relapsed'))
          .map(item => ({hypothesis: item.ref, evidence: activity.ref}));
        if (attempt.intervention) output.evaluateLift = {intervention: attempt.intervention, posttest: activity.ref};
      }
      if (transferEligible && attempt.mastery !== null && attempt.mastery > 0.8 && attempt.mastery <= 1 && activity.conceptIds.length)
        output.bridge = {evidence: activity.ref, conceptIds: activity.conceptIds};
      model = output.contradictions.length || (attempt.firstUnfamiliarPostLessonTransfer && attempt.novelty === 'transfer')
        ? 'one-success-strategy' : 'none';
    }
  }
  if (host.budgetAvailable && model !== 'none') {
    output.track = 'batch';
    output.model = model;
    output.existing = related.slice(0, 6).map(item => item.ref);
  }
  return output;
}

export type BeliefEdge = Edge<Witness, 'supports' | 'contradicts' | 'supersedes' | 'related_to'>;

export function positiveEvidenceEdges(decision: ExtractionDecision, opened: readonly BusWitness[]): BeliefEdge[] {
  return decision.contradictions.map(({hypothesis, evidence}) => {
    const origin = opened.find(ref => sameWitness(ref, evidence));
    if (!origin || !opened.some(ref => ref.learner === origin.learner && sameWitness(ref, hypothesis)))
      throw new Error('逻辑边两端必须由同一学习者的总线读取见证。');
    return {from_ref: evidence, to_ref: hypothesis, kind: 'contradicts', basis: [origin],
      author: 'companion', confidence: null, sticky: false};
  });
}

export type OpenFragment = {anchor: string; text: string};
export type AgentMemoryEdit =
  | {op: 'noop'}
  | {op: 'observe'; text: string; anchor: string; start: number; excerpt: string}
  | {op: 'link'; target: string; direction: 'supports' | 'contradicts'; anchor: string; start: number; excerpt: string}
  | {op: 'success-strategy'; text: string; anchor: string; start: number; excerpt: string};

// Host calls this after semantic extraction, with the same admitted fragments
// and candidate set used for sampling. Authority and strength are host-owned.
export function admitExtraction(decision: ExtractionDecision, activity: ExtractionActivity,
  fragments: readonly OpenFragment[], existing: readonly ExistingBelief[], edits: readonly AgentMemoryEdit[]) {
  if (edits.length === 0 || (edits.length === 1 && edits[0]?.op === 'noop')) return [];
  if (!sameWitness(decision.source, activity.ref) || activity.origin !== 'chronicle' || !allows(activity.purpose, 'background-research') ||
      decision.track !== 'batch' || (decision.model !== 'extract' && decision.model !== 'one-success-strategy') ||
      edits.length > (decision.model === 'one-success-strategy' ? 1 : 4))
    throw new Error('活动用途、轨道或条目数无效。');
  const seen = new Set<string>();
  return edits.map(edit => {
    if (edit.op !== 'link' && edit.op !== 'observe' && edit.op !== 'success-strategy') throw new Error('抽取操作无效。');
    if ((edit.op === 'success-strategy') !== (decision.model === 'one-success-strategy')) throw new Error('超出本次抽取范围。');
    const fragment = fragments.find(item => item.anchor === edit.anchor);
    const start = integer(edit.start, 0);
    const excerpt = text(edit.excerpt);
    const end = start + excerpt.length;
    if (!fragment || fragment.text.slice(start, end) !== excerpt) throw new Error('活动证据不匹配。');
    const evidence = {...activity.ref, anchor: edit.anchor, start, end, excerpt};
    if (edit.op !== 'link') return {op: edit.op, text: text(edit.text), stage: 'tentative' as const, evidence};
    const prior = existing.find(item => item.ref.id === edit.target);
    if (!prior || prior.sticky || !decision.existing.some(ref => sameWitness(ref, prior.ref)) ||
        seen.has(edit.target) || (edit.direction !== 'supports' && edit.direction !== 'contradicts'))
      throw new Error('抽取只能关联已打开、可更新的目标。');
    seen.add(edit.target);
    return {op: edit.op, target: prior.ref, direction: edit.direction, evidence};
  });
}
