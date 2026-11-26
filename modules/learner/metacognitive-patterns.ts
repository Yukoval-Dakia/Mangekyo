import { formatErrorStageLabel, type FlowGraphSnapshot, type RawFlowFact } from './record-flow.ts';

export type MetacognitiveObservation = {
  readonly id: string;
  readonly attemptId?: string;
  readonly itemId?: string;
  readonly paperId?: string;
  readonly questionId?: string;
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly subject?: string;
  readonly sessionId?: string;
  readonly verdict: 'correct' | 'incorrect' | 'partial' | 'unknown';
  readonly errorStage?: string;
  readonly confidence?: 'high' | 'medium' | 'low' | number;
  readonly helpLevel?: 'independent' | 'hinted' | 'hint_l1' | 'hint_l2' | 'solution_seen' | 'unknown';
  readonly promptExcerpt?: string;
  readonly occurredAt?: string | null;
};

export type MetacognitivePatternInput = {
  readonly snap: FlowGraphSnapshot;
  readonly observations?: readonly MetacognitiveObservation[];
  readonly asOfAt?: string;
};

export type MetacognitiveHabit = {
  readonly id: string;
  readonly patternKey: string;
  readonly label: string;
  readonly errorStage: string;
  readonly errorStageLabel: string;
  readonly subjects: readonly string[];
  readonly sessionCount: number;
  readonly evidenceCount: number;
  readonly preStartHint: string;
  readonly evidenceIds: readonly string[];
  readonly confidenceNote: string;
};

export type MasteryIllusionAlert = {
  readonly id: string;
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly questionId?: string;
  readonly attemptId: string;
  readonly itemId: string;
  readonly paperId?: string;
  readonly subject?: string;
  readonly errorStage?: string;
  readonly errorStageLabel?: string;
  readonly confidenceLevel: 'high';
  readonly promptExcerpt?: string;
  readonly counterexampleTarget: string;
  readonly recommendedAction: 'author_mistake_variant' | 'discriminator_probe';
  readonly evidenceIds: readonly string[];
};

export type MetacognitivePatternView = {
  readonly metacognitiveHabits: readonly MetacognitiveHabit[];
  readonly masteryIllusionAlerts: readonly MasteryIllusionAlert[];
  readonly suppressedSingletonsCount: number;
};

type NormalizedStage = 'reading' | 'modeling' | 'strategy' | 'execution' | 'expression';
type HelpLevel = NonNullable<MetacognitiveObservation['helpLevel']>;
type Evidence = {
  readonly id: string;
  readonly attemptId: string;
  readonly itemId: string;
  readonly sessionId: string;
  readonly verdict: MetacognitiveObservation['verdict'];
  readonly errorStage?: NormalizedStage;
  readonly confidence?: MetacognitiveObservation['confidence'];
  readonly helpLevel?: HelpLevel;
  readonly questionId?: string;
  readonly paperId?: string;
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly subject?: string;
  readonly promptExcerpt?: string;
  readonly occurredAt: string | null;
};

type ConceptContext = {
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly subject?: string;
};

const STAGES: readonly NormalizedStage[] = ['reading', 'modeling', 'strategy', 'execution', 'expression'];
const STAGE_HINTS: Readonly<Record<NormalizedStage, string>> = {
  reading: '开卷前轻提醒：动笔前先圈出题干中的隐含限制词与单位条件，避免跳读丢条件。',
  modeling: '开卷前轻提醒：先写出已知量、未知量与适用模型，再开始代入或推演。',
  strategy: '开卷前轻提醒：先列出可行路径并说明选择依据，避免在第一条思路上反复打转。',
  execution: '开卷前轻提醒：算完每一步都回看符号、单位与数量级，再继续下一步。',
  expression: '开卷前轻提醒：最后用题目要求的对象、单位和结论句检查答案是否完整。',
};
const HABIT_LABELS: Readonly<Record<NormalizedStage, string>> = {
  reading: '跨科共性：审题时容易跳过限制条件',
  modeling: '跨科共性：概念与建模容易错位',
  strategy: '跨科共性：解题策略容易卡在选择路径',
  execution: '跨科共性：计算与执行容易出现细节偏差',
  expression: '跨科共性：表达规范容易丢分',
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function normalizedStage(value: unknown): NormalizedStage | undefined {
  const stage = text(value).toLowerCase();
  if (stage === 'reading' || stage === 'comprehension') return 'reading';
  if (stage === 'modeling' || stage === 'strategy' || stage === 'execution' || stage === 'expression') return stage;
  return undefined;
}

function verdict(value: unknown): MetacognitiveObservation['verdict'] {
  const result = text(value).toLowerCase();
  return result === 'correct' || result === 'incorrect' || result === 'partial' ? result : 'unknown';
}

function confidence(value: unknown): MetacognitiveObservation['confidence'] | undefined {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function helpLevel(value: unknown): HelpLevel | undefined {
  const level = text(value);
  return level === 'independent' || level === 'hinted' || level === 'hint_l1' || level === 'hint_l2' ||
    level === 'solution_seen' || level === 'unknown' ? level : undefined;
}

function isHighConfidence(value: MetacognitiveObservation['confidence'] | undefined): boolean {
  return value === 'high' || (typeof value === 'number' && value >= 0.75);
}

function isIndependent(help: HelpLevel | undefined): boolean {
  return help === undefined || help === 'independent' || help === 'unknown';
}

function occurrenceAt(data: Record<string, unknown>): string | null {
  const value = text(data.submittedAt) || text(data.occurredAt) || text(data.recordedAt) || text(data.createdAt);
  return value || null;
}

function isFuture(occurredAt: string | null, asOfAt: string | undefined): boolean {
  if (!occurredAt || !asOfAt) return false;
  const occurredMs = Date.parse(occurredAt);
  const asOfMs = Date.parse(asOfAt);
  return Number.isFinite(occurredMs) && Number.isFinite(asOfMs) && occurredMs > asOfMs;
}

function crisisId(snap: FlowGraphSnapshot, id: string): boolean {
  return Boolean(id && snap.feedbackByTurnId.get(id)?.isCrisis);
}

function isCrisisEvidence(snap: FlowGraphSnapshot, ids: readonly string[]): boolean {
  return ids.some((id) => crisisId(snap, id));
}

function factKind(fact: RawFlowFact | undefined): string {
  return text(asRecord(fact?.data).kind).toLowerCase();
}

function subjectOf(data: Record<string, unknown>): string | undefined {
  const subject = text(data.subject) || text(data.discipline) || text(data.topic) || text(asRecord(data.scope).subject);
  return subject || undefined;
}

function titleOf(fact: RawFlowFact | undefined): string | undefined {
  if (!fact) return undefined;
  const data = asRecord(fact.data);
  const title = text(data.title) || text(data.canonicalName) || text(data.name) || text(data.text) || text(data.prompt);
  return title ? clip(title, 96) : undefined;
}

function conceptFact(fact: RawFlowFact | undefined): boolean {
  const kind = factKind(fact);
  return kind === 'concept' || kind === 'method' || kind === 'archetype';
}

function conceptContext(snap: FlowGraphSnapshot, ids: readonly string[], directIds: readonly string[] = []): ConceptContext {
  const candidates = [...directIds, ...ids].filter(Boolean);
  for (const id of candidates) {
    const fact = snap.factsById.get(id);
    if (conceptFact(fact)) {
      const data = asRecord(fact?.data);
      const conceptTitle = titleOf(fact);
      const subject = subjectOf(data);
      return {
        ...(fact ? { conceptId: fact.id } : {}),
        ...(conceptTitle ? { conceptTitle } : {}),
        ...(subject ? { subject } : {}),
      };
    }
  }
  for (const id of ids) {
    for (const edge of snap.neighborsById.get(id) ?? []) {
      const fact = snap.factsById.get(edge.targetId);
      if (!conceptFact(fact)) continue;
      const data = asRecord(fact?.data);
      const conceptTitle = titleOf(fact);
      const subject = subjectOf(data);
      return {
        ...(fact ? { conceptId: fact.id } : {}),
        ...(conceptTitle ? { conceptTitle } : {}),
        ...(subject ? { subject } : {}),
      };
    }
  }
  return {};
}

function directConceptIds(data: Record<string, unknown>): string[] {
  const ids = [text(data.conceptId), text(data.knowledgeNodeId), text(asRecord(data.concept).id)];
  for (const raw of asList(data.conceptIds)) ids.push(text(raw));
  return [...new Set(ids.filter(Boolean))];
}

function confidenceFrom(data: Record<string, unknown>, row: Record<string, unknown>, assessment: Record<string, unknown>, itemId: string) {
  const confidences = asRecord(data.confidences);
  return confidence(row.confidence) ?? confidence(confidences[itemId]) ?? confidence(data.confidence) ?? confidence(assessment.confidence);
}

function helpFrom(data: Record<string, unknown>, row: Record<string, unknown>, assessment: Record<string, unknown>, itemId: string) {
  const levels = asRecord(data.helpLevels);
  return helpLevel(row.helpLevel) ?? helpLevel(row.help_level) ?? helpLevel(levels[itemId]) ??
    helpLevel(data.helpLevel) ?? helpLevel(data.help_level) ?? helpLevel(assessment.helpLevel);
}

function evidenceFromObservation(
  observation: MetacognitiveObservation,
  snap: FlowGraphSnapshot,
  asOfAt: string | undefined,
): Evidence | undefined {
  const id = text(observation.id);
  if (!id || isFuture(observation.occurredAt ?? null, asOfAt) || isCrisisEvidence(snap, [id, text(observation.attemptId), text(observation.sessionId)])) return undefined;
  const attemptId = text(observation.attemptId) || id;
  const itemId = text(observation.itemId);
  const sessionId = text(observation.sessionId) || attemptId;
  const stage = normalizedStage(observation.errorStage);
  return {
    id,
    attemptId,
    itemId,
    sessionId,
    verdict: observation.verdict,
    ...(stage ? { errorStage: stage } : {}),
    ...(observation.confidence !== undefined ? { confidence: observation.confidence } : {}),
    ...(observation.helpLevel !== undefined ? { helpLevel: observation.helpLevel } : {}),
    ...(text(observation.questionId) ? { questionId: text(observation.questionId) } : {}),
    ...(text(observation.paperId) ? { paperId: text(observation.paperId) } : {}),
    ...(text(observation.conceptId) ? { conceptId: text(observation.conceptId) } : {}),
    ...(text(observation.conceptTitle) ? { conceptTitle: clip(text(observation.conceptTitle), 96) } : {}),
    ...(text(observation.subject) ? { subject: clip(text(observation.subject), 64) } : {}),
    ...(text(observation.promptExcerpt) ? { promptExcerpt: clip(text(observation.promptExcerpt), 240) } : {}),
    occurredAt: observation.occurredAt ?? null,
  };
}

function itemIdsForAttempt(attempt: RawFlowFact, snap: FlowGraphSnapshot): string[] {
  const data = asRecord(attempt.data);
  const ids = asList(data.feedback).map((raw) => text(asRecord(raw).questionId) || text(asRecord(raw).itemId));
  const prefix = `${attempt.id}:`;
  for (const key of snap.assessmentsByKey.keys()) if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
  return [...new Set(ids.filter(Boolean))];
}

function questionForItem(paperData: Record<string, unknown>, itemId: string): Record<string, unknown> {
  return asRecord(asList(paperData.questions).find((raw) => text(asRecord(raw).id) === itemId));
}

function evidenceFromAttempt(attempt: RawFlowFact, snap: FlowGraphSnapshot, asOfAt: string | undefined): Evidence[] {
  const data = asRecord(attempt.data);
  const sessionId = text(data.sessionId) || attempt.id;
  const turnId = text(data.turnId) || text(data.studyTurnId);
  if (isFuture(occurrenceAt(data), asOfAt) || isCrisisEvidence(snap, [attempt.id, sessionId, turnId])) return [];
  const paperId = text(data.paperId);
  const paper = paperId ? snap.factsById.get(paperId) : undefined;
  const paperData = asRecord(paper?.data);
  const paperSubject = subjectOf(paperData);
  const rows = new Map<string, Record<string, unknown>>();
  for (const raw of asList(data.feedback)) {
    const row = asRecord(raw);
    const itemId = text(row.questionId) || text(row.itemId);
    if (itemId) rows.set(itemId, row);
  }
  const occurredAt = occurrenceAt(data);
  const out: Evidence[] = [];
  for (const itemId of itemIdsForAttempt(attempt, snap)) {
    const row = rows.get(itemId) ?? {};
    const assessment = asRecord(snap.assessmentsByKey.get(`${attempt.id}:${itemId}`));
    const question = questionForItem(paperData, itemId);
    const sourceQuestionId = text(asRecord(question.sourceQuestionRef).id) || text(question.questionId);
    const questionFact = snap.factsById.get(sourceQuestionId || itemId);
    const questionData = asRecord(questionFact?.data);
    const relatedIds = [sourceQuestionId, itemId].filter(Boolean);
    const context = conceptContext(snap, relatedIds, directConceptIds(question));
    const subject = paperSubject || subjectOf(questionData) || context.subject;
    const stage = normalizedStage(assessment.errorStage) ?? normalizedStage(row.errorStage) ?? normalizedStage(data.errorStage);
    const itemConfidence = confidenceFrom(data, row, assessment, itemId);
    const itemHelp = helpFrom(data, row, assessment, itemId);
    const questionId = sourceQuestionId || (factKind(questionFact) === 'question' ? itemId : undefined);
    const prompt = text(question.prompt) || text(question.text) || text(questionData.prompt) || text(questionData.text);
    const result = verdict(assessment.verdict ?? row.verdict ?? row.result);
    out.push({
      id: `${attempt.id}:${itemId}`,
      attemptId: attempt.id,
      itemId,
      sessionId,
      verdict: result,
      ...(stage ? { errorStage: stage } : {}),
      ...(itemConfidence !== undefined ? { confidence: itemConfidence } : {}),
      ...(itemHelp !== undefined ? { helpLevel: itemHelp } : {}),
      ...(questionId ? { questionId } : {}),
      ...(paperId ? { paperId } : {}),
      ...(context.conceptId ? { conceptId: context.conceptId } : {}),
      ...(context.conceptTitle ? { conceptTitle: context.conceptTitle } : {}),
      ...(subject ? { subject: clip(subject, 64) } : {}),
      ...(prompt ? { promptExcerpt: clip(prompt, 240) } : {}),
      occurredAt,
    });
  }
  return out;
}

function collectEvidence(input: MetacognitivePatternInput): Evidence[] {
  const byKey = new Map<string, Evidence>();
  for (const fact of input.snap.factsById.values()) {
    if (fact.type !== 'activity.workbookAttempt') continue;
    for (const evidence of evidenceFromAttempt(fact, input.snap, input.asOfAt)) {
      byKey.set(`${evidence.attemptId}:${evidence.itemId}`, evidence);
    }
  }
  for (const observation of input.observations ?? []) {
    const evidence = evidenceFromObservation(observation, input.snap, input.asOfAt);
    if (evidence) byKey.set(`${evidence.attemptId}:${evidence.itemId}`, evidence);
  }
  return [...byKey.values()];
}

function confidenceNote(subjects: readonly string[], sessions: number): string {
  if (subjects.length >= 2) return `跨 ${subjects.length} 门学科、${sessions} 次独立作答证实`;
  if (subjects.length === 1) return `在 1 门学科、${sessions} 次独立作答中重复出现`;
  return `${sessions} 次独立作答证实`;
}

function buildHabit(stage: NormalizedStage, evidence: readonly Evidence[]): MetacognitiveHabit {
  const subjects = [...new Set(evidence.map((item) => item.subject).filter((value): value is string => Boolean(value)))].sort();
  const sessions = new Set(evidence.map((item) => item.sessionId));
  const evidenceIds = [...new Set(evidence.map((item) => item.id))].sort();
  return {
    id: `metacognitive-habit:${stage}`,
    patternKey: `error-stage:${stage}`,
    label: HABIT_LABELS[stage],
    errorStage: stage,
    errorStageLabel: formatErrorStageLabel(stage),
    subjects,
    sessionCount: sessions.size,
    evidenceCount: evidence.length,
    preStartHint: STAGE_HINTS[stage],
    evidenceIds,
    confidenceNote: confidenceNote(subjects, sessions.size),
  };
}

function buildAlert(evidence: Evidence): MasteryIllusionAlert | undefined {
  if (!evidence.itemId || evidence.verdict !== 'incorrect' || !isHighConfidence(evidence.confidence) || evidence.helpLevel === 'solution_seen') return undefined;
  const errorStageLabel = evidence.errorStage ? formatErrorStageLabel(evidence.errorStage) : '当前失分环节';
  const conceptTarget = evidence.conceptTitle ? `“${evidence.conceptTitle}”` : '该题对应的知识点';
  return {
    id: `mastery-illusion:${evidence.attemptId}:${evidence.itemId}`,
    ...(evidence.conceptId ? { conceptId: evidence.conceptId } : {}),
    ...(evidence.conceptTitle ? { conceptTitle: evidence.conceptTitle } : {}),
    ...(evidence.questionId ? { questionId: evidence.questionId } : {}),
    attemptId: evidence.attemptId,
    itemId: evidence.itemId,
    ...(evidence.paperId ? { paperId: evidence.paperId } : {}),
    ...(evidence.subject ? { subject: evidence.subject } : {}),
    ...(evidence.errorStage ? { errorStage: evidence.errorStage } : {}),
    ...(evidence.errorStage ? { errorStageLabel } : {}),
    confidenceLevel: 'high',
    ...(evidence.promptExcerpt ? { promptExcerpt: evidence.promptExcerpt } : {}),
    counterexampleTarget: `围绕${conceptTarget}设计一道${errorStageLabel}的最小反例或条件辨别题，检验相邻条件变化时能否保持判断。`,
    recommendedAction: evidence.questionId ? 'author_mistake_variant' : 'discriminator_probe',
    evidenceIds: [evidence.id],
  };
}

export function projectMetacognitivePatterns(input: MetacognitivePatternInput): MetacognitivePatternView {
  const evidence = collectEvidence(input);
  const groups = new Map<NormalizedStage, Evidence[]>();
  for (const item of evidence) {
    if ((item.verdict !== 'incorrect' && item.verdict !== 'partial') || !item.errorStage || !isIndependent(item.helpLevel)) continue;
    const group = groups.get(item.errorStage);
    if (group) group.push(item);
    else groups.set(item.errorStage, [item]);
  }

  const metacognitiveHabits: MetacognitiveHabit[] = [];
  let suppressedSingletonsCount = 0;
  for (const stage of STAGES) {
    const group = groups.get(stage);
    if (!group) continue;
    const subjects = new Set(group.map((item) => item.subject).filter(Boolean));
    const sessions = new Set(group.map((item) => item.sessionId));
    if (subjects.size >= 2 || sessions.size >= 3) metacognitiveHabits.push(buildHabit(stage, group));
    else suppressedSingletonsCount += 1;
  }

  const masteryIllusionAlerts: MasteryIllusionAlert[] = [];
  const seenAlerts = new Set<string>();
  for (const item of evidence) {
    const alert = buildAlert(item);
    if (!alert || seenAlerts.has(alert.id)) continue;
    seenAlerts.add(alert.id);
    masteryIllusionAlerts.push(alert);
    if (masteryIllusionAlerts.length >= 10) break;
  }
  return { metacognitiveHabits, masteryIllusionAlerts, suppressedSingletonsCount };
}
