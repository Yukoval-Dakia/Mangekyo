import {
  describeBasisFact,
  formatErrorStageLabel,
  projectAgentRecordFlow,
  projectRecordFlow,
  type FlowGraphSnapshot,
  type RawFlowFact,
  type RecordFlowAttempt,
  type RecordFlowMasteryLevel,
} from './record-flow.ts';

export type ConceptAuthoringMode = 'full' | 'cheatsheet' | 'concept_gap' | 'mistake_variant';
export type ConceptAuthoringQuery = {
  readonly topic?: string;
  readonly conceptId?: string;
  readonly sourceQuestionId?: string;
  readonly attemptId?: string;
  readonly mode?: ConceptAuthoringMode;
};
export type AuthoringBasisSnippet = {
  readonly id: string;
  readonly rev: number;
  readonly kind: 'material' | 'notion' | 'textbook' | 'note' | 'paper' | 'question';
  readonly title: string;
  readonly excerpt: string;
  readonly originLabel?: string;
};
export type AuthoringMistakeRecord = {
  readonly attemptId: string;
  readonly paperId: string;
  readonly paperTitle: string;
  readonly itemId: string;
  readonly questionId?: string;
  readonly questionPrompt?: string;
  readonly verdict: string;
  readonly errorStage?: string;
  readonly errorStageLabel?: string;
  readonly summary: string;
  readonly learnerAnswer?: string;
  readonly occurredAt: string | null;
};
export type AuthoringStickingPoint = {
  readonly kind: 'misconception' | 'discussion';
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly errorStage?: string;
  readonly errorStageLabel?: string;
  readonly occurredAt: string | null;
};
export type AuthoringSourceQuestionContext = {
  readonly id: string;
  readonly rev: number;
  readonly prompt: string;
  readonly answer?: string;
  readonly explanation?: string;
  readonly conceptIds: readonly string[];
  readonly attemptId?: string;
  readonly itemId?: string;
  readonly learnerAnswer?: string;
  readonly verdict?: string;
  readonly errorStage?: string;
  readonly errorStageLabel?: string;
  readonly mistakeSummary?: string;
};
export type AuthoringForgettingTrend = 'stable' | 'fading' | 'urgent' | 'unknown';
export type ConceptAuthoringContext = {
  readonly mode: ConceptAuthoringMode;
  readonly hasSufficientBasis: boolean;
  readonly emptyReason?: 'no_matching_concept_or_source' | 'source_question_not_found' | 'no_supporting_materials';
  readonly topic: string;
  readonly concept?: { readonly id: string; readonly rev: number; readonly title: string; readonly summary?: string; readonly subject?: string };
  readonly mastery: { readonly level: RecordFlowMasteryLevel; readonly score: number | null; readonly retrievability: number | null; readonly evidenceCount: number; readonly forgettingTrend: AuthoringForgettingTrend };
  readonly relatedConcepts: readonly { readonly id: string; readonly title: string; readonly relation: string }[];
  readonly mistakes: readonly AuthoringMistakeRecord[];
  readonly stickingPoints: readonly AuthoringStickingPoint[];
  readonly sourceSnippets: readonly AuthoringBasisSnippet[];
  readonly existingTextbookPages: readonly { readonly id: string; readonly rev: number; readonly title: string; readonly excerpt?: string }[];
  readonly existingQuestionPrompts: readonly string[];
  readonly sourceQuestion?: AuthoringSourceQuestionContext;
  readonly witnessFactIds: readonly string[];
};

type AttemptSelection = { readonly attempt: RawFlowFact; readonly itemId: string; readonly prompt: string; readonly sourceQuestionId: string };
const rec = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const text = (value: unknown, max = 600): string => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim().slice(0, max) : '';
const kinds = new Set<AuthoringBasisSnippet['kind']>(['material', 'notion', 'textbook', 'note', 'paper', 'question']);
const originLabels: Readonly<Record<string, string>> = { material: '原件', notion: 'Notion', textbook: '教材', note: '笔记', paper: '试卷', question: '题库' };
const isCrisis = (fact: RawFlowFact, snap: FlowGraphSnapshot) => fact.type === 'activity.studyTurn' && Boolean(snap.feedbackByTurnId.get(fact.id)?.isCrisis);

/** Normalize any parseable timestamp to canonical ISO; unparseable or missing values degrade honestly. */
function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

function blockText(fact?: Pick<RawFlowFact, 'data'>): string {
  const data = rec(fact?.data);
  return arr(data.blocks).map(block => {
    const body = rec(rec(block).body);
    return text(body.text) || text(body.latex) || arr(body.rows).map(row => arr(row).map(cell => text(cell, 160)).join(' ｜ ')).join('\n');
  }).filter(Boolean).join('\n');
}

const ANSWER_LABEL = /^(?:参考答案|标准答案|答案)\s*[：:]\s*(.*)$/;
const RUBRIC_LABEL = /^(?:评分要点|评分标准|解析|解题思路|要点|说明)\s*[：:]\s*(.*)$/;

/** Mirror the content-module question solution extraction over raw asset blocks (labels + answer/solution ids). */
function solutionBlocks(data: Record<string, unknown>, promptBlockId: string): { answer: string; explanation: string } {
  const answerParts: string[] = [];
  const rubricParts: string[] = [];
  for (const rawBlock of arr(data.blocks)) {
    const block = rec(rawBlock);
    const blockId = str(block.id);
    if (blockId && blockId === promptBlockId) continue;
    const body = rec(block.body);
    const raw = str(body.text) || str(body.latex);
    if (!raw) continue;
    let section: 'answer' | 'rubric' | null = null;
    const blockAnswers: string[] = [];
    const blockRubrics: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      const answerMatch = ANSWER_LABEL.exec(trimmed);
      if (answerMatch) {
        section = 'answer';
        if (answerMatch[1]?.trim()) blockAnswers.push(answerMatch[1].trim());
        continue;
      }
      const rubricMatch = RUBRIC_LABEL.exec(trimmed);
      if (rubricMatch) {
        section = 'rubric';
        if (rubricMatch[1]?.trim()) blockRubrics.push(rubricMatch[1].trim());
        continue;
      }
      if (section === 'answer' && trimmed) blockAnswers.push(trimmed);
      else if (section === 'rubric' && trimmed) blockRubrics.push(trimmed);
    }
    if (blockAnswers.length || blockRubrics.length) {
      if (blockAnswers.length) answerParts.push(blockAnswers.join('\n'));
      if (blockRubrics.length) rubricParts.push(blockRubrics.join('\n'));
    } else if (blockId === 'answer' || blockId === 'solution') {
      answerParts.push(raw);
    } else {
      rubricParts.push(raw);
    }
  }
  return { answer: answerParts.join('\n').trim().slice(0, 4000), explanation: rubricParts.join('\n').trim().slice(0, 8000) };
}

function questionFields(fact?: Pick<RawFlowFact, 'data'>): { prompt: string; answer: string; explanation: string } {
  const data = rec(fact?.data);
  const blocks = arr(data.blocks);
  const promptBlock = blocks.find(block => str(rec(block).id) === str(data.promptBlockId));
  const prompt = text(data.prompt, 2400) || text(rec(rec(promptBlock).body).text, 2400);
  const fromBlocks = solutionBlocks(data, str(data.promptBlockId));
  const answer = text(data.answer, 1600) || text(data.expected, 1600) || text(fromBlocks.answer, 1600);
  const explanation = text(data.explanation, 1600) || text(data.rubric, 1600) || text(rec(data.assessment_contract).explanation, 1600) || text(fromBlocks.explanation, 1600);
  return { prompt, answer, explanation };
}

function excerptOf(fact: RawFlowFact): string {
  const data = rec(fact.data);
  const paperPrompts = fact.type === 'activity.workbookPaper' ? arr(data.questions).map(question => text(rec(question).prompt, 240)).filter(Boolean).join('；') : '';
  return text(data.summary) || text(data.excerpt) || text(data.text) || questionFields(fact).prompt || text(blockText(fact)) || text(data.answer) || text(paperPrompts);
}

function snippetOf(fact: RawFlowFact): AuthoringBasisSnippet | undefined {
  const meta = describeBasisFact(fact.type, fact.data);
  const kind = meta.kind;
  if (!kind || !kinds.has(kind as AuthoringBasisSnippet['kind'])) return undefined;
  const excerpt = excerptOf(fact);
  if (!excerpt) return undefined;
  const typedKind = kind as AuthoringBasisSnippet['kind'];
  return { id: fact.id, rev: fact.rev, kind: typedKind, title: meta.title ?? fact.id, excerpt, ...(originLabels[kind] ? { originLabel: originLabels[kind] } : {}) };
}

function selectAttempt(snap: FlowGraphSnapshot, attemptId: string, wantedSourceQuestionId?: string): AttemptSelection | undefined {
  const attempt = snap.factsById.get(attemptId);
  if (!attempt || attempt.type !== 'activity.workbookAttempt') return undefined;
  const data = rec(attempt.data);
  const paper = snap.factsById.get(str(data.paperId));
  // The frozen paper embedded in the attempt fills in when the paper fact is unavailable.
  const questions = [...arr(rec(paper?.data).questions), ...arr(rec(data.paper).questions)].map(rec);
  const rows = arr(data.feedback).map(rec);
  const verdictOf = (row: Record<string, unknown>): string =>
    snap.assessmentsByKey.get(`${attemptId}:${str(row.questionId)}`)?.verdict ?? str(row.result);
  const isWrong = (row: Record<string, unknown>): boolean => ['incorrect', 'partial'].includes(verdictOf(row));
  const sourceOf = (row: Record<string, unknown>): string => {
    const itemId = str(row.questionId);
    const question = questions.find(item => str(item.id) === itemId);
    return str(rec(question?.sourceQuestionRef).id);
  };
  // When a source question is named, pick the row answering that exact question instead of
  // blindly taking the first wrong item on a multi-question paper.
  let row: Record<string, unknown> | undefined;
  if (wantedSourceQuestionId) {
    row = rows.find(candidate => sourceOf(candidate) === wantedSourceQuestionId && isWrong(candidate))
      ?? rows.find(candidate => sourceOf(candidate) === wantedSourceQuestionId);
  }
  row = row ?? rows.find(isWrong) ?? rows[0];
  const itemId = str(row?.questionId) || str(questions[0]?.id);
  const question = questions.find(item => str(item.id) === itemId) ?? questions[0];
  const sourceQuestionId = str(rec(question?.sourceQuestionRef).id);
  if (!sourceQuestionId || !snap.factsById.has(sourceQuestionId)) return undefined;
  return { attempt, itemId: itemId || str(row?.questionId), prompt: text(question?.prompt, 2400), sourceQuestionId };
}

function sourceContext(snap: FlowGraphSnapshot, questionId: string, selection?: AttemptSelection): AuthoringSourceQuestionContext | undefined {
  const fact = snap.factsById.get(questionId);
  if (!fact || describeBasisFact(fact.type, fact.data).kind !== 'question') return undefined;
  const fields = questionFields(fact);
  const prompt = fields.prompt || selection?.prompt || '';
  if (!prompt) return { id: fact.id, rev: fact.rev, prompt: '', conceptIds: [] };
  const conceptIds = [...new Set((snap.neighborsById.get(fact.id) ?? []).filter(edge => {
    const target = snap.factsById.get(edge.targetId);
    return target && describeBasisFact(target.type, target.data).kind === 'concept';
  }).map(edge => edge.targetId))];
  if (!selection) return { id: fact.id, rev: fact.rev, prompt, ...(fields.answer ? { answer: fields.answer } : {}), ...(fields.explanation ? { explanation: fields.explanation } : {}), conceptIds };
  const attempt = selection.attempt;
  const row = arr(rec(attempt.data).feedback).map(rec).find(item => str(item.questionId) === selection.itemId);
  const assessment = snap.assessmentsByKey.get(`${attempt.id}:${selection.itemId}`);
  const verdict = assessment?.verdict || str(row?.result) || undefined;
  const errorStage = assessment?.errorStage || str(row?.errorStage) || undefined;
  const learnerAnswer = text(row?.answer, 1600) || text(rec(rec(attempt.data).answers)[selection.itemId], 1600);
  const misconception = (snap.assertionsByRef.get(attempt.id) ?? []).flatMap(assertion => arr(rec(assertion.data).evidence).map(rec).filter(ev => str(ev.id) === attempt.id && str(ev.itemId) === selection.itemId).map(() => text(rec(assertion.data).text))).find(Boolean);
  const mistakeSummary = misconception || (errorStage ? `${formatErrorStageLabel(errorStage)}：作答需要针对该环节复盘。` : verdict === 'incorrect' || verdict === 'partial' ? '本次作答未完全正确，需对照原题与作答复盘。' : undefined);
  return { id: fact.id, rev: fact.rev, prompt, ...(fields.answer ? { answer: fields.answer } : {}), ...(fields.explanation ? { explanation: fields.explanation } : {}), conceptIds, attemptId: attempt.id, ...(selection.itemId ? { itemId: selection.itemId } : {}), ...(learnerAnswer ? { learnerAnswer } : {}), ...(verdict ? { verdict } : {}), ...(errorStage ? { errorStage, errorStageLabel: formatErrorStageLabel(errorStage) } : {}), ...(mistakeSummary ? { mistakeSummary } : {}) };
}

function answerOf(attempt: RecordFlowAttempt, snap: FlowGraphSnapshot): string {
  const fact = snap.factsById.get(attempt.attemptId);
  const row = arr(rec(fact?.data).feedback).map(rec).find(item => str(item.questionId) === attempt.itemId);
  return text(row?.answer, 800) || text(rec(rec(fact?.data).answers)[attempt.itemId], 800);
}

/** Pure, bounded authoring basis assembled only from authorized flow facts. */
export function buildConceptAuthoringContext(query: ConceptAuthoringQuery, snap: FlowGraphSnapshot): ConceptAuthoringContext {
  const topic = str(query.topic);
  const mode = query.mode ?? (query.sourceQuestionId || query.attemptId ? 'mistake_variant' : 'full');
  const explicitQuestionId = str(query.sourceQuestionId);
  const attemptSelection = query.attemptId ? selectAttempt(snap, query.attemptId, explicitQuestionId || undefined) : undefined;
  const selection = attemptSelection && (!explicitQuestionId || explicitQuestionId === attemptSelection.sourceQuestionId) ? attemptSelection : undefined;
  const requestedQuestionId = explicitQuestionId || selection?.sourceQuestionId || '';
  const sourceQuestion = requestedQuestionId ? sourceContext(snap, requestedQuestionId, selection) : undefined;
  const requestedConcept = str(query.conceptId) ? snap.factsById.get(str(query.conceptId)) : undefined;
  const explicitConcept = requestedConcept && describeBasisFact(requestedConcept.type, requestedConcept.data).kind === 'concept' ? requestedConcept : undefined;
  const topicNeedle = topic.normalize('NFKC').toLocaleLowerCase();
  // Deterministic concept resolution: exact title/canonical-name matches win over fuzzy hits,
  // ties resolve by fact id rather than by iteration order.
  const topicConcept = !explicitConcept && topicNeedle ? [...snap.factsById.values()].filter(fact => {
    const data = rec(fact.data);
    return describeBasisFact(fact.type, fact.data).kind === 'concept' && `${str(data.title)} ${str(data.canonicalName)} ${str(data.summary)} ${blockText(fact)}`.normalize('NFKC').toLocaleLowerCase().includes(topicNeedle);
  }).sort((left, right) => {
    const exact = (fact: RawFlowFact): number => {
      const data = rec(fact.data);
      const names = [str(data.title), str(data.canonicalName)].map(name => name.normalize('NFKC').toLocaleLowerCase());
      return names.includes(topicNeedle) ? 0 : 1;
    };
    return exact(left) - exact(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  })[0] : undefined;
  const linkedConcept = !explicitConcept && sourceQuestion ? snap.factsById.get(sourceQuestion.conceptIds[0] ?? '') : undefined;
  const conceptFact = explicitConcept ?? topicConcept ?? linkedConcept;
  const flow = conceptFact ? projectRecordFlow(conceptFact.id, snap) : sourceQuestion ? projectRecordFlow(sourceQuestion.id, snap) : null;
  const conceptData = rec(conceptFact?.data);
  const summary = text(conceptData.summary) || text(blockText(conceptFact));
  const concept = conceptFact && flow ? { id: conceptFact.id, rev: conceptFact.rev, title: flow.identity.title, ...(summary ? { summary } : {}), ...(flow.identity.subject ? { subject: flow.identity.subject } : {}) } : undefined;
  const mastery = flow?.mastery ?? { level: 'unknown' as const, score: null, retrievability: null, evidenceCount: 0 };
  const forgettingTrend: AuthoringForgettingTrend = mastery.retrievability === null ? 'unknown' : mastery.retrievability < 0.55 ? 'urgent' : mastery.retrievability < 0.78 ? 'fading' : 'stable';
  const relatedConcepts = (flow?.graphNeighbors ?? []).filter(item => item.kind === 'concept').slice(0, 10).map(item => ({ id: item.id, title: item.title, relation: item.relation }));
  const questionByItem = new Map<string, { id: string; prompt: string }>();
  for (const attempt of flow?.attempts ?? []) {
    const paper = snap.factsById.get(attempt.paperId);
    for (const raw of arr(rec(paper?.data).questions)) {
      const item = rec(raw);
      questionByItem.set(`${attempt.attemptId}:${str(item.id)}`, { id: str(rec(item.sourceQuestionRef).id), prompt: text(item.prompt, 1200) });
    }
  }
  const mistakes = (flow?.attempts ?? []).filter(attempt => attempt.verdict === 'incorrect' || attempt.verdict === 'partial' || Boolean(attempt.errorStage)).slice(0, 10).map(attempt => {
    const question = questionByItem.get(`${attempt.attemptId}:${attempt.itemId}`);
    const questionId = question?.id || undefined;
    const questionPrompt = question?.prompt || (questionId ? questionFields(snap.factsById.get(questionId)).prompt : '') || undefined;
    const assertion = (snap.assertionsByRef.get(attempt.attemptId) ?? []).find(fact => arr(rec(fact.data).evidence).some(raw => str(rec(raw).itemId) === attempt.itemId));
    const learnerAnswer = answerOf(attempt, snap);
    return { attemptId: attempt.attemptId, paperId: attempt.paperId, paperTitle: attempt.paperTitle, itemId: attempt.itemId, ...(questionId ? { questionId } : {}), ...(questionPrompt ? { questionPrompt } : {}), verdict: attempt.verdict, ...(attempt.errorStage ? { errorStage: attempt.errorStage, errorStageLabel: formatErrorStageLabel(attempt.errorStage) } : {}), summary: text(rec(assertion?.data).text) || `${attempt.paperTitle}（题 ${attempt.itemId}）${attempt.errorStage ? `出现${formatErrorStageLabel(attempt.errorStage)}阶段错因` : '作答未完全正确，需要复盘'}`, ...(learnerAnswer ? { learnerAnswer } : {}), occurredAt: isoOrNull(attempt.occurredAt) };
  });
  const stickingPoints: AuthoringStickingPoint[] = [
    ...(flow?.misconceptions ?? []).map(item => {
      const errorStageLabel = item.errorStage ? formatErrorStageLabel(item.errorStage) : undefined;
      return { kind: 'misconception' as const, id: item.id, title: errorStageLabel ? `${errorStageLabel}错因` : '薄弱错因', excerpt: item.summary, ...(item.errorStage && errorStageLabel ? { errorStage: item.errorStage, errorStageLabel } : {}), occurredAt: isoOrNull(snap.factsById.get(item.id)?.createdTick ?? null) };
    }),
    ...(flow?.discussions ?? []).filter(item => !snap.feedbackByTurnId.get(item.turnId)?.isCrisis).map(item => ({ kind: 'discussion' as const, id: item.turnId, title: item.title, excerpt: item.excerpt, occurredAt: isoOrNull(item.occurredAt) })),
  ].slice(0, 8);
  const relatedIds = new Set<string>();
  for (const item of [...(flow?.graphNeighbors ?? []), ...(flow?.provenance ?? []), ...(flow?.derived ?? [])]) if (item.id !== 'onboarding') relatedIds.add(item.id);
  if (sourceQuestion) relatedIds.add(sourceQuestion.id);
  for (const mistake of mistakes) { relatedIds.add(mistake.paperId); if (mistake.questionId) relatedIds.add(mistake.questionId); }
  const matchesTopic = (fact: RawFlowFact) => topicNeedle && `${describeBasisFact(fact.type, fact.data).title ?? ''} ${excerptOf(fact)} ${text(rec(fact.data).subject)}`.toLocaleLowerCase().includes(topicNeedle);
  const candidates = new Map<string, RawFlowFact>();
  for (const fact of snap.factsById.values()) if (!isCrisis(fact, snap) && (relatedIds.has(fact.id) || matchesTopic(fact))) candidates.set(fact.id, fact);
  const sourceSnippets = [...candidates.values()].map(snippetOf).filter((item): item is AuthoringBasisSnippet => Boolean(item)).slice(0, 10);
  const existingTextbookPages = [...candidates.values()].filter(fact => fact.type === 'content.textbookPage').slice(0, 6).map(fact => ({ id: fact.id, rev: fact.rev, title: describeBasisFact(fact.type, fact.data).title ?? fact.id, ...(excerptOf(fact) ? { excerpt: excerptOf(fact) } : {}) }));
  const existingQuestionPrompts: string[] = [];
  for (const fact of candidates.values()) {
    if (describeBasisFact(fact.type, fact.data).kind === 'question') { const prompt = questionFields(fact).prompt; if (prompt && !existingQuestionPrompts.includes(prompt)) existingQuestionPrompts.push(prompt); }
    if (fact.type === 'activity.workbookPaper') for (const raw of arr(rec(fact.data).questions)) { const prompt = text(rec(raw).prompt, 1200); if (prompt && !existingQuestionPrompts.includes(prompt)) existingQuestionPrompts.push(prompt); }
    if (existingQuestionPrompts.length >= 12) break;
  }
  const baseWitnesses = conceptFact ? projectAgentRecordFlow(conceptFact.id, snap)?.witnessFactIds ?? [] : sourceQuestion ? projectAgentRecordFlow(sourceQuestion.id, snap)?.witnessFactIds ?? [] : [];
  const witnessFactIds = [...new Set([...baseWitnesses, ...relatedIds, ...mistakes.flatMap(item => [item.attemptId, item.paperId]), ...stickingPoints.map(item => item.id.startsWith('error:') ? item.id.slice(6).split(':')[0] ?? '' : item.id)])].filter(id => { const fact = snap.factsById.get(id); return id !== 'onboarding' && Boolean(fact && !isCrisis(fact, snap)); });
  const hasBasisMaterial = Boolean(summary || sourceSnippets.length || mistakes.length || stickingPoints.length || existingTextbookPages.length || existingQuestionPrompts.length);
  const emptyReason = mode === 'mistake_variant' && !sourceQuestion?.prompt ? 'source_question_not_found' : !concept && !sourceSnippets.length && !existingTextbookPages.length && !mistakes.length ? 'no_matching_concept_or_source' : concept && !hasBasisMaterial ? 'no_supporting_materials' : undefined;
  return { mode, hasSufficientBasis: emptyReason === undefined, ...(emptyReason ? { emptyReason } : {}), topic: concept?.title ?? topic, ...(concept ? { concept } : {}), mastery: { ...mastery, forgettingTrend }, relatedConcepts, mistakes, stickingPoints, sourceSnippets, existingTextbookPages, existingQuestionPrompts: existingQuestionPrompts.slice(0, 12), ...(sourceQuestion ? { sourceQuestion } : {}), witnessFactIds };
}
