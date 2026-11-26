import {
  invokeBackgroundCompletion,
  mapTeachingErrorToAuthoringError,
  resolveBackgroundProvider,
  AuthoringError,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';

export type SpotTheFlawInput = {
  readonly questionId?: string;
  readonly title?: string;
  readonly prompt: string;
  readonly correctAnswer?: string | null;
  readonly correctSolution?: string | null;
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly errorStage?: string | null;
  readonly errorStageLabel?: string | null;
  readonly misconceptionSummary?: string | null;
  readonly learnerAnswer?: string | null;
  readonly sourceIds?: readonly string[];
};

export type MasteryBridgeAnchor = {
  readonly id: string;
  readonly kind?: 'concept' | 'question' | 'method' | 'note';
  readonly title: string;
  readonly summary?: string | null;
  readonly mastery: number;
  readonly subject?: string | null;
};

export type MasteryBridgeInput = {
  readonly targetConceptId?: string;
  readonly targetConceptTitle: string;
  readonly targetConceptSummary?: string | null;
  readonly targetSubject?: string | null;
  readonly learnerStickingPoint?: string | null;
  readonly masteredAnchors: readonly MasteryBridgeAnchor[];
};

export type AdversarialActivityOptions = {
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
};

export type SpotTheFlawStep = {
  readonly stepNumber: number;
  readonly statement: string;
};

export type SpotTheFlawCheckpoint = {
  readonly flawedStepNumber: number;
  readonly divergencePoint: string;
  readonly hiddenTrapReason: string;
  readonly correctionDirection: string;
};

export type SpotTheFlawActivity = {
  readonly kind: 'spot_the_flaw';
  readonly title: string;
  readonly prompt: string;
  readonly flawedSteps: readonly SpotTheFlawStep[];
  readonly plausibleConclusion: string;
  readonly checkpoint: SpotTheFlawCheckpoint;
  readonly targetErrorStage?: string;
  readonly conceptId?: string;
  readonly questionId?: string;
  readonly sourceIds: readonly string[];
};

export type MasteryBridgeMapping = {
  readonly anchorElement: string;
  readonly targetElement: string;
  readonly whyItMaps: string;
};

export type MasteryBridgeAnalogy = {
  readonly kind: 'mastery_bridge';
  readonly targetConceptTitle: string;
  readonly targetConceptId?: string;
  readonly anchorId: string;
  readonly anchorTitle: string;
  readonly headline: string;
  readonly bridgeExplanation: string;
  readonly structuralMappings: readonly MasteryBridgeMapping[];
  readonly analogyLimits: readonly string[];
  readonly quickCheckPrompt: string;
  readonly sourceIds: readonly string[];
};

export type AdversarialUsage = {
  readonly model: string;
  readonly reportedModel?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs: number;
};

export type SpotTheFlawResult = {
  readonly activity: SpotTheFlawActivity;
  readonly usage: AdversarialUsage;
};

export type MasteryBridgeResult = {
  readonly analogy: MasteryBridgeAnalogy;
  readonly usage: AdversarialUsage;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

function whitelistedIds(raw: unknown, allowed: ReadonlySet<string>): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && allowed.has(id.trim())).map(id => id.trim()))].slice(0, 16)
    : [];
}

function failValidation(message: string): never {
  throw new AuthoringError('model_failed', message);
}

function buildSpotTheFlawSystemPrompt(): string {
  return [
    '你是学习者的私人教研教练，负责构造「给伪解答挑隐藏漏洞」的高阶反向迁移活动：学习者要审阅一份看似严谨的伪解答，亲手揪出其中唯一一处隐藏漏洞。',
    '严格针对输入中学习者的 errorStage（错步阶段）与 misconceptionSummary（错因）构造漏洞：漏洞必须与该学习者真实错法结构同构，是「看起来合理、实际隐蔽分叉」的逻辑陷阱，而不是 random 笔误或明显胡说。',
    '硬约束：',
    '1. flawedSteps 写 2-8 步表面严谨、语气自然、步骤连贯的解题过程；步骤按数组顺序从 1 开始编号。绝不允许在步骤正文里剧透或暗示哪一步有错，禁止出现「错误」「漏洞」「陷阱」「故意」「这一步有问题」等任何元提示字眼，每一步都要写得像认真的解题。',
    '2. 全篇有且仅有一处精准的逻辑漏洞，且必须完整落在某一个步骤上；其余步骤必须严格正确。plausibleConclusion 是伪解答最终得出的看似合理却错误的结论。',
    '3. checkpoint 是写给教研侧的隐藏诊断答案，绝不出现在步骤正文中：flawedStepNumber 必须精确指向 flawedSteps 数组顺序编号（从 1 开始）中真实存在且含漏洞的那一步；divergencePoint 说明在哪一步、以何种隐蔽方式开始分叉；hiddenTrapReason 结合学习者错因解释为什么它看起来合理实际有漏洞；correctionDirection 给出正确修正思路与关键检查点。',
    '4. sourceIds 只能逐字复用输入提供的来源 ID，禁止编造；没有合适来源时输出空数组。',
    '5. 仅输出一个严格 JSON 对象，不要输出任何额外解释。',
    '输出 Schema：{"title":string,"flawedSteps":[{"statement":string}],"plausibleConclusion":string,"checkpoint":{"flawedStepNumber":number,"divergencePoint":string,"hiddenTrapReason":string,"correctionDirection":string},"sourceIds":[string]}',
  ].join('\n');
}

function buildMasteryBridgeSystemPrompt(): string {
  return [
    '你是学习者的私人教研教练，负责「旧稳桥接新知」：用学习者已经彻底掌握的旧知识锚点，为正在卡住的新概念搭建个性化类比桥，实现正向迁移。',
    '硬约束：',
    '1. 只能从输入 masteredAnchors 中选择一个真正彻底掌握（掌握度 ≥ 0.8）的锚点，anchorId 必须逐字复用该锚点的 id；绝对禁止编造锚点、选择未提供的 id 或虚构掌握度。',
    '2. 桥接必须抓住真正的结构同构而不是表面相似；structuralMappings 至少 2 组，每组写清旧稳概念中的对应要素 anchorElement、新概念中的对应要素 targetElement，以及为什么结构同构 whyItMaps。',
    '3. 必须诚实给出至少 1 条 analogyLimits：这个类比在哪里失效、哪里不再适用，防止学习者迁移过头产生新误解；禁止为了凑数写空泛废话。',
    '4. bridgeExplanation 要结合学习者的卡点 learnerStickingPoint 讲清「用旧直觉撬动新概念」的路径；quickCheckPrompt 是一句能立即检验桥接是否真懂的小追问。',
    '5. 仅输出一个严格 JSON 对象，不要输出任何额外解释。',
    '输出 Schema：{"anchorId":string,"headline":string,"bridgeExplanation":string,"structuralMappings":[{"anchorElement":string,"targetElement":string,"whyItMaps":string}],"analogyLimits":[string],"quickCheckPrompt":string}',
  ].join('\n');
}

function sanitizeSpotTheFlaw(raw: Record<string, unknown>, input: SpotTheFlawInput, prompt: string): SpotTheFlawActivity {
  if (!Array.isArray(raw.flawedSteps)) failValidation('模型伪解答缺少 flawedSteps。');
  const flawedSteps: SpotTheFlawStep[] = [];
  for (const item of raw.flawedSteps) {
    const statement = isRecord(item) ? text(item.statement, 2_000) : '';
    if (!statement) failValidation('模型伪解答包含空步骤或结构损坏的步骤。');
    flawedSteps.push({ stepNumber: flawedSteps.length + 1, statement });
  }
  if (flawedSteps.length < 2) failValidation('模型伪解答步骤不足两步。');
  if (flawedSteps.length > 8) failValidation('模型伪解答步骤超出 8 步上限。');
  if (!isRecord(raw.checkpoint)) failValidation('模型伪解答缺少 checkpoint 诊断。');
  const flawedStepNumber = raw.checkpoint.flawedStepNumber;
  if (!Number.isInteger(flawedStepNumber) || (flawedStepNumber as number) < 1 || (flawedStepNumber as number) > flawedSteps.length) {
    failValidation('模型检查点 flawedStepNumber 未指向伪解答中真实存在的步骤。');
  }
  const divergencePoint = text(raw.checkpoint.divergencePoint, 1_000);
  const hiddenTrapReason = text(raw.checkpoint.hiddenTrapReason, 1_000);
  const correctionDirection = text(raw.checkpoint.correctionDirection, 1_000);
  const plausibleConclusion = text(raw.plausibleConclusion, 2_000);
  const title = text(raw.title, 240);
  if (!divergencePoint || !hiddenTrapReason || !correctionDirection || !plausibleConclusion || !title) {
    failValidation('模型伪解答的关键诊断字段不完整。');
  }
  return {
    kind: 'spot_the_flaw',
    title,
    prompt,
    flawedSteps,
    plausibleConclusion,
    checkpoint: { flawedStepNumber: flawedStepNumber as number, divergencePoint, hiddenTrapReason, correctionDirection },
    ...(input.errorStage?.trim() ? { targetErrorStage: input.errorStage.trim() } : {}),
    ...(input.conceptId?.trim() ? { conceptId: input.conceptId.trim() } : {}),
    ...(input.questionId?.trim() ? { questionId: input.questionId.trim() } : {}),
    sourceIds: whitelistedIds(raw.sourceIds, new Set(input.sourceIds ?? [])),
  };
}

function sanitizeMasteryBridge(
  raw: Record<string, unknown>,
  input: MasteryBridgeInput,
  targetTitle: string,
  qualifiedAnchors: readonly MasteryBridgeAnchor[],
): MasteryBridgeAnalogy {
  const rawAnchorId = text(raw.anchorId, 200).trim();
  const anchor = rawAnchorId
    ? qualifiedAnchors.find(candidate => candidate.id.trim() === rawAnchorId)
    : qualifiedAnchors.length === 1 ? qualifiedAnchors[0] : undefined;
  if (!anchor) failValidation('模型 anchorId 不在已彻底掌握（掌握度 ≥ 0.8）的旧稳锚点白名单内。');
  if (!Array.isArray(raw.structuralMappings)) failValidation('模型桥接缺少 structuralMappings。');
  const structuralMappings: MasteryBridgeMapping[] = [];
  for (const item of raw.structuralMappings) {
    if (!isRecord(item)) continue;
    const anchorElement = text(item.anchorElement, 400);
    const targetElement = text(item.targetElement, 400);
    const whyItMaps = text(item.whyItMaps, 600);
    if (!anchorElement || !targetElement || !whyItMaps) continue;
    structuralMappings.push({ anchorElement, targetElement, whyItMaps });
    if (structuralMappings.length >= 6) break;
  }
  if (structuralMappings.length < 2) failValidation('模型桥接的有效结构映射不足两组。');
  const analogyLimits = Array.isArray(raw.analogyLimits)
    ? [...new Set(raw.analogyLimits.map(limit => text(limit, 400)).filter(Boolean))].slice(0, 6)
    : [];
  if (!analogyLimits.length) failValidation('模型桥接缺少类比边界 analogyLimits。');
  const headline = text(raw.headline, 240);
  const bridgeExplanation = text(raw.bridgeExplanation, 4_000);
  const quickCheckPrompt = text(raw.quickCheckPrompt, 600);
  if (!headline || !bridgeExplanation || !quickCheckPrompt) failValidation('模型桥接的 headline、bridgeExplanation 或 quickCheckPrompt 不完整。');
  const finalizedAnchor = anchor as MasteryBridgeAnchor;
  return {
    kind: 'mastery_bridge',
    targetConceptTitle: targetTitle,
    ...(input.targetConceptId?.trim() ? { targetConceptId: input.targetConceptId.trim() } : {}),
    anchorId: finalizedAnchor.id,
    anchorTitle: finalizedAnchor.title.trim(),
    headline,
    bridgeExplanation,
    structuralMappings,
    analogyLimits,
    quickCheckPrompt,
    sourceIds: [finalizedAnchor.id],
  };
}

function usageOf(completion: {
  readonly model: string;
  readonly reportedModel?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}, durationMs: number): AdversarialUsage {
  return {
    model: completion.model,
    ...(completion.reportedModel ? { reportedModel: completion.reportedModel } : {}),
    ...(completion.inputTokens !== undefined ? { inputTokens: completion.inputTokens } : {}),
    ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {}),
    durationMs,
  };
}

export async function generateSpotTheFlawActivity(
  input: SpotTheFlawInput,
  options: AdversarialActivityOptions = {},
): Promise<SpotTheFlawResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new AuthoringError('invalid_input', '挑隐藏漏洞活动需要非空原题题干。');
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: buildSpotTheFlawSystemPrompt() },
      { role: 'user', content: `请为以下题目与学习者错因构造「给伪解答挑隐藏漏洞」活动。上下文：\n${JSON.stringify(input)}` },
    ], {
      requestPrefix: 'spot-the-flaw',
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = extractJsonObject(completion.content);
    if (!parsed) throw new AuthoringError('model_failed', '模型伪解答回复不是合法 JSON 对象。');
    return {
      activity: sanitizeSpotTheFlaw(parsed, input, prompt),
      usage: usageOf(completion, Math.max(0, now().getTime() - startedAt)),
    };
  } catch (error) {
    throw mapTeachingErrorToAuthoringError(error);
  }
}

export async function generateMasteryBridgeAnalogy(
  input: MasteryBridgeInput,
  options: AdversarialActivityOptions = {},
): Promise<MasteryBridgeResult> {
  const targetTitle = input.targetConceptTitle?.trim();
  if (!targetTitle) throw new AuthoringError('invalid_input', '旧稳桥接类比需要非空目标概念标题。');
  const masteredAnchors = Array.isArray(input.masteredAnchors) ? input.masteredAnchors : [];
  const qualifiedAnchors = masteredAnchors.filter(anchor =>
    Number.isFinite(anchor.mastery) && anchor.mastery >= 0.8 && !!anchor.id?.trim() && !!anchor.title?.trim());
  if (qualifiedAnchors.length === 0) {
    throw new AuthoringError('invalid_input', '缺少已彻底掌握（掌握度 ≥ 0.8）的旧稳锚点，无法生成个性化桥接类比。');
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: buildMasteryBridgeSystemPrompt() },
      { role: 'user', content: `请为学习目标概念「${targetTitle}」从已彻底掌握的旧稳锚点中选择其一搭建个性化类比桥。上下文：\n${JSON.stringify({ ...input, masteredAnchors: qualifiedAnchors })}` },
    ], {
      requestPrefix: 'mastery-bridge',
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = extractJsonObject(completion.content);
    if (!parsed) throw new AuthoringError('model_failed', '模型桥接类比回复不是合法 JSON 对象。');
    return {
      analogy: sanitizeMasteryBridge(parsed, input, targetTitle, qualifiedAnchors),
      usage: usageOf(completion, Math.max(0, now().getTime() - startedAt)),
    };
  } catch (error) {
    throw mapTeachingErrorToAuthoringError(error);
  }
}
