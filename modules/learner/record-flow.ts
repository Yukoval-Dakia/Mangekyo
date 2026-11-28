import type { AssessmentRevisionRefWire, CriterionObservationV2, FormalAssessmentWire } from '@mangekyo/kernel';
import { eventAttributedKcIds, eventKcOutcome, formalItemCriteriaV2, type FormalReleaseCriterionLike } from './evidence-slice-v2.ts';

export type RecordFlowMasteryLevel = 'unknown' | 'fragile' | 'developing' | 'solid';

export type RecordFlowIdentity = {
  readonly id: string;
  readonly rev: number;
  readonly kind: string;
  readonly title: string;
  readonly subject?: string;
  readonly updatedAt: string | null;
  readonly author: string;
};

export type RecordFlowMastery = {
  readonly level: RecordFlowMasteryLevel;
  readonly score: number | null;
  readonly retrievability: number | null;
  readonly evidenceCount: number;
};

export type RecordFlowMisconception = {
  readonly id: string;
  readonly summary: string;
  readonly errorStage?: string;
  readonly status: string;
  readonly supportCount: number;
  readonly contradictCount: number;
  readonly evidenceHref?: string;
};

export type RecordFlowAttempt = {
  readonly paperId: string;
  readonly paperTitle: string;
  readonly attemptId: string;
  readonly itemId: string;
  readonly verdict: string;
  readonly errorStage?: string;
  readonly scoreText?: string;
  readonly occurredAt: string | null;
  readonly href: string;
};

export type RecordFlowDiscussion = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly occurredAt: string | null;
  readonly href: string;
};

export type RecordFlowNeighbor = {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly relation: string;
  readonly direction: 'in' | 'out';
  readonly href: string;
};

export type RecordFlowNextAction = {
  readonly kind: 'practice' | 'review_mistake' | 'ask_companion' | 'open_graph';
  readonly label: string;
  readonly href: string;
};

export type RecordFlowProvenance = {
  readonly id: string;
  readonly rev?: number;
  readonly kind: string;
  readonly title: string;
  readonly relation: string;
  readonly originBadge: string;
  readonly excerpt?: string;
  readonly href: string | null;
};

export type RecordFlowView = {
  readonly identity: RecordFlowIdentity;
  readonly mastery: RecordFlowMastery;
  readonly misconceptions: readonly RecordFlowMisconception[];
  readonly attempts: readonly RecordFlowAttempt[];
  readonly discussions: readonly RecordFlowDiscussion[];
  readonly graphNeighbors: readonly RecordFlowNeighbor[];
  readonly provenance: readonly RecordFlowProvenance[];
  readonly derived: readonly RecordFlowProvenance[];
  readonly nextActions: readonly RecordFlowNextAction[];
};

export type WorkspaceRecordFlowSummary = {
  readonly masteryLevel?: RecordFlowMasteryLevel;
  readonly errorStageCount: number;
  readonly attemptCount: number;
  readonly discussionCount: number;
  readonly neighborCount: number;
  readonly conceptTags: readonly string[];
  readonly originLabel?: string;
};

export type AgentRecordFlow = {
  readonly mastery: RecordFlowMastery;
  readonly misconceptions: readonly RecordFlowMisconception[];
  readonly recentAttempts: readonly RecordFlowAttempt[];
  readonly graphNeighbors: readonly RecordFlowNeighbor[];
  readonly relatedDiscussions: readonly RecordFlowDiscussion[];
  readonly provenance: readonly RecordFlowProvenance[];
  readonly witnessFactIds: readonly string[];
};

export type LearnerModelFlowSignal = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly subject?: string;
  readonly mastery: RecordFlowMastery;
  readonly misconceptions: readonly RecordFlowMisconception[];
  readonly recentAttempts: readonly RecordFlowAttempt[];
  readonly graphNeighbors: readonly RecordFlowNeighbor[];
  readonly relatedDiscussions: readonly RecordFlowDiscussion[];
  readonly provenance: readonly RecordFlowProvenance[];
  readonly witnessFactIds: readonly string[];
};

export type GraphConceptFlowSource = {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly subject?: string;
  readonly semesterTag?: string;
  readonly masteryLevel: RecordFlowMasteryLevel;
  readonly retrievability: number | null;
  readonly errorStageCount: number;
  readonly linkedQuestionCount: number;
  readonly linkedAttemptCount: number;
  readonly goalId?: string;
};

export type RawFlowFact = {
  readonly id: string;
  readonly type: string;
  readonly rev: number;
  readonly author: string;
  readonly createdTick: string;
  readonly data: unknown;
};

export type RawFlowDerivation = {
  readonly id: string;
  readonly slotType: string;
  readonly slotKey: string;
  readonly value: unknown;
  readonly manifest?: unknown;
  readonly effectiveTick?: string;
};

export const FLOW_FACT_TYPES = [
  'content.asset',
  'content.knowledgeEdge',
  'content.textbookPage',
  'activity.workspaceEntry',
  'activity.workbookPaper',
  'activity.workbookAttempt',
  'activity.retentionPaper',
  'activity.retentionPosttestSubmission',
  'activity.recallSubmission',
  'activity.helpExposure',
  'activity.studyTurn',
  'activity.textMaterial',
  'activity.organizerNote',
  'activity.studyRecord',
  'activity.studyGoal',
  'plan.organizerTask',
  'companion.memoryAssertion',
  'capture.source',
] as const;

export const FLOW_DERIVATION_SLOT_TYPES = [
  'activity.workbookRubricAssessment',
  'activity.workbookFormalAssessment',
  'activity.teachingFeedback',
  'predict.forecast',
] as const;

type IndexedNeighbor = {
  readonly targetId: string;
  readonly relation: string;
  readonly direction: 'in' | 'out';
  readonly edgeFactId?: string;
};

export type IndexedAssessmentCriterion = {
  readonly criterionId: string;
  readonly state?: string;
  readonly outcome?: string;
  readonly earned?: number | null;
  readonly maximum?: number | null;
  readonly errorStage?: string;
  readonly evaluator?: { readonly id: string; readonly version: string };
  readonly inputs?: readonly { readonly slotId: string; readonly path: string }[];
  readonly kcLinks?: readonly {
    readonly kcId: string;
    readonly weight: number;
    readonly role: 'target' | 'prerequisite';
    readonly source: 'authored' | 'verified_edge' | 'question_fallback';
  }[];
  readonly interaction?: 'conjunctive' | 'compensatory';
};

type IndexedAssessment = {
  readonly verdict?: string;
  readonly errorStage?: string;
  readonly scoreText?: string;
  readonly assessedAt?: string;
  readonly hasFormalOutcomes?: boolean;
  readonly criteria?: readonly IndexedAssessmentCriterion[];
  readonly projectedCriteria?: readonly CriterionObservationV2[];
};

type FormalAssessmentResultWire = {
  readonly releaseRef?: AssessmentRevisionRefWire;
  readonly submissionRef: AssessmentRevisionRefWire;
  readonly outcomes: FormalAssessmentWire['result']['outcomes'];
};
type LegacyFormalAssessmentResult = Partial<FormalAssessmentResultWire> & {
  readonly items?: readonly unknown[];
};
type FormalAssessmentForFlow = { readonly result: FormalAssessmentResultWire } & Omit<FormalAssessmentWire, 'result'>;
type AssertWire<T extends U, U> = T;
type _AssessmentRevisionRefWireCheck = AssertWire<AssessmentRevisionRefWire, { readonly id: string; readonly rev: number }>;
type _FormalAssessmentWireCheck = AssertWire<FormalAssessmentForFlow, FormalAssessmentWire>;

type IndexedForecast = {
  readonly paperId?: string;
  readonly itemId?: string;
  readonly conceptId?: string;
  readonly probability: number;
  readonly effectiveTick: bigint;
};

type IndexedFeedback = {
  readonly turnId: string;
  readonly message: string;
  readonly referencedIds: readonly string[];
  readonly writtenIds: readonly string[];
  readonly isCrisis?: boolean;
};

type IndexedProvenanceLink = {
  readonly targetId: string;
  readonly rev?: number;
  readonly relation?: string;
  readonly excerpt?: string;
  readonly edgeFactId?: string;
};

export type FlowGraphSnapshot = {
  readonly factsById: ReadonlyMap<string, RawFlowFact>;
  readonly neighborsById: ReadonlyMap<string, readonly IndexedNeighbor[]>;
  readonly upstreamById: ReadonlyMap<string, readonly IndexedProvenanceLink[]>;
  readonly downstreamById: ReadonlyMap<string, readonly IndexedProvenanceLink[]>;
  readonly onboardingTaggedIds: ReadonlySet<string>;
  readonly attemptsByFact: ReadonlyMap<string, readonly RawFlowFact[]>;
  readonly assessmentsByKey: ReadonlyMap<string, IndexedAssessment>;
  readonly assertionsByRef: ReadonlyMap<string, readonly RawFlowFact[]>;
  readonly turnsByRef: ReadonlyMap<string, readonly RawFlowFact[]>;
  readonly feedbackByTurnId: ReadonlyMap<string, IndexedFeedback>;
  readonly forecastsByConcept: ReadonlyMap<string, readonly IndexedForecast[]>;
  readonly forecastsByPaperItem: ReadonlyMap<string, readonly IndexedForecast[]>;
  readonly paperIdsByQuestion: ReadonlyMap<string, readonly string[]>;
  readonly paperIdsByMaterial: ReadonlyMap<string, readonly string[]>;
};

export type CrisisScope = {
  /** Crisis turn ids plus every other turn sharing a crisis session id (D10 session-wide isolation). */
  readonly turnIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
};

const crisisScopeCache = new WeakMap<FlowGraphSnapshot, CrisisScope>();

/**
 * Derive the session-wide D10 crisis scope once per snapshot: any turn sharing a
 * session with a crisis turn is tainted, and multi-turn sessions never leak through
 * single-turn lookups.
 */
export function crisisScopeFromSnap(snap: FlowGraphSnapshot | undefined): CrisisScope {
  if (!snap) return { turnIds: new Set<string>(), sessionIds: new Set<string>() };
  const cached = crisisScopeCache.get(snap);
  if (cached) return cached;
  const sessionByTurn = new Map<string, string>();
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'activity.studyTurn') continue;
    const data = rec(fact.data);
    const sessionId = str(data.sessionId);
    if (sessionId) sessionByTurn.set(fact.id, sessionId);
  }
  const sessionIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const [turnId, feedback] of snap.feedbackByTurnId) {
    if (!feedback.isCrisis) continue;
    turnIds.add(turnId);
    const sessionId = sessionByTurn.get(turnId);
    if (sessionId) sessionIds.add(sessionId);
    else sessionIds.add(turnId);
  }
  if (sessionIds.size) {
    for (const [turnId, sessionId] of sessionByTurn) {
      if (sessionIds.has(sessionId)) turnIds.add(turnId);
    }
  }
  const scope: CrisisScope = { turnIds, sessionIds };
  crisisScopeCache.set(snap, scope);
  return scope;
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function clip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function addToMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addNeighbor(map: Map<string, IndexedNeighbor[]>, fromId: string, toId: string, relation: string, edgeFactId?: string) {
  if (!fromId || !toId || fromId === toId) return;
  const edge = edgeFactId ? { edgeFactId } : {};
  addToMap(map, fromId, { targetId: toId, relation, direction: 'out', ...edge });
  addToMap(map, toId, { targetId: fromId, relation, direction: 'in', ...edge });
}

function factKindFrom(type: string, data: Record<string, unknown>): string {
  if (type === 'content.asset' || type === 'activity.workspaceEntry') {
    const k = str(data.kind);
    if (k) return k;
  }
  switch (type) {
    case 'activity.workbookPaper': return 'paper';
    case 'activity.workbookAttempt': return 'attempt';
    case 'content.textbookPage': return 'textbook';
    case 'activity.textMaterial': return 'material';
    case 'activity.organizerNote': return 'note';
    case 'activity.studyGoal': return 'goal';
    case 'plan.organizerTask': return 'task';
    case 'activity.studyTurn': return 'discussion';
    case 'companion.memoryAssertion': return 'misconception';
    case 'capture.source': return str(data.kind) === 'notion' ? 'notion' : 'material';
    default: return 'record';
  }
}

function factKind(fact: RawFlowFact): string {
  return factKindFrom(fact.type, rec(fact.data));
}

export type BasisFactMeta = {
  readonly title?: string;
  readonly kind?: string;
};

/**
 * Pure display projection for session workspaceBasis witnesses: extracts a
 * concise human-readable title (<= 48 chars) and semantic kind without DB/IO.
 */
export function describeBasisFact(type: string, data: unknown): BasisFactMeta {
  const d = rec(data);
  const rawTitle =
    str(d.title) ||
    str(d.canonicalName) ||
    str(d.name) ||
    str(d.text) ||
    str(d.prompt) ||
    str(d.answer) ||
    str(d.body);
  const title = rawTitle ? clip(rawTitle, 48) : undefined;
  const kind = factKindFrom(type, d);
  return {
    ...(title ? { title } : {}),
    ...(kind && kind !== 'record' ? { kind } : {}),
  };
}

function factTitle(fact: RawFlowFact): string {
  const data = rec(fact.data);
  const direct =
    str(data.title) ||
    str(data.canonicalName) ||
    str(data.name) ||
    str(data.text) ||
    str(data.prompt) ||
    str(data.answer) ||
    str(data.body);
  if (direct) return clip(direct, 96);
  const kind = factKind(fact);
  return `${kind} · ${fact.id.slice(0, 8)}`;
}

function factSubject(fact: RawFlowFact): string | undefined {
  const data = rec(fact.data);
  const direct = str(data.subject) || str(data.discipline) || str(data.topic);
  if (direct) return clip(direct, 64);
  const scope = rec(data.scope);
  const scoped = str(scope.subject) || str(scope.topic);
  return scoped ? clip(scoped, 64) : undefined;
}

function factUpdatedAt(fact: RawFlowFact): string | null {
  const data = rec(fact.data);
  for (const key of ['updatedAt', 'submittedAt', 'savedAt', 'occurredAt', 'capturedAt', 'createdAt', 'recordedAt']) {
    const v = str(data[key]);
    if (v) return v;
  }
  return null;
}

function factTags(fact: RawFlowFact): string[] {
  const data = rec(fact.data);
  const out: string[] = [];
  for (const item of arr(data.tags)) {
    const t = typeof item === 'string' ? str(item) : str(rec(item).term);
    if (t && !out.includes(t)) out.push(t);
  }
  const subj = factSubject(fact);
  if (subj && !out.includes(subj)) out.push(subj);
  return out;
}

function recordHref(fact: RawFlowFact, factsById: ReadonlyMap<string, RawFlowFact>): string {
  const kind = factKind(fact);
  if (kind === 'paper') return `/papers/${fact.id}`;
  if (kind === 'textbook') return `/textbooks/page?id=${fact.id}`;
  if (kind === 'attempt') {
    const paperId = str(rec(fact.data).paperId);
    if (paperId) return `/papers/${paperId}?attempt=${fact.id}`;
  }
  if (kind === 'discussion') {
    const sessionId = str(rec(fact.data).sessionId) || fact.id;
    return `/companion?session=${sessionId}`;
  }
  if (kind === 'material' && factsById.has(fact.id)) return `/materials/saved/${fact.id}`;
  return `/materials/records/${fact.id}`;
}

function extractRefIdsFromValue(value: unknown, into: Set<string>, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) extractRefIdsFromValue(item, into, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const key of ['id', 'factId', 'sourceId', 'materialId', 'paperId', 'attemptId', 'conceptId', 'questionId']) {
    const v = obj[key];
    if (typeof v === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v)) into.add(v);
  }
  for (const key of ['ref', 'fact', 'sourceRef', 'sourceUse', 'attachment', 'currentObject', 'inputs', 'reads', 'writes', 'evidenceIds']) {
    if (key in obj) {
      const nested = obj[key];
      if (key === 'evidenceIds' && Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(item)) into.add(item);
        }
      } else {
        extractRefIdsFromValue(nested, into, depth + 1);
      }
    }
  }
}

function parseScoreText(score: unknown): string | undefined {
  const s = rec(score);
  const earned = num(s.earned);
  const maximum = num(s.maximum);
  if (earned !== null && maximum !== null && maximum > 0) return `${earned}/${maximum}`;
  return undefined;
}

function parseTick(value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) return 0n;
  return BigInt(value);
}

/**
 * Index active facts and effective derivations into an in-memory multi-hop
 * lookup graph with zero database or network side effects.
 */
export function indexRecordFlowSnapshot(
  facts: readonly RawFlowFact[],
  derivations: readonly RawFlowDerivation[],
): FlowGraphSnapshot {
  const factsById = new Map<string, RawFlowFact>();
  const neighborsById = new Map<string, IndexedNeighbor[]>();
  const upstreamById = new Map<string, IndexedProvenanceLink[]>();
  const downstreamById = new Map<string, IndexedProvenanceLink[]>();
  const onboardingTaggedIds = new Set<string>();
  const attemptsByFact = new Map<string, RawFlowFact[]>();
  const assessmentsByKey = new Map<string, IndexedAssessment>();
  const assertionsByRef = new Map<string, RawFlowFact[]>();
  const turnsByRef = new Map<string, RawFlowFact[]>();
  const feedbackByTurnId = new Map<string, IndexedFeedback>();
  const forecastsByConcept = new Map<string, IndexedForecast[]>();
  const forecastsByPaperItem = new Map<string, IndexedForecast[]>();
  const paperIdsByQuestion = new Map<string, string[]>();
  const paperIdsByMaterial = new Map<string, string[]>();

  const linkProvenance = (
    childId: string,
    parentId: string,
    meta?: { rev?: number; upstreamRelation?: string; derivedRelation?: string; excerpt?: string; edgeFactId?: string },
  ) => {
    if (!childId || !parentId || childId === parentId) return;
    addToMap(upstreamById, childId, {
      targetId: parentId,
      ...(meta?.rev !== undefined ? { rev: meta.rev } : {}),
      ...(meta?.upstreamRelation ? { relation: meta.upstreamRelation } : {}),
      ...(meta?.excerpt ? { excerpt: meta.excerpt } : {}),
      ...(meta?.edgeFactId ? { edgeFactId: meta.edgeFactId } : {}),
    });
    addToMap(downstreamById, parentId, {
      targetId: childId,
      ...(meta?.derivedRelation ? { relation: meta.derivedRelation } : {}),
      ...(meta?.excerpt ? { excerpt: meta.excerpt } : {}),
      ...(meta?.edgeFactId ? { edgeFactId: meta.edgeFactId } : {}),
    });
  };

  for (const fact of facts) factsById.set(fact.id, fact);

  // Index effective derivations first so turns and attempts can enrich from them.
  for (const deriv of derivations) {
    const rawVal = rec(deriv.value);
    const envelopeKind = str(rawVal.kind);
    if (envelopeKind === 'unknown' || envelopeKind === 'error' || envelopeKind === 'failed' || envelopeKind === 'rejected') continue;
    const val = envelopeKind === 'value' && rawVal.value !== null && typeof rawVal.value === 'object' && !Array.isArray(rawVal.value)
      ? rec(rawVal.value)
      : rawVal;
    if (deriv.slotType === 'activity.teachingFeedback') {
      if (val.carePause) {
        feedbackByTurnId.set(deriv.slotKey, { turnId: deriv.slotKey, message: '', referencedIds: [], writtenIds: [], isCrisis: true });
        continue;
      }
      const refs = new Set<string>();
      extractRefIdsFromValue(deriv.manifest, refs);
      extractRefIdsFromValue(val, refs);
      const writtenIds = new Set<string>();
      for (const w of arr(val.writes)) {
        const wRec = rec(w);
        const wId = str(wRec.id) || str(rec(wRec.ref).id);
        if (wId && wId !== deriv.slotKey) writtenIds.add(wId);
      }
      feedbackByTurnId.set(deriv.slotKey, {
        turnId: deriv.slotKey,
        message: clip(str(val.message) || str(val.rationale), 180),
        referencedIds: [...refs],
        writtenIds: [...writtenIds],
      });
      continue;
    }

    if (deriv.slotType === 'activity.workbookRubricAssessment') {
      const attemptId = str(val.attemptId);
      const questionId = str(val.questionId);
      if (attemptId && questionId) {
        const key = `${attemptId}:${questionId}`;
        const verdict = str(val.verdict);
        const errorStage = str(val.errorStage) || str(val.error_stage);
        const scoreText = parseScoreText(val.score);
        const assessedAt = str(val.assessedAt);
        const existing = assessmentsByKey.get(key);
        if (existing?.hasFormalOutcomes) {
          if (!existing.verdict && verdict) {
            assessmentsByKey.set(key, {
              ...existing,
              verdict,
              ...(errorStage && !existing.errorStage && verdict !== 'correct' ? { errorStage } : {}),
              ...(scoreText && !existing.scoreText ? { scoreText } : {}),
              ...(assessedAt && !existing.assessedAt ? { assessedAt } : {}),
            });
          }
          continue;
        }
        assessmentsByKey.set(key, {
          ...(verdict ? { verdict } : {}),
          ...(errorStage ? { errorStage } : {}),
          ...(scoreText ? { scoreText } : {}),
          ...(assessedAt ? { assessedAt } : {}),
        });
      }
      continue;
    }

    if (deriv.slotType === 'activity.workbookFormalAssessment') {
      const result = rec(val.result) as LegacyFormalAssessmentResult;
      const attemptId = str(rec(result.submissionRef).id) || str(val.attemptId) || str(rec(val.submissionRef).id);
      const rawOutcomes = arr(result.outcomes);
      const rawCriteria = arr(val.criteria);
      const parseCriterionMeta = (raw: unknown) => {
        const c = rec(raw);
        const evalRec = rec(c.evaluator);
        const evaluator = str(evalRec.id) && str(evalRec.version)
          ? { id: str(evalRec.id), version: str(evalRec.version) } : undefined;
        const inputs = arr(c.inputs).map(rec)
          .filter(i => str(i.slotId) && typeof i.path === 'string')
          .map(i => ({ slotId: str(i.slotId), path: i.path as string }));
        const kcLinks = arr(c.kcLinks).map(rec)
          .filter(l => str(l.kcId) && num(l.weight) !== null)
          .map(l => ({
            kcId: str(l.kcId),
            weight: num(l.weight)!,
            role: (str(l.role) === 'prerequisite' ? 'prerequisite' : 'target') as 'target' | 'prerequisite',
            source: (str(l.source) === 'authored' || str(l.source) === 'verified_edge'
              ? str(l.source) : 'question_fallback') as 'authored' | 'verified_edge' | 'question_fallback',
          }));
        const inter = str(c.interaction);
        return {
          itemId: str(c.itemId) || str(c.questionId),
          criterionId: str(c.criterionId),
          maximum: c.maximum === null ? null : num(c.maximum) ?? undefined,
          outcome: str(c.outcome) || undefined,
          earned: num(c.earned) ?? undefined,
          ...(evaluator ? { evaluator } : {}),
          ...(inputs.length ? { inputs } : {}),
          ...(kcLinks.length ? { kcLinks } : {}),
          ...(inter === 'conjunctive' || inter === 'compensatory' ? { interaction: inter as 'conjunctive' | 'compensatory' } : {}),
        };
      };
      if (rawOutcomes.length > 0 && attemptId) {
        const metaByKey = new Map<string, ReturnType<typeof parseCriterionMeta>>();
        for (const raw of rawCriteria) {
          const parsed = parseCriterionMeta(raw);
          if (parsed.itemId && parsed.criterionId) metaByKey.set(`${parsed.itemId}:${parsed.criterionId}`, parsed);
        }
        const grouped = new Map<string, {
          criteria: IndexedAssessmentCriterion[];
          verdict?: string;
          errorStages: Set<string>;
          scoreText?: string;
        }>();
        for (const rawItem of rawOutcomes) {
          const item = rec(rawItem);
          const itemId = str(item.itemId) || str(item.questionId) || str(rec(item.item).id);
          if (!itemId) continue;
          const bucket = grouped.get(itemId) ?? { criteria: [], errorStages: new Set<string>() };
          const criterionId = str(item.criterionId);
          const state = str(item.state) || undefined;
          const verdict = str(item.verdict) || str(item.result) || str(item.outcome) || undefined;
          const errorStage = str(item.errorStage) || str(item.error_stage) || undefined;
          const scoreText = parseScoreText(item.score);
          if (verdict && !bucket.verdict) bucket.verdict = verdict;
          if (scoreText && !bucket.scoreText) bucket.scoreText = scoreText;
          if (errorStage) bucket.errorStages.add(errorStage);
          if (criterionId) {
            const meta = metaByKey.get(`${itemId}:${criterionId}`);
            const earned = num(item.earned) ?? meta?.earned ?? null;
            const outcomeVal = meta?.outcome || verdict;
            bucket.criteria.push({
              criterionId,
              ...(state ? { state } : {}),
              ...(outcomeVal ? { outcome: outcomeVal } : {}),
              earned,
              ...(meta?.maximum !== undefined ? { maximum: meta.maximum } : {}),
              ...(errorStage ? { errorStage } : {}),
              ...(meta?.evaluator ? { evaluator: meta.evaluator } : {}),
              ...(meta?.inputs ? { inputs: meta.inputs } : {}),
              ...(meta?.kcLinks ? { kcLinks: meta.kcLinks } : {}),
              ...(meta?.interaction ? { interaction: meta.interaction } : {}),
            });
          }
          grouped.set(itemId, bucket);
        }
        const attemptData = rec(factsById.get(attemptId)?.data);
        const attemptPaperId = str(attemptData.paperId);
        const attemptPaperData = rec((attemptPaperId ? factsById.get(attemptPaperId)?.data : undefined) ?? attemptData.paper);
        const releaseCriteriaByItem = new Map<string, FormalReleaseCriterionLike[]>();
        for (const rawRelItem of arr(rec(attemptPaperData.assessmentRelease).items)) {
          const rItem = rec(rawRelItem);
          const rItemId = str(rItem.itemId);
          if (!rItemId) continue;
          const parsed = arr(rItem.criteria).map(rawCrit => {
            const c = parseCriterionMeta(rawCrit);
            return {
              criterionId: c.criterionId,
              maximum: c.maximum ?? null,
              inputs: c.inputs ?? [],
              evaluator: c.evaluator ?? { id: 'workbook-formal-assessment', version: '1' },
              ...(c.kcLinks ? { kcLinks: c.kcLinks } : {}),
              ...(c.interaction ? { interaction: c.interaction } : {}),
            };
          }).filter(c => c.criterionId);
          if (parsed.length) releaseCriteriaByItem.set(rItemId, parsed);
        }
        for (const [itemId, bucket] of grouped) {
          const key = `${attemptId}:${itemId}`;
          const prior = assessmentsByKey.get(key);
          const singleStage = bucket.errorStages.size === 1 ? [...bucket.errorStages][0] : undefined;
          const projected = bucket.criteria.length
            ? formalItemCriteriaV2(bucket.criteria, releaseCriteriaByItem.get(itemId))
            : undefined;
          const settled = Boolean(projected && projected.outcome !== 'unknown');
          let formalScoreText: string | undefined;
          if (settled && projected) {
            let earned = 0;
            let maximum = 0;
            for (const c of projected.criteria) {
              if (c.earned !== null && c.maximum !== null && c.maximum > 0) {
                earned += Math.min(c.maximum, Math.max(0, c.earned));
                maximum += c.maximum;
              }
            }
            if (maximum > 0) formalScoreText = `${earned}/${maximum}`;
          }
          const verdict = (settled ? projected!.outcome : undefined) ?? bucket.verdict ?? prior?.verdict;
          const scoreText = formalScoreText ?? bucket.scoreText ?? prior?.scoreText;
          const errorStage = settled
            ? (projected!.outcome === 'correct' ? undefined : (projected!.errorStage ?? singleStage))
            : (projected?.errorStage ?? singleStage ?? prior?.errorStage);
          assessmentsByKey.set(key, {
            ...(verdict ? { verdict } : {}),
            ...(errorStage ? { errorStage } : {}),
            ...(scoreText ? { scoreText } : {}),
            ...(prior?.assessedAt ? { assessedAt: prior.assessedAt } : {}),
            ...(bucket.criteria.length ? { hasFormalOutcomes: true, criteria: bucket.criteria } : {}),
            ...(projected?.criteria.length ? { projectedCriteria: projected.criteria } : {}),
          });
        }
        continue;
      }
      const items = arr(result.items).length ? arr(result.items) : arr(val.items);
      for (const rawItem of items) {
        const item = rec(rawItem);
        const questionId = str(item.questionId) || str(item.itemId) || str(rec(item.item).id);
        if (!attemptId || !questionId) continue;
        const verdict = str(item.verdict) || str(item.result) || str(item.outcome);
        const errorStage = str(item.errorStage) || str(item.error_stage);
        const scoreText = parseScoreText(item.score);
        const key = `${attemptId}:${questionId}`;
        if (!assessmentsByKey.has(key)) {
          assessmentsByKey.set(key, {
            ...(verdict ? { verdict } : {}),
            ...(errorStage ? { errorStage } : {}),
            ...(scoreText ? { scoreText } : {}),
          });
        }
      }
      continue;
    }

    if (deriv.slotType === 'predict.forecast') {
      const probability = num(rec(val.prediction).probability) ?? num(val.probability);
      if (probability === null || probability < 0 || probability > 1) continue;
      const target = rec(val.target);
      const paperId = str(rec(target.paper).id);
      const itemId = str(target.itemId);
      const conceptId = str(rec(target.dimensions).kcId) || str(val.conceptId);
      const entry: IndexedForecast = {
        ...(paperId ? { paperId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(conceptId ? { conceptId } : {}),
        probability,
        effectiveTick: parseTick(deriv.effectiveTick),
      };
      if (conceptId) addToMap(forecastsByConcept, conceptId, entry);
      if (paperId && itemId) addToMap(forecastsByPaperItem, `${paperId}:${itemId}`, entry);
    }
  }

  // Pre-compute session-wide D10 crisis isolation before indexing turns.
  const crisisSessionIds = new Set<string>();
  {
    const crisisTurnIds: string[] = [];
    for (const [turnId, feedback] of feedbackByTurnId) {
      if (feedback.isCrisis) crisisTurnIds.push(turnId);
    }
    for (const turnId of crisisTurnIds) {
      const fact = factsById.get(turnId);
      const sessionId = fact && fact.type === 'activity.studyTurn' ? str(rec(fact.data).sessionId) : '';
      crisisSessionIds.add(sessionId || turnId);
    }
  }
  // Index structural links, papers, attempts, assertions, and discussions.
  for (const fact of facts) {
    const data = rec(fact.data);

    if (fact.type === 'content.knowledgeEdge') {
      const fromId = str(rec(rec(data.from).sourceUse).id);
      const toId = str(rec(rec(data.to).sourceUse).id);
      const relation = str(data.kind) || 'related_to';
      const scope = str(data.scope);
      addNeighbor(neighborsById, fromId, toId, relation, fact.id);
      if (scope.startsWith('冷启动')) {
        if (fromId) onboardingTaggedIds.add(fromId);
        if (toId) onboardingTaggedIds.add(toId);
      }
      if (relation === 'derived_from') {
        linkProvenance(fromId, toId, { edgeFactId: fact.id });
      } else if (relation === 'maps_to_chapter') {
        linkProvenance(fromId, toId, { upstreamRelation: '源自教材', edgeFactId: fact.id });
      }
      continue;
    }

    if (fact.type === 'activity.workbookPaper') {
      const materialId = str(data.materialId);
      if (materialId) {
        addToMap(paperIdsByMaterial, materialId, fact.id);
        addNeighbor(neighborsById, fact.id, materialId, 'derived_from');
        linkProvenance(fact.id, materialId, { upstreamRelation: '来自原件', derivedRelation: '派生试卷' });
      }
      for (const rawQ of arr(data.questions)) {
        const q = rec(rawQ);
        const srcRef = rec(q.sourceQuestionRef);
        const sourceQId = str(srcRef.id);
        const sourceQRev = num(srcRef.rev);
        if (sourceQId) {
          addToMap(paperIdsByQuestion, sourceQId, fact.id);
          addNeighbor(neighborsById, fact.id, sourceQId, 'contains_question');
          linkProvenance(fact.id, sourceQId, {
            ...(sourceQRev !== null ? { rev: sourceQRev } : {}),
            upstreamRelation: '源于源题',
            derivedRelation: '派生试卷',
          });
        }
      }
      continue;
    }

    if (fact.type === 'activity.workbookAttempt') {
      const paperId = str(data.paperId);
      addToMap(attemptsByFact, fact.id, fact);
      if (paperId) {
        addToMap(attemptsByFact, paperId, fact);
        addNeighbor(neighborsById, fact.id, paperId, 'attempt_of');
        linkProvenance(fact.id, paperId, { upstreamRelation: '对应试卷', derivedRelation: '派生作答' });
        const paper = factsById.get(paperId);
        if (paper) {
          const paperData = rec(paper.data);
          const materialId = str(paperData.materialId);
          if (materialId) addToMap(attemptsByFact, materialId, fact);
          for (const rawQ of arr(paperData.questions)) {
            const sourceQId = str(rec(rec(rawQ).sourceQuestionRef).id);
            if (sourceQId) addToMap(attemptsByFact, sourceQId, fact);
          }
        }
      }
      // The frozen paper embedded in the attempt is itself a complete mapping source:
      // paperless or stale-paper attempts still attribute items to their source questions.
      for (const rawQ of arr(rec(data.paper).questions)) {
        const sourceQId = str(rec(rec(rawQ).sourceQuestionRef).id);
        if (sourceQId) addToMap(attemptsByFact, sourceQId, fact);
      }
      const assessedItemIds = new Set<string>();
      for (const rawFb of arr(data.feedback)) { const id = str(rec(rawFb).questionId); if (id) assessedItemIds.add(id); }
      for (const rawQ of arr(rec(data.paper).questions)) { const id = str(rec(rawQ).id); if (id) assessedItemIds.add(id); }
      for (const itemId of assessedItemIds) {
        const assessed = assessmentsByKey.get(`${fact.id}:${itemId}`);
        for (const kcId of (assessed?.projectedCriteria?.length ? eventAttributedKcIds({ criteria: assessed.projectedCriteria }) : null) ?? []) {
          addToMap(attemptsByFact, kcId, fact);
        }
      }
      continue;
    }

    if (fact.type === 'companion.memoryAssertion') {
      const refs = new Set<string>();
      const quoteExcerpt = clip(str(data.quote_excerpt), 160);
      for (const link of arr(data.links)) {
        const id = str(rec(link).id);
        if (id) {
          refs.add(id);
          addToMap(downstreamById, id, { targetId: fact.id, relation: '派生错因' });
        }
      }
      for (const ev of arr(data.evidence)) {
        const evRec = rec(ev);
        const id = str(evRec.id);
        const rev = num(evRec.rev);
        if (id) {
          refs.add(id);
          linkProvenance(fact.id, id, {
            ...(rev !== null ? { rev } : {}),
            upstreamRelation: '证据依据',
            derivedRelation: '派生错因',
            ...(quoteExcerpt ? { excerpt: quoteExcerpt } : {}),
          });
        }
      }
      for (const ev of arr(data.evidence_refs)) {
        const evRec = rec(ev);
        const id = str(evRec.id);
        const rev = num(evRec.rev);
        const excerpt = clip(str(evRec.excerpt) || quoteExcerpt, 160);
        if (id) {
          refs.add(id);
          linkProvenance(fact.id, id, {
            ...(rev !== null ? { rev } : {}),
            upstreamRelation: '证据依据',
            derivedRelation: '派生错因',
            ...(excerpt ? { excerpt } : {}),
          });
        }
      }
      const sourceRef = rec(data.sourceRef);
      const sourceRefId = str(sourceRef.id) || str(rec(sourceRef.fact).id);
      if (sourceRefId) {
        const sourceRefRev = num(sourceRef.rev) ?? num(rec(sourceRef.fact).rev);
        refs.add(sourceRefId);
        linkProvenance(fact.id, sourceRefId, {
          ...(sourceRefRev !== null ? { rev: sourceRefRev } : {}),
          upstreamRelation: '证据依据',
          derivedRelation: '派生错因',
          ...(quoteExcerpt ? { excerpt: quoteExcerpt } : {}),
        });
      }
      const belief = rec(data.belief);
      const beliefTurn = str(belief.turn);
      if (beliefTurn) {
        linkProvenance(fact.id, beliefTurn, { upstreamRelation: '由同伴对话提取', derivedRelation: '派生错因' });
      }
      for (const ob of arr(belief.objectBasis)) {
        const obRec = rec(ob);
        const obId = str(obRec.id);
        const obRev = num(obRec.rev);
        if (obId) {
          linkProvenance(fact.id, obId, {
            ...(obRev !== null ? { rev: obRev } : {}),
            upstreamRelation: '证据依据',
            derivedRelation: '派生错因',
          });
        }
      }
      for (const refId of refs) addToMap(assertionsByRef, refId, fact);
      continue;
    }

    if (fact.type === 'activity.studyTurn') {
      const fb = feedbackByTurnId.get(fact.id);
      if (fb?.isCrisis) continue;
      const turnSessionId = str(data.sessionId);
      if (crisisSessionIds.has(turnSessionId || fact.id)) continue;
      const refs = new Set<string>();
      const attachmentId = str(rec(data.attachment).id);
      const currentObjectId = str(rec(data.currentObject).id);
      if (attachmentId) refs.add(attachmentId);
      if (currentObjectId) refs.add(currentObjectId);
      if (fb) {
        for (const id of fb.referencedIds) {
          if (id !== fact.id) refs.add(id);
        }
        for (const writtenId of fb.writtenIds) {
          linkProvenance(writtenId, fact.id, { upstreamRelation: '由同伴对话提取' });
        }
      }
      for (const refId of refs) addToMap(turnsByRef, refId, fact);
      continue;
    }

    // Explicit basis/links on workspaceEntry / textbookPage / asset.
    for (const rawLink of arr(data.links)) {
      const linkId = typeof rawLink === 'string' ? str(rawLink) : str(rec(rawLink).id);
      if (linkId) addNeighbor(neighborsById, fact.id, linkId, 'references');
    }
    for (const rawBasis of arr(data.basis)) {
      const bRec = rec(rawBasis);
      const bFact = rec(bRec.fact);
      const basisId = str(bRec.id) || str(bFact.id);
      const basisRev = num(bRec.rev) ?? num(bFact.rev);
      const excerpt = clip(str(bRec.excerpt) || str(bRec.quote), 160);
      if (basisId) {
        addNeighbor(neighborsById, fact.id, basisId, 'based_on');
        linkProvenance(fact.id, basisId, {
          ...(basisRev !== null ? { rev: basisRev } : {}),
          ...(excerpt ? { excerpt } : {}),
        });
      }
    }
  }

  return {
    factsById,
    neighborsById,
    upstreamById,
    downstreamById,
    onboardingTaggedIds,
    attemptsByFact,
    assessmentsByKey,
    assertionsByRef,
    turnsByRef,
    feedbackByTurnId,
    forecastsByConcept,
    forecastsByPaperItem,
    paperIdsByQuestion,
    paperIdsByMaterial,
  };
}

function collectAttempts(targetId: string, relatedIds: ReadonlySet<string>, snap: FlowGraphSnapshot): RecordFlowAttempt[] {
  const candidateAttempts = new Map<string, RawFlowFact>();
  for (const id of relatedIds) {
    for (const attempt of snap.attemptsByFact.get(id) ?? []) candidateAttempts.set(attempt.id, attempt);
  }

  const targetFact = snap.factsById.get(targetId);
  const isConceptTarget = targetFact?.type === 'content.asset' && str(rec(targetFact.data).kind) === 'concept';
  const out: RecordFlowAttempt[] = [];
  const seen = new Set<string>();

  for (const attempt of candidateAttempts.values()) {
    const data = rec(attempt.data);
    const paperId = str(data.paperId);
    const paper = paperId ? snap.factsById.get(paperId) : undefined;
    const paperData = paper ? rec(paper.data) : {};
    const paperTitle = paper ? factTitle(paper) : '练习卷';
    const occurredAt = str(data.submittedAt) || factUpdatedAt(attempt);

    // Map questionId -> sourceQuestionRef.id so when viewing a single question/concept we focus relevant items.
    const questionSourceByItem = new Map<string, string>();
    // The frozen paper embedded in the attempt is the authoritative item mapping; the paper
    // fact only fills items the frozen snapshot does not cover.
    const embeddedPaper = rec(data.paper);
    for (const rawQ of [...arr(embeddedPaper.questions), ...arr(paperData.questions)]) {
      const q = rec(rawQ);
      const qid = str(q.id);
      const srcId = str(rec(q.sourceQuestionRef).id);
      if (qid && srcId && !questionSourceByItem.has(qid)) questionSourceByItem.set(qid, srcId);
    }

    const feedbackRows = arr(data.feedback);
    const directPaperOrAttempt = targetId === attempt.id || targetId === paperId || (paper && str(paperData.materialId) === targetId);

    for (const rawFb of feedbackRows) {
      const fb = rec(rawFb);
      const itemId = str(fb.questionId);
      if (!itemId) continue;
      const sourceQId = questionSourceByItem.get(itemId);
      const assessment = snap.assessmentsByKey.get(`${attempt.id}:${itemId}`);
      const projectedCriteria = assessment?.projectedCriteria;
      const attributed = projectedCriteria?.length ? eventAttributedKcIds({ criteria: projectedCriteria }) : null;
      // Items without a sourceQuestionRef are standalone paper rows unless explicitly attributed to this concept via criteria.
      if (!directPaperOrAttempt && (!sourceQId || !relatedIds.has(sourceQId)) && !(isConceptTarget && attributed?.includes(targetId))) continue;

      let verdict: string;
      let errorStage: string | undefined;
      let scoreText: string | undefined;
      if (isConceptTarget && attributed !== null && projectedCriteria) {
        const kcOutcome = eventKcOutcome({ criteria: projectedCriteria }, targetId);
        if (kcOutcome === 'unknown') continue;
        verdict = kcOutcome;
        let earned = 0;
        let maximum = 0;
        const stages = new Set<string>();
        for (const c of projectedCriteria) {
          if (!c.kc_links.some(link => link.kc_id === targetId && link.weight > 0)) continue;
          if (c.earned !== null && c.maximum !== null && c.maximum > 0) {
            earned += Math.min(c.maximum, Math.max(0, c.earned));
            maximum += c.maximum;
          }
          if ((c.outcome === 'incorrect' || c.outcome === 'partial') && c.error_stage) stages.add(c.error_stage);
        }
        if (maximum > 0) scoreText = `${earned}/${maximum}`;
        errorStage = (verdict === 'incorrect' || verdict === 'partial') && stages.size === 1 ? [...stages][0] : undefined;
      } else {
        verdict = assessment?.verdict || (assessment?.hasFormalOutcomes ? 'pending' : str(fb.result)) || 'pending';
        errorStage = verdict === 'correct' ? undefined : (assessment?.errorStage || (assessment?.hasFormalOutcomes ? undefined : str(fb.errorStage)) || undefined);
        scoreText = assessment?.scoreText;
      }
      const sig = `${attempt.id}:${itemId}`;
      if (seen.has(sig)) continue;
      seen.add(sig);

      out.push({
        paperId: paperId || attempt.id,
        paperTitle,
        attemptId: attempt.id,
        itemId,
        verdict,
        ...(errorStage ? { errorStage } : {}),
        ...(scoreText ? { scoreText } : {}),
        occurredAt,
        href: paperId ? `/papers/${paperId}?attempt=${attempt.id}#${itemId}` : `/materials/records/${attempt.id}`,
      });
    }
  }

  return out.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '') || b.attemptId.localeCompare(a.attemptId)).slice(0, 20);
}

const ERROR_STAGE_LABELS: Record<string, string> = {
  reading: '审题漏条件',
  comprehension: '审题漏条件',
  modeling: '概念与建模',
  strategy: '思路与策略',
  execution: '计算与执行',
  expression: '表达规范',
};

export function formatErrorStageLabel(stage: string): string {
  const raw = stage.trim();
  const mapped = ERROR_STAGE_LABELS[raw.toLowerCase()];
  if (mapped) return mapped;
  if (/[^\x00-\x7F]/.test(raw)) return raw;
  return '其他失分环节';
}

function collectMisconceptions(
  relatedIds: ReadonlySet<string>,
  attempts: readonly RecordFlowAttempt[],
  snap: FlowGraphSnapshot,
): RecordFlowMisconception[] {
  const out: RecordFlowMisconception[] = [];
  const seenAssertions = new Set<string>();
  const coveredAttemptItems = new Set<string>();

  for (const id of relatedIds) {
    for (const fact of snap.assertionsByRef.get(id) ?? []) {
      if (seenAssertions.has(fact.id)) continue;
      seenAssertions.add(fact.id);
      const data = rec(fact.data);
      const summary = clip(str(data.text), 200);
      if (!summary) continue;

      let supportCount = 0;
      let contradictCount = 0;
      let evidenceHref: string | undefined;
      let errorStage: string | undefined;

      for (const rawEv of arr(data.evidence)) {
        const ev = rec(rawEv);
        const dir = str(ev.direction);
        if (dir === 'support') supportCount += 1;
        else if (dir === 'contradict') contradictCount += 1;
        const evId = str(ev.id);
        const itemId = str(ev.itemId);
        if (evId && itemId) {
          coveredAttemptItems.add(`${evId}:${itemId}`);
          const assessed = snap.assessmentsByKey.get(`${evId}:${itemId}`);
          if (!errorStage && assessed?.errorStage) errorStage = assessed.errorStage;
          if (!evidenceHref) {
            const evFact = snap.factsById.get(evId);
            const evPaperId = evFact ? str(rec(evFact.data).paperId) : '';
            evidenceHref = evPaperId ? `/papers/${evPaperId}?attempt=${evId}#${itemId}` : `/materials/records/${evId}`;
          }
        }
      }

      const status = contradictCount > 0 && contradictCount >= supportCount
        ? 'contested'
        : supportCount > 0
          ? 'active'
          : 'needs_review';
      out.push({
        id: fact.id,
        summary,
        ...(errorStage ? { errorStage } : {}),
        status,
        supportCount,
        contradictCount,
        ...(evidenceHref ? { evidenceHref } : {}),
      });
    }
  }

  // Also surface explicit attempt-level errorStage diagnoses not already covered by a memoryAssertion.
  for (const attempt of attempts) {
    if (!attempt.errorStage || attempt.verdict === 'correct') continue;
    const key = `${attempt.attemptId}:${attempt.itemId}`;
    if (coveredAttemptItems.has(key)) continue;
    coveredAttemptItems.add(key);
    out.push({
      id: `error:${key}`,
      summary: `${attempt.paperTitle}（题 ${attempt.itemId}）出现${formatErrorStageLabel(attempt.errorStage)}阶段错因`,
      errorStage: attempt.errorStage,
      status: 'observed',
      supportCount: 1,
      contradictCount: 0,
      evidenceHref: attempt.href,
    });
  }

  return out.slice(0, 12);
}

function isCrisisStudyTurn(fact: RawFlowFact, snap: FlowGraphSnapshot): boolean {
  if (fact.type !== 'activity.studyTurn') return false;
  const scope = crisisScopeFromSnap(snap);
  if (scope.turnIds.has(fact.id)) return true;
  const sessionId = str(rec(fact.data).sessionId) || fact.id;
  return scope.sessionIds.has(sessionId);
}

function collectDiscussions(relatedIds: ReadonlySet<string>, snap: FlowGraphSnapshot): RecordFlowDiscussion[] {
  const bySession = new Map<string, { turn: RawFlowFact; tick: bigint }>();
  for (const id of relatedIds) {
    for (const turn of snap.turnsByRef.get(id) ?? []) {
      if (isCrisisStudyTurn(turn, snap)) continue;
      const data = rec(turn.data);
      const sessionId = str(data.sessionId) || turn.id;
      const tick = parseTick(turn.createdTick);
      const prev = bySession.get(sessionId);
      if (!prev || tick > prev.tick) bySession.set(sessionId, { turn, tick });
    }
  }

  return [...bySession.entries()]
    .sort((a, b) => (b[1].tick > a[1].tick ? 1 : b[1].tick < a[1].tick ? -1 : 0))
    .slice(0, 10)
    .map(([sessionId, { turn }]) => {
      const data = rec(turn.data);
      const fb = snap.feedbackByTurnId.get(turn.id);
      const question = str(data.answer);
      const title = clip(question || str(rec(data.attachment).title) || '同伴学习对话', 72);
      const excerpt = clip(fb?.message || question || '查看本次同伴讨论记录', 160);
      return {
        sessionId,
        turnId: turn.id,
        title,
        excerpt,
        occurredAt: factUpdatedAt(turn),
        href: `/companion?session=${sessionId}`,
      };
    });
}

function computeMastery(
  relatedIds: ReadonlySet<string>,
  attempts: readonly RecordFlowAttempt[],
  misconceptions: readonly RecordFlowMisconception[],
  snap: FlowGraphSnapshot,
): RecordFlowMastery {
  const graded = attempts.filter((a) => a.verdict === 'correct' || a.verdict === 'partial' || a.verdict === 'incorrect');
  const score = graded.length
    ? Math.round(
        (graded.reduce((sum, a) => sum + (a.verdict === 'correct' ? 1 : a.verdict === 'partial' ? 0.5 : 0), 0) / graded.length) *
          100,
      ) / 100
    : null;

  let latestForecast: IndexedForecast | undefined;
  for (const id of relatedIds) {
    for (const f of snap.forecastsByConcept.get(id) ?? []) {
      if (!latestForecast || f.effectiveTick >= latestForecast.effectiveTick) latestForecast = f;
    }
  }
  for (const attempt of attempts) {
    for (const f of snap.forecastsByPaperItem.get(`${attempt.paperId}:${attempt.itemId}`) ?? []) {
      if (f.conceptId && !relatedIds.has(f.conceptId)) continue;
      if (!latestForecast || f.effectiveTick >= latestForecast.effectiveTick) latestForecast = f;
    }
  }
  const retrievability = latestForecast ? Math.round(latestForecast.probability * 100) / 100 : null;
  const evidenceCount = graded.length + (latestForecast ? 1 : 0);

  if (evidenceCount === 0) {
    return { level: 'unknown', score: null, retrievability: null, evidenceCount: 0 };
  }

  const hasActiveError = misconceptions.some((m) => m.status === 'active' || m.status === 'observed');
  let level: RecordFlowMasteryLevel;
  if (hasActiveError || (score !== null && score < 0.5) || (retrievability !== null && retrievability < 0.55)) {
    level = 'fragile';
  } else if (
    (score !== null && score >= 0.85 && graded.length >= 2 && (retrievability === null || retrievability >= 0.7)) ||
    (score === null && retrievability !== null && retrievability >= 0.8)
  ) {
    level = 'solid';
  } else {
    level = 'developing';
  }

  return { level, score, retrievability, evidenceCount };
}

function buildNextActions(
  identity: RecordFlowIdentity,
  attempts: readonly RecordFlowAttempt[],
  misconceptions: readonly RecordFlowMisconception[],
  neighbors: readonly RecordFlowNeighbor[],
  snap: FlowGraphSnapshot,
): RecordFlowNextAction[] {
  const actions: RecordFlowNextAction[] = [];

  const mistake = attempts.find((a) => a.verdict === 'incorrect' || a.verdict === 'partial' || Boolean(a.errorStage));
  if (mistake) {
    actions.push({
      kind: 'review_mistake',
      label: `复盘错题：${clip(mistake.paperTitle, 24)}`,
      href: mistake.href,
    });
  } else if (misconceptions[0]?.evidenceHref) {
    actions.push({
      kind: 'review_mistake',
      label: '回看错因证据',
      href: misconceptions[0].evidenceHref,
    });
  }

  const directPaperId =
    identity.kind === 'paper'
      ? identity.id
      : snap.paperIdsByMaterial.get(identity.id)?.[0] ??
        snap.paperIdsByQuestion.get(identity.id)?.[0] ??
        neighbors.find((n) => n.kind === 'paper')?.id;
  actions.push({
    kind: 'practice',
    label: directPaperId ? '去做关联练习' : '发起针对练习',
    href: directPaperId ? `/papers/${directPaperId}` : `/papers?focus=${identity.id}`,
  });

  const companionHref =
    identity.kind === 'material'
      ? `/companion?material=${identity.id}`
      : identity.kind === 'attempt'
        ? `/companion?record=attempt&id=${identity.id}&rev=${identity.rev}`
        : identity.kind === 'textbook' || identity.kind === 'note' || identity.kind === 'page'
          ? `/companion?record=page&id=${identity.id}&rev=${identity.rev}`
          : `/companion?about=${identity.id}`;
  actions.push({
    kind: 'ask_companion',
    label: '带这条记录问同伴',
    href: companionHref,
  });

  if (neighbors.length > 0 || identity.kind === 'concept' || identity.kind === 'method' || identity.kind === 'archetype') {
    actions.push({
      kind: 'open_graph',
      label: '在知识图谱中展开',
      href: `/materials?tab=graph&focus=${identity.id}`,
    });
  }

  return actions;
}

const ORIGIN_BADGE_BY_KIND: Readonly<Record<string, string>> = {
  material: '原件',
  onboarding: '冷启动',
  textbook: '教材',
  question: '题库',
  paper: '试卷',
  attempt: '作答',
  discussion: '对话',
  notion: 'Notion',
  discipline: '学科',
  concept: '概念',
  method: '概念',
  archetype: '概念',
  misconception: '错因',
  note: '笔记',
  page: '笔记',
};

function originBadgeOf(kind: string): string {
  return ORIGIN_BADGE_BY_KIND[kind] ?? '记录';
}

function defaultUpstreamRelation(fact: RawFlowFact, kind: string): string {
  if (kind === 'notion') return '来自 Notion';
  if (fact.type === 'capture.source') return '来自交入原件';
  switch (kind) {
    case 'material': return '来自原件';
    case 'discipline': return '所属学科语境';
    case 'textbook': return '源自教材';
    case 'question': return '源于源题';
    case 'paper': return '对应试卷';
    case 'attempt': return '证据依据';
    case 'discussion': return '由同伴对话提取';
    case 'misconception': return '证据依据';
    case 'concept':
    case 'method':
    case 'archetype': return '源自概念';
    default: return '证据依据';
  }
}

function defaultDerivedRelation(kind: string): string {
  switch (kind) {
    case 'paper': return '派生试卷';
    case 'question': return '派生题目';
    case 'concept':
    case 'method':
    case 'archetype': return '派生概念';
    case 'misconception': return '派生错因';
    case 'attempt': return '派生作答';
    case 'textbook': return '派生教材';
    default: return '派生记录';
  }
}

function provenanceHref(fact: RawFlowFact, factsById: ReadonlyMap<string, RawFlowFact>): string | null {
  const kind = factKind(fact);
  if (kind === 'notion') return null;
  return recordHref(fact, factsById);
}

function factExcerpt(fact: RawFlowFact): string | undefined {
  const data = rec(fact.data);
  const raw = str(data.summary) || str(data.excerpt) || str(rec(data.discipline_context).learningScope) || str(data.text);
  return raw ? clip(raw, 120) : undefined;
}

const UPLOADED_ORIGIN_KINDS = new Set(['material', 'notion', 'textbook', 'discussion']);

const ONBOARDING_PROVENANCE_ENTRY: RecordFlowProvenance = {
  id: 'onboarding',
  kind: 'onboarding',
  title: '初始学习画像建档',
  relation: '来自冷启动建档',
  originBadge: '冷启动',
  href: '/onboarding',
};

function collectProvenance(target: RawFlowFact, snap: FlowGraphSnapshot): RecordFlowProvenance[] {
  const out: RecordFlowProvenance[] = [];
  const visited = new Set<string>([target.id]);
  const queue: { id: string; depth: number }[] = [{ id: target.id, depth: 0 }];

  while (queue.length > 0 && out.length < 10) {
    const current = queue.shift()!;
    if (current.depth >= 2) continue;
    for (const link of snap.upstreamById.get(current.id) ?? []) {
      if (visited.has(link.targetId)) continue;
      const upstream = snap.factsById.get(link.targetId);
      if (!upstream || isCrisisStudyTurn(upstream, snap)) continue;
      visited.add(upstream.id);
      const kind = factKind(upstream);
      const excerpt = link.excerpt || factExcerpt(upstream);
      out.push({
        id: upstream.id,
        rev: link.rev ?? upstream.rev,
        kind,
        title: factTitle(upstream),
        relation: link.relation ?? defaultUpstreamRelation(upstream, kind),
        originBadge: originBadgeOf(kind),
        ...(excerpt ? { excerpt } : {}),
        href: provenanceHref(upstream, snap.factsById),
      });
      if (out.length >= 10) break;
      queue.push({ id: upstream.id, depth: current.depth + 1 });
    }
  }

  const targetKind = factKind(target);
  const hasUploadedOrigin = out.some((item) => UPLOADED_ORIGIN_KINDS.has(item.kind));
  const hasDisciplineOrigin = out.some((item) => item.kind === 'discipline');
  const isOnboardingAsset =
    !hasUploadedOrigin &&
    (targetKind === 'discipline' ||
      snap.onboardingTaggedIds.has(target.id) ||
      ((targetKind === 'concept' || targetKind === 'question' || targetKind === 'method' || targetKind === 'archetype') &&
        hasDisciplineOrigin));
  if (isOnboardingAsset && out.length < 10) {
    out.push(ONBOARDING_PROVENANCE_ENTRY);
  }

  return out;
}

const DERIVED_PRIORITY: Readonly<Record<string, number>> = {
  paper: 50,
  misconception: 45,
  attempt: 40,
  question: 35,
  concept: 30,
  method: 28,
  archetype: 28,
  textbook: 25,
};

function collectDerived(target: RawFlowFact, snap: FlowGraphSnapshot): RecordFlowProvenance[] {
  const seen = new Map<string, { item: RecordFlowProvenance; priority: number; tick: bigint }>();
  for (const link of snap.downstreamById.get(target.id) ?? []) {
    if (link.targetId === target.id || seen.has(link.targetId)) continue;
    const child = snap.factsById.get(link.targetId);
    if (!child || isCrisisStudyTurn(child, snap)) continue;
    const kind = factKind(child);
    const excerpt = link.excerpt || factExcerpt(child);
    seen.set(child.id, {
      item: {
        id: child.id,
        rev: child.rev,
        kind,
        title: factTitle(child),
        relation: link.relation ?? defaultDerivedRelation(kind),
        originBadge: originBadgeOf(kind),
        ...(excerpt ? { excerpt } : {}),
        href: provenanceHref(child, snap.factsById),
      },
      priority: DERIVED_PRIORITY[kind] ?? 10,
      tick: parseTick(child.createdTick),
    });
  }
  return [...seen.values()]
    .sort((a, b) => b.priority - a.priority || (b.tick > a.tick ? 1 : b.tick < a.tick ? -1 : a.item.id.localeCompare(b.item.id)))
    .slice(0, 12)
    .map((entry) => entry.item);
}

function buildOriginLabel(provenance: readonly RecordFlowProvenance[]): string | undefined {
  const first = provenance[0];
  if (!first) return undefined;
  if (first.kind === 'onboarding') return '来自冷启动建档';
  if (first.relation === '所属学科语境') return `所属学科：${clip(first.title, 24)}`;
  return `${first.relation}：${clip(first.title, 24)}`;
}

/**
 * Project a full structured `RecordFlowView` for any learning record, concept,
 * question, paper, attempt, textbook page, or source material.
 */
export function projectRecordFlow(targetId: string, snap: FlowGraphSnapshot): RecordFlowView | null {
  const target = snap.factsById.get(targetId);
  if (!target || isCrisisStudyTurn(target, snap)) return null;

  const subject = factSubject(target);
  const identity: RecordFlowIdentity = {
    id: target.id,
    rev: target.rev,
    kind: factKind(target),
    title: factTitle(target),
    ...(subject ? { subject } : {}),
    updatedAt: factUpdatedAt(target),
    author: target.author || 'unknown',
  };

  // Deduplicated 1-hop graph neighbors.
  const neighborMap = new Map<string, RecordFlowNeighbor>();
  for (const edge of snap.neighborsById.get(targetId) ?? []) {
    const other = snap.factsById.get(edge.targetId);
    if (!other || isCrisisStudyTurn(other, snap)) continue;
    const sig = `${edge.targetId}:${edge.relation}:${edge.direction}`;
    if (neighborMap.has(sig)) continue;
    neighborMap.set(sig, {
      id: other.id,
      title: factTitle(other),
      kind: factKind(other),
      relation: edge.relation,
      direction: edge.direction,
      href: recordHref(other, snap.factsById),
    });
  }
  const graphNeighbors = [...neighborMap.values()].slice(0, 24);

  // Build 1-hop related entity set so concepts gather linked question attempts & misconceptions.
  const relatedIds = new Set<string>([targetId]);
  // Adjacent concept/method/archetype/discipline neighbors are graph context only: their
  // attempts, misconceptions and discussions must never contaminate this record's mastery.
  const CONTEXTUAL_KINDS = new Set(['concept', 'method', 'archetype', 'discipline']);
  for (const n of graphNeighbors) {
    if (!CONTEXTUAL_KINDS.has(n.kind)) relatedIds.add(n.id);
  }
  for (const pId of snap.paperIdsByMaterial.get(targetId) ?? []) relatedIds.add(pId);
  for (const pId of snap.paperIdsByQuestion.get(targetId) ?? []) relatedIds.add(pId);

  const attempts = collectAttempts(targetId, relatedIds, snap);
  // Include linked attempt ids so memoryAssertions referencing an attempt also flow to the concept/paper.
  for (const a of attempts) relatedIds.add(a.attemptId);

  const misconceptions = collectMisconceptions(relatedIds, attempts, snap);
  const discussions = collectDiscussions(relatedIds, snap);
  const mastery = computeMastery(relatedIds, attempts, misconceptions, snap);
  const provenance = collectProvenance(target, snap);
  const derived = collectDerived(target, snap);
  const nextActions = buildNextActions(identity, attempts, misconceptions, graphNeighbors, snap);

  return {
    identity,
    mastery,
    misconceptions,
    attempts,
    discussions,
    graphNeighbors,
    provenance,
    derived,
    nextActions,
  };
}

/**
 * Batch-compute lightweight structured flow summaries for `/api/workspace/access` list items.
 */
export function summarizeRecordFlowForList(
  ids: readonly string[],
  snap: FlowGraphSnapshot,
): Record<string, WorkspaceRecordFlowSummary> {
  const summaries: Record<string, WorkspaceRecordFlowSummary> = {};
  for (const id of ids) {
    const flow = projectRecordFlow(id, snap);
    if (!flow) {
      summaries[id] = {
        errorStageCount: 0,
        attemptCount: 0,
        discussionCount: 0,
        neighborCount: 0,
        conceptTags: [],
      };
      continue;
    }
    const target = snap.factsById.get(id);
    const conceptTags: string[] = [];
    for (const neighbor of flow.graphNeighbors) {
      if (neighbor.kind === 'concept' || neighbor.kind === 'method' || neighbor.kind === 'archetype') {
        if (!conceptTags.includes(neighbor.title)) conceptTags.push(neighbor.title);
      }
      if (conceptTags.length >= 4) break;
    }
    if (target && conceptTags.length < 4) {
      for (const tag of factTags(target)) {
        if (!conceptTags.includes(tag)) conceptTags.push(tag);
        if (conceptTags.length >= 4) break;
      }
    }
    const errorStageCount =
      flow.misconceptions.filter((m) => Boolean(m.errorStage) || m.status === 'active' || m.status === 'observed').length;
    const originLabel = buildOriginLabel(flow.provenance);
    summaries[id] = {
      ...(flow.mastery.level !== 'unknown' ? { masteryLevel: flow.mastery.level } : {}),
      errorStageCount,
      attemptCount: flow.attempts.length,
      discussionCount: flow.discussions.length,
      neighborCount: flow.graphNeighbors.length,
      conceptTags,
      ...(originLabel ? { originLabel } : {}),
    };
  }
  return summaries;
}

const AGENT_FLOW_KINDS = new Set(['concept', 'method', 'archetype', 'question', 'textbook', 'material', 'paper', 'attempt']);

function collectFlowWitnessFactIds(
  flow: RecordFlowView,
  misconceptions: readonly RecordFlowMisconception[],
  attempts: readonly RecordFlowAttempt[],
  neighbors: readonly RecordFlowNeighbor[],
  discussions: readonly RecordFlowDiscussion[],
  provenance: readonly RecordFlowProvenance[],
  snap: FlowGraphSnapshot,
): string[] {
  const ids = new Set<string>([flow.identity.id]);
  for (const m of misconceptions) {
    if (snap.factsById.has(m.id)) ids.add(m.id);
    else if (m.id.startsWith('error:')) {
      const attemptId = m.id.slice('error:'.length).split(':')[0];
      if (attemptId && snap.factsById.has(attemptId)) ids.add(attemptId);
    }
  }
  for (const a of attempts) {
    if (snap.factsById.has(a.attemptId)) ids.add(a.attemptId);
    if (snap.factsById.has(a.paperId)) ids.add(a.paperId);
  }
  const neighborIds = new Set<string>();
  for (const n of neighbors) {
    if (snap.factsById.has(n.id)) {
      ids.add(n.id);
      neighborIds.add(n.id);
    }
  }
  for (const edge of snap.neighborsById.get(flow.identity.id) ?? []) {
    if (edge.edgeFactId && neighborIds.has(edge.targetId) && snap.factsById.has(edge.edgeFactId)) {
      ids.add(edge.edgeFactId);
    }
  }
  for (const d of discussions) {
    if (snap.factsById.has(d.turnId)) ids.add(d.turnId);
  }
  const provenanceIds = new Set<string>();
  for (const p of provenance) {
    // Never register synthetic virtual entries (e.g. 'onboarding') as DB fact witnesses.
    if (p.id !== 'onboarding' && snap.factsById.has(p.id)) {
      ids.add(p.id);
      provenanceIds.add(p.id);
    }
  }
  for (const sourceId of [flow.identity.id, ...provenanceIds]) {
    for (const link of snap.upstreamById.get(sourceId) ?? []) {
      if (link.edgeFactId && provenanceIds.has(link.targetId) && snap.factsById.has(link.edgeFactId)) {
        ids.add(link.edgeFactId);
      }
    }
  }
  // Include all attempts & misconceptions that contributed to mastery level/score.
  for (const a of flow.attempts) {
    if (snap.factsById.has(a.attemptId)) ids.add(a.attemptId);
    if (snap.factsById.has(a.paperId)) ids.add(a.paperId);
  }
  for (const m of flow.misconceptions) {
    if (snap.factsById.has(m.id)) ids.add(m.id);
  }
  return [...ids];
}

/**
 * Compact high-signal `flow` block returned to the teaching agent via `open_learning`,
 * including exact `witnessFactIds` so outbound revocation / accessEpoch revalidation tracks every referenced fact.
 */
export function projectAgentRecordFlow(targetId: string, snap: FlowGraphSnapshot): AgentRecordFlow | null {
  const flow = projectRecordFlow(targetId, snap);
  if (!flow || !AGENT_FLOW_KINDS.has(flow.identity.kind)) return null;
  const misconceptions = flow.misconceptions.slice(0, 4);
  const recentAttempts = flow.attempts.slice(0, 3);
  const graphNeighbors = flow.graphNeighbors.slice(0, 8);
  const relatedDiscussions = flow.discussions.slice(0, 3);
  const provenance = flow.provenance.slice(0, 5);
  return {
    mastery: flow.mastery,
    misconceptions,
    recentAttempts,
    graphNeighbors,
    relatedDiscussions,
    provenance,
    witnessFactIds: collectFlowWitnessFactIds(flow, misconceptions, recentAttempts, graphNeighbors, relatedDiscussions, provenance, snap),
  };
}

function flowSignalStrength(flow: RecordFlowView): number {
  let score = 0;
  if (flow.mastery.level === 'fragile') score += 50;
  else if (flow.mastery.level === 'developing') score += 20;
  score += flow.misconceptions.length * 18;
  score += flow.attempts.length * 8;
  score += flow.discussions.length * 6;
  score += flow.graphNeighbors.length * 2;
  return score;
}

/**
 * High-signal `learner_model` entries for `read_context` (tutoring / planning),
 * prioritizing explicit focus objects and falling back to fragile/active concepts.
 */
export function projectLearnerModelFlowSignals(
  focusIds: readonly string[],
  snap: FlowGraphSnapshot,
  limit = 3,
): readonly LearnerModelFlowSignal[] {
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of focusIds) {
    if (id && !seen.has(id) && snap.factsById.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  if (orderedIds.length < limit) {
    const rankedConcepts: { id: string; strength: number }[] = [];
    for (const fact of snap.factsById.values()) {
      if (seen.has(fact.id)) continue;
      const kind = factKind(fact);
      if (kind !== 'concept' && kind !== 'method' && kind !== 'archetype') continue;
      const flow = projectRecordFlow(fact.id, snap);
      if (!flow) continue;
      const strength = flowSignalStrength(flow);
      if (strength > 0) rankedConcepts.push({ id: fact.id, strength });
    }
    rankedConcepts.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
    for (const entry of rankedConcepts) {
      if (orderedIds.length >= limit) break;
      seen.add(entry.id);
      orderedIds.push(entry.id);
    }
  }

  const signals: LearnerModelFlowSignal[] = [];
  for (const id of orderedIds) {
    const flow = projectRecordFlow(id, snap);
    if (!flow) continue;
    const hasSignal =
      flow.mastery.evidenceCount > 0 ||
      flow.misconceptions.length > 0 ||
      flow.attempts.length > 0 ||
      flow.graphNeighbors.length > 0 ||
      flow.discussions.length > 0 ||
      flow.provenance.length > 0;
    if (!hasSignal) continue;
    const misconceptions = flow.misconceptions.slice(0, 2);
    const recentAttempts = flow.attempts.slice(0, 2);
    const graphNeighbors = flow.graphNeighbors.slice(0, 4);
    const relatedDiscussions = flow.discussions.slice(0, 2);
    const provenance = flow.provenance.slice(0, 3);
    signals.push({
      id: flow.identity.id,
      kind: flow.identity.kind,
      title: flow.identity.title,
      ...(flow.identity.subject ? { subject: flow.identity.subject } : {}),
      mastery: flow.mastery,
      misconceptions,
      recentAttempts,
      graphNeighbors,
      relatedDiscussions,
      provenance,
      witnessFactIds: collectFlowWitnessFactIds(flow, misconceptions, recentAttempts, graphNeighbors, relatedDiscussions, provenance, snap),
    });
    if (signals.length >= limit) break;
  }
  return signals;
}

/**
 * Extract concept entities + their flow mastery & linked question counts
 * for `/today` graph-and-bank candidate scheduling.
 */
export function collectGraphConceptSources(snap: FlowGraphSnapshot, goalId?: string): readonly GraphConceptFlowSource[] {
  const sources: GraphConceptFlowSource[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.asset' && fact.type !== 'activity.workspaceEntry') continue;
    if (factKind(fact) !== 'concept') continue;
    const flow = projectRecordFlow(fact.id, snap);
    if (!flow) continue;
    const data = rec(fact.data);
    const semesterTag = str(data.semesterTag);
    const linkedQuestionCount = flow.graphNeighbors.filter((n) => n.kind === 'question').length;
    const errorStageCount = flow.misconceptions.filter(
      (m) => Boolean(m.errorStage) || m.status === 'active' || m.status === 'observed',
    ).length;
    sources.push({
      id: fact.id,
      rev: fact.rev,
      title: flow.identity.title,
      ...(flow.identity.subject ? { subject: flow.identity.subject } : {}),
      ...(semesterTag ? { semesterTag } : {}),
      masteryLevel: flow.mastery.level,
      retrievability: flow.mastery.retrievability,
      errorStageCount,
      linkedQuestionCount,
      linkedAttemptCount: flow.attempts.length,
      ...(goalId ? { goalId } : {}),
    });
  }
  return sources;
}
