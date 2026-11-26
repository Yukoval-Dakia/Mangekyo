import { assetType, parseAsset, questionPrompt, questionSolutionFields } from '@mangekyo/module-content/facts/asset-contract';
import { RequestError } from '@mangekyo/module-capture/facts/request';
import { parseKnowledgeEdge } from '@mangekyo/module-content/facts/knowledge-edge';
import { projectRecordFlow, type FlowGraphSnapshot } from '@mangekyo/module-learner/facts/record-flow';
import { workbookAttempt, workbookAttemptType } from './workbook-values.ts';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clip = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit) || undefined;
const text = (value: unknown) => typeof value === 'string' ? clip(value, 500) : undefined;

const STAGE_LABELS: Readonly<Record<string, string>> = {
  reading: '审题漏条件', modeling: '概念模型错误', strategy: '思路卡壳', execution: '计算或执行失误', expression: '表达规范丢分',
};

export type AdversarialSpotInput = {
  readonly questionId?: string; readonly title?: string; readonly prompt: string;
  readonly correctAnswer?: string; readonly correctSolution?: string;
  readonly conceptId?: string; readonly conceptTitle?: string;
  readonly errorStage?: string; readonly errorStageLabel?: string;
  readonly misconceptionSummary?: string; readonly learnerAnswer?: string;
  readonly sourceIds: readonly string[];
};

export type AdversarialRequestInput = {
  readonly kind: 'spot_the_flaw' | 'mastery_bridge';
  readonly questionId?: string; readonly attemptId?: string; readonly conceptId?: string;
  readonly targetConceptId?: string; readonly learnerStickingPoint?: string;
};

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const optionalUlid = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ulidPattern.test(value)) throw new RequestError(400, `${label}无效。`);
  return value;
};

/** Parse the adversarial activity request body; requestId is validated by the host. */
export function parseAdversarialInput(raw: unknown): AdversarialRequestInput {
  const value = record(raw);
  const kind = value.kind;
  if (kind !== 'spot_the_flaw' && kind !== 'mastery_bridge') throw new RequestError(400, '活动类型无效。');
  const sticking = value.learnerStickingPoint;
  const questionId = optionalUlid(value.questionId, '题目标识');
  const attemptId = optionalUlid(value.attemptId, '作答标识');
  const conceptId = optionalUlid(value.conceptId, '概念标识');
  const targetConceptId = optionalUlid(value.targetConceptId, '目标概念标识');
  const stickingText = typeof sticking === 'string' ? clip(sticking, 500) : undefined;
  return {
    kind,
    ...(questionId !== undefined ? { questionId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(conceptId !== undefined ? { conceptId } : {}),
    ...(targetConceptId !== undefined ? { targetConceptId } : {}),
    ...(stickingText !== undefined ? { learnerStickingPoint: stickingText } : {}),
  };
}

export type PreparedAdversarialInput =
  | { readonly kind: 'spot_the_flaw'; readonly input: AdversarialSpotInput }
  | { readonly kind: 'mastery_bridge'; readonly input: MasteryBridgeTarget & { readonly learnerStickingPoint?: string } };

/** Assemble the generator input from authorized evidence only; fail closed without fabricating anchors or prompts. */
export function prepareAdversarialInput(snap: FlowGraphSnapshot, request: AdversarialRequestInput): PreparedAdversarialInput {
  if (request.kind === 'spot_the_flaw') {
    const extracted = extractSpotTheFlawInput(snap, {
      ...(request.questionId !== undefined ? { questionId: request.questionId } : {}),
      ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
      ...(request.conceptId !== undefined ? { conceptId: request.conceptId } : {}),
    });
    if (!extracted) throw new RequestError(404, '缺少可授权读取的题目与作答依据。', 'invalid_input');
    return { kind: 'spot_the_flaw', input: extracted };
  }
  if (request.targetConceptId === undefined) throw new RequestError(400, '桥接类比需要目标概念标识。', 'invalid_input');
  const bridge = extractMasteryBridgeInput(snap, { targetConceptId: request.targetConceptId });
  if (!bridge) throw new RequestError(404, '目标概念不存在或当前不可授权读取。', 'invalid_input');
  if (!bridge.masteredAnchors.length)
    throw new RequestError(400, '缺少已彻底掌握（掌握度 ≥ 0.8）的旧稳锚点，无法生成个性化桥接类比。', 'invalid_input');
  return { kind: 'mastery_bridge', input: { ...bridge, ...(request.learnerStickingPoint !== undefined ? { learnerStickingPoint: request.learnerStickingPoint } : {}) } };
}

function questionAssetInfo(snap: FlowGraphSnapshot, questionId: string) {
  const fact = snap.factsById.get(questionId);
  if (!fact || fact.type !== assetType) return undefined;
  try {
    const asset = parseAsset(fact.data);
    if (asset.kind !== 'question') return undefined;
    const solution = questionSolutionFields(asset);
    return {
      prompt: questionPrompt(asset).trim(), title: clip(asset.title, 120),
      ...(solution.answer ? { correctAnswer: solution.answer } : {}),
      ...(solution.rubric ? { correctSolution: solution.rubric } : {}),
    };
  } catch { return undefined; }
}

function firstConceptEdge(snap: FlowGraphSnapshot, questionId: string): { id: string; title?: string } | undefined {
  const linked: { id: string; title?: string }[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    try {
      const edge = parseKnowledgeEdge(fact.data);
      if (edge.kind !== 'targets_concept' || edge.from.sourceUse.id !== questionId) continue;
      const conceptId = edge.to.sourceUse.id;
      const concept = snap.factsById.get(conceptId);
      if (!concept || entityKind(concept.data) !== 'concept') continue;
      const title = factTitleOf(concept.data);
      linked.push({ id: conceptId, ...(title ? { title } : {}) });
    } catch { continue; }
  }
  linked.sort((left, right) => left.id.localeCompare(right.id));
  return linked[0];
}

function factTitleOf(data: unknown): string | undefined {
  const value = record(data);
  return typeof value.title === 'string' ? clip(value.title, 120) : undefined;
}

function misconceptionText(snap: FlowGraphSnapshot, targetIds: readonly string[]): string | undefined {
  for (const targetId of targetIds) {
    for (const fact of snap.assertionsByRef.get(targetId) ?? []) {
      const data = record(fact.data);
      if (typeof data.status === 'string' && data.status !== 'active' && data.status !== 'observed') continue;
      const candidate = text(data.text) ?? text(data.summary) ?? text(data.claim);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

/** Extract the spot-the-flaw activity input from authorized evidence; undefined when the prompt basis is missing. */
export function extractSpotTheFlawInput(
  snap: FlowGraphSnapshot, options: { questionId?: string; attemptId?: string; conceptId?: string },
): AdversarialSpotInput | undefined {
  let questionId = options.questionId;
  let prompt: string | undefined;
  let correctAnswer: string | undefined;
  let correctSolution: string | undefined;
  let title: string | undefined;
  let errorStage: string | undefined;
  let learnerAnswer: string | undefined;
  const sourceIds: string[] = [];

  if (options.attemptId !== undefined) {
    const fact = snap.factsById.get(options.attemptId);
    if (!fact || fact.type !== workbookAttemptType) return undefined;
    let attempt: ReturnType<typeof workbookAttempt>;
    try { attempt = workbookAttempt(fact.data); } catch { return undefined; }
    const items = attempt.paper.questions.filter(question =>
      question.sourceQuestionRef && (questionId === undefined || question.sourceQuestionRef.id === questionId));
    const feedbacks = attempt.feedback.filter(item => items.some(question => question.id === item.questionId));
    const chosen = feedbacks.find(item => item.result === 'incorrect') ?? feedbacks.find(item => item.result === 'partial') ??
      (items.length === 1 ? feedbacks.find(item => item.questionId === items[0]!.id) : undefined);
    if (!chosen) return undefined;
    const question = items.find(item => item.id === chosen.questionId);
    if (!question?.sourceQuestionRef) return undefined;
    questionId = question.sourceQuestionRef.id;
    errorStage = typeof chosen.errorStage === 'string' ? chosen.errorStage : undefined;
    if (typeof chosen.answer === 'string') learnerAnswer = clip(chosen.answer, 400);
    sourceIds.push(fact.id);
  }

  if (questionId === undefined) return undefined;
  // Require the source question asset itself to be live & teaching-authorized; never fall back to an embedded attempt copy.
  const asset = questionAssetInfo(snap, questionId);
  if (!asset || !asset.prompt) return undefined;
  prompt = asset.prompt;
  title = asset.title;
  correctAnswer = asset.correctAnswer;
  correctSolution = asset.correctSolution;
  sourceIds.push(questionId);

  let concept: { id: string; title?: string } | undefined;
  if (options.conceptId !== undefined) {
    const fact = snap.factsById.get(options.conceptId);
    if (!fact || entityKind(fact.data) !== 'concept') return undefined;
    const cTitle = factTitleOf(fact.data);
    concept = { id: fact.id, ...(cTitle !== undefined ? { title: cTitle } : {}) };
  } else {
    concept = firstConceptEdge(snap, questionId);
  }
  if (concept) sourceIds.push(concept.id);
  const misconception = misconceptionText(snap, [questionId, ...(concept ? [concept.id] : [])]);

  return {
    questionId, prompt: prompt.trim(), sourceIds,
    ...(title !== undefined ? { title } : {}),
    ...(correctAnswer !== undefined ? { correctAnswer } : {}),
    ...(correctSolution !== undefined ? { correctSolution } : {}),
    ...(concept !== undefined ? { conceptId: concept.id, ...(concept.title !== undefined ? { conceptTitle: concept.title } : {}) } : {}),
    ...(errorStage !== undefined ? { errorStage, errorStageLabel: STAGE_LABELS[errorStage] ?? errorStage } : {}),
    ...(misconception !== undefined ? { misconceptionSummary: misconception } : {}),
    ...(learnerAnswer !== undefined ? { learnerAnswer } : {}),
  };
}

export type MasteryBridgeTarget = {
  readonly targetConceptId: string; readonly targetConceptTitle: string; readonly targetConceptSummary?: string;
  readonly masteredAnchors: readonly {
    readonly id: string; readonly kind: 'concept' | 'question' | 'method' | 'note';
    readonly title: string; readonly summary?: string; readonly mastery: number;
  }[];
};

function entityKind(data: unknown): 'concept' | 'question' | 'method' | 'note' | undefined {
  const kind = record(data).kind;
  return kind === 'concept' || kind === 'question' || kind === 'method' ? kind : undefined;
}

/** Build the mastery-bridge input from authorized mastery evidence; anchors are projections, never fabricated. */
export function extractMasteryBridgeInput(
  snap: FlowGraphSnapshot, options: { targetConceptId: string },
): MasteryBridgeTarget | undefined {
  const targetFact = snap.factsById.get(options.targetConceptId);
  if (!targetFact || entityKind(targetFact.data) !== 'concept') return undefined;
  const targetTitle = factTitleOf(targetFact.data);
  if (!targetTitle) return undefined;
  const anchors: {
    id: string; kind: 'concept' | 'question' | 'method' | 'note'; title: string; mastery: number;
  }[] = [];
  for (const fact of snap.factsById.values()) {
    if (fact.id === options.targetConceptId) continue;
    const kind = entityKind(fact.data);
    if (kind !== 'concept') continue;
    const flow = projectRecordFlow(fact.id, snap);
    if (!flow || flow.mastery.level !== 'solid' || flow.mastery.score === null || flow.mastery.score < 0.8) continue;
    const title = factTitleOf(fact.data) ?? flow.identity.title;
    const clipped = title !== undefined ? clip(title, 120) : undefined;
    if (clipped === undefined) continue;
    anchors.push({ id: fact.id, kind, title: clipped, mastery: Math.round(flow.mastery.score * 1000) / 1000 });
  }
  anchors.sort((left, right) => right.mastery - left.mastery || left.id.localeCompare(right.id));
  return {
    targetConceptId: options.targetConceptId, targetConceptTitle: targetTitle,
    masteredAnchors: anchors.slice(0, 8),
  };
}
