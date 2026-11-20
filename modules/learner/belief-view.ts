import type { BeliefTime, Directive, FactSnapshot, Hypothesis, RefusalBoundary } from '@mangekyo/kernel';
export type { RefusalBoundary } from '@mangekyo/kernel';
import { instant, record, text, witnessIdentity, type Witness } from './memory-evidence.ts';

export function refusalBoundary(value: unknown): RefusalBoundary {
  const {goal, intent_key, reopen_condition} = record(value);
  const goalKey = text(goal);
  const intentKey = text(intent_key);
  if (goalKey.trim() !== goalKey || intentKey.trim() !== intentKey)
    throw new Error('拒绝需要规范的目标与意图键。');
  const condition = record(reopen_condition);
  if (condition.kind === 'learner_request')
    return {goal: goalKey, intent_key: intentKey, reopen_condition: {kind: condition.kind}};
  if (condition.kind === 'at')
    return {goal: goalKey, intent_key: intentKey, reopen_condition: {kind: condition.kind, at: instant(condition.at)}};
  throw new Error('拒绝需要明确的重开条件。');
}

// Match the scheduler's canonical action identity.
export function blocksRefusal(boundary: RefusalBoundary, request: {
  goal: string; intent_key: string; learnerRequested: boolean; at: string;
}) {
  if (boundary.goal !== request.goal || boundary.intent_key !== request.intent_key) return false;
  return boundary.reopen_condition.kind === 'at'
    ? instant(request.at) < instant(boundary.reopen_condition.at)
    : !request.learnerRequested;
}

export const evidencePriority = {
  'learner-quote': 5, 'business-event': 5, 'first-hand-tool': 4, 'independent-verification': 3,
  'agent-inference': 2, 'agent-note': 1,
} as const;

export type AsOf = { validAt: string; knownAt: string };
function contains(from: string, until: string | null, at: string) {
  const start = instant(from);
  const end = until === null ? null : instant(until);
  if (end !== null && end < start) throw new Error('时间区间逆序。');
  return start <= at && (end === null || at < end);
}

// Call with revisions already admitted under *current* access policy, even for a historical read.
export function beliefsAsOf<T extends BeliefTime>(rows: readonly T[], when: AsOf) {
  const at = instant(when.validAt);
  const known = instant(when.knownAt);
  return rows.filter(row => contains(row.validFrom, row.validTo, at)
    && contains(row.recordedAt, row.supersededAt, known));
}

export type HypothesisEvidence = {
  ref: Witness; occurredAt: string; recordedAt: string;
  // The host supplies provenance from the opened source.
  origin: 'chronicle' | 'consolidation';
  source: keyof typeof evidencePriority;
  direction: 'supports' | 'contradicts' | 'unresolved';
  // A same-condition counterexample disputes a hypothesis. A later verified
  // independent outcome measures change after intervention under new conditions.
  assessment: 'observation' | 'independent-variant' | 'independent-transfer';
};
export type HypothesisStage = Hypothesis<unknown, unknown>['status'];

export function hypothesisView(history: readonly HypothesisEvidence[], when: AsOf) {
  const valid = instant(when.validAt);
  const known = instant(when.knownAt);
  const events = history.filter(e => e.origin === 'chronicle'
    && instant(e.occurredAt) <= valid && instant(e.recordedAt) <= known)
    .toSorted((a,b) => a.occurredAt.localeCompare(b.occurredAt) || a.ref.id.localeCompare(b.ref.id));
  let stage: HypothesisStage = 'tentative';
  const supports = new Set<string>();
  const counters = new Set<string>();
  let outcomeEvidence = false;
  const trajectory: {at: string; stage: HypothesisStage}[] = [];
  for (const event of events) {
    if (event.direction === 'unresolved' || event.source === 'learner-quote' ||
        !(evidencePriority[event.source] >= 3)) continue;
    if ((event.direction === 'supports' ? supports : counters).has(event.ref.id)) continue;
    const previous: HypothesisStage = stage;
    const independent = (event.source === 'independent-verification' || event.source === 'business-event')
      && (event.assessment === 'independent-variant' || event.assessment === 'independent-transfer');
    outcomeEvidence ||= independent;
    if (event.direction === 'supports') {
      supports.add(event.ref.id);
      if (independent && (stage === 'retired' || stage === 'improving')) stage = 'relapsed';
      else if (counters.size && stage !== 'relapsed') stage = 'disputed';
      else if (supports.size > 1 && stage !== 'relapsed') stage = 'supported';
    } else {
      counters.add(event.ref.id);
      if (!supports.size) continue;
      if (!independent) stage = 'disputed';
      else if (stage === 'improving' && event.assessment === 'independent-transfer' && counters.size > 1) stage = 'retired';
      else if (stage !== 'retired') stage = 'improving';
    }
    if (previous !== stage) trajectory.push({at: event.occurredAt, stage});
  }
  return {stage, trajectory, evidence: events, confidence: {
    statement: events.some(event => event.source === 'learner-quote') ? 'directly-attested' : 'unconfirmed',
    fact: stage, outcome: outcomeEvidence ? 'independently-observed' : 'unknown',
  }};
}

// The authority comes from the opened owner fact, never from a model-selected
// presentation label (old memoryAssertion v2 also carried kind="preference").
export function memoryFamily(factType: string) {
  switch (factType) {
    case 'learner.preference': case 'companion.claim': return 'directive';
    case 'companion.memoryAssertion': return 'hypothesis';
    case 'learner.playbook': return 'playbook';
    default: return undefined;
  }
}

type OwnerUnderstanding = {
  kind: string;
  text: string | null;
  scope: unknown;
  ttl: string | null;
  evidence_refs: readonly Witness[];
  sticky: boolean;
  refusal?: unknown;
};

// Compose the owning module's decoded value with its revision times. The bus
// supplies authorization and revision history, including claim supersession.
export function projectBelief<Value extends OwnerUnderstanding>(
  fact: Pick<FactSnapshot, 'type' | 'ref' | 'accessEpoch'>,
  value: Value,
  time: Omit<BeliefTime, 'validTo'> & Partial<Pick<BeliefTime, 'validTo'>>,
): {ref: Witness; value: Directive<Value['scope'], Value['evidence_refs'][number] | Witness>
  | Hypothesis<Value['scope'], Value['evidence_refs'][number]>} | undefined {
  const family = memoryFamily(fact.type);
  if ((family !== 'directive' && family !== 'hypothesis') || value.text === null) return;
  const ref = {id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch};
  const validUntil = [time.validTo, value.ttl].filter((at): at is string => at != null).map(instant).sort()[0] ?? null;
  const common = {...time, validTo: validUntil, text: value.text, scope: value.scope, sticky: value.sticky};
  const [first, ...rest] = value.evidence_refs;
  if (family === 'hypothesis') {
    if (first === undefined) return;
    const kind = value.kind === 'misconception' || value.kind === 'metacognitive_habit' ||
      value.kind === 'memoryAssertion' ? value.kind : 'observation';
    return {ref, value: {...common, evidence_refs: [first, ...rest], category: family, kind, status: 'tentative'}};
  }
  const directive = {...common, category: family, evidence_refs: [first ?? ref, ...rest]} as const;
  if (value.kind === 'refusal')
    return {ref, value: {...directive, kind: 'refusal', refusal: refusalBoundary(value.refusal)}};
  if (value.kind === 'state') {
    if (value.ttl === null) throw new Error('短期状态需要失效时间。');
    return {ref, value: {...directive, kind: 'state', validTo: validUntil ?? value.ttl}};
  }
  if (value.kind === 'preference' || value.kind === 'claim')
    return {ref, value: {...directive, kind: value.kind === 'preference' ? 'preference' : 'statement'}};
  return undefined;
}

// Effective at both time coordinates; caller has already resolved current
// authorization and learner-initiated supersession through the owning module.
export function effectiveDirective<T extends Directive<unknown, unknown>>(directive: T, when: AsOf): T | null {
  if (!beliefsAsOf([directive], when).length) return null;
  if (directive.kind === 'refusal' && directive.refusal.reopen_condition.kind === 'at'
      && instant(directive.refusal.reopen_condition.at) <= instant(when.validAt)) return null;
  return directive;
}

export type OpenHypothesis<Scope, Evidence> = {
  ref: Witness;
  value: Hypothesis<Scope, Evidence>;
};

// Read the owner revisions and logical edges admitted by the same bus snapshot.
// Opposite claims can remain valid simultaneously. Both sides stay addressable.
export function hypothesesAsOf<Scope, Evidence>(rows: readonly OpenHypothesis<Scope, Evidence>[],
  edges: readonly (BeliefTime & import('./extraction.ts').BeliefEdge)[], when: AsOf) {
  const visible = rows.filter(row => beliefsAsOf([row.value], when).length > 0);
  const endpoints = new Set(visible.map(row => witnessIdentity(row.ref)));
  const disputes = new Set<string>();
  const relations = beliefsAsOf(edges, when).filter(edge => {
    const from = witnessIdentity(edge.from_ref);
    const to = witnessIdentity(edge.to_ref);
    if (!endpoints.has(from) || !endpoints.has(to)) return false;
    if (edge.kind === 'contradicts') {
      if (from === to || !edge.basis.length) return false;
      disputes.add(from);
      disputes.add(to);
    }
    return true;
  });
  return {hypotheses: visible.map(row => disputes.has(witnessIdentity(row.ref))
    ? {...row, value: {...row.value, status: 'disputed' as const}} : row), relations};
}
