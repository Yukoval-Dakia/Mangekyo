import {
  invokeBackgroundCompletion,
  mapTeachingErrorToAuthoringError,
  resolveBackgroundProvider,
  AuthoringError,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';
import {
  verifyAuthoredQuestionDraft,
  type AuthoredQuestionVerification,
  type PythonCheckVerifier,
} from './question-verifier.ts';
import type { ConceptAuthoringContext } from './textbook-author.ts';
import {
  sanitizeAssessmentContract,
  sanitizeResponseSchema,
  submittedInputIds,
  validateInteractiveArtifactV1,
  type InteractiveArtifactV1,
} from './interactive-artifact.ts';

export type { AuthoredQuestionVerification, PythonCheckVerifier } from './question-verifier.ts';
export type { InteractiveArtifactV1 } from './interactive-artifact.ts';
export type QuestionAuthorMode = 'concept_gap' | 'mistake_variant';
export type QuestionAuthorFormat = 'text' | 'interactive' | 'auto';
export type QuestionDifficulty = 'foundation' | 'standard' | 'challenge';
export type AuthoredQuestionVariantRelation =
  | 'single_condition'
  | 'representation_transfer'
  | 'numbers_only'
  | 'confusable';
export type AuthoredQuestionSpoilsNext = 'none' | 'former' | 'latter' | 'unknown';
export type AuthoredQuestionVariant = {
  readonly relation: AuthoredQuestionVariantRelation;
  readonly preserved: readonly string[];
  readonly changed: readonly string[];
  readonly spoilsNext: AuthoredQuestionSpoilsNext;
};
export type AuthoredQuestionDiscriminator = {
  readonly term: string;
  readonly scope: string;
  readonly change: string;
  readonly before: string;
  readonly after: readonly [string, string];
};
export type AuthoredQuestionDraft = {
  readonly mode: QuestionAuthorMode;
  readonly title: string;
  readonly prompt: string;
  readonly answer: string;
  readonly explanation: string;
  readonly rubric: readonly string[];
  readonly hints: readonly [string, string, string];
  readonly difficulty: QuestionDifficulty;
  readonly conceptIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly sourceQuestionId?: string;
  readonly errorStage?: string;
  readonly mistakeReason?: string;
  readonly variantRationale?: string;
  readonly variant?: AuthoredQuestionVariant;
  readonly discriminator?: AuthoredQuestionDiscriminator;
  readonly pythonCheck?: string;
  readonly format?: 'text' | 'interactive';
  readonly interaction?: InteractiveArtifactV1;
  readonly response_schema?: readonly Record<string, unknown>[];
  readonly assessment_contract?: readonly Record<string, unknown>[];
  readonly verification: AuthoredQuestionVerification;
};
export type QuestionAuthorOptions = {
  readonly mode: QuestionAuthorMode;
  readonly count?: number;
  readonly format?: QuestionAuthorFormat;
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
  readonly verify?: boolean;
  readonly pythonVerifier?: PythonCheckVerifier;
  readonly validateInteraction?: (artifact: unknown) => { readonly ok: true } | { readonly ok: false; readonly error: string };
};
export type QuestionAuthorResult = {
  readonly questions: readonly AuthoredQuestionDraft[];
  readonly usage: {
    readonly model: string;
    readonly reportedModel?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs: number;
  };
};

type SanitizedQuestionCandidate = Omit<AuthoredQuestionDraft, 'verification'>;

const variantRelations = new Set<AuthoredQuestionVariantRelation>([
  'single_condition',
  'representation_transfer',
  'numbers_only',
  'confusable',
]);
const spoilsNextValues = new Set<AuthoredQuestionSpoilsNext>(['none', 'former', 'latter', 'unknown']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';
const normalizedPrompt = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const allowedValues = (raw: unknown, allowed: ReadonlySet<string>): string[] =>
  Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && allowed.has(id.trim())).map(id => id.trim()))].slice(0, 12) : [];
const stringList = (raw: unknown, limit: number): string[] =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((item): item is string => typeof item === 'string').map(item => item.trim().slice(0, limit)).filter(Boolean))]
    : [];

function sanitizeVariant(raw: unknown): AuthoredQuestionVariant | undefined {
  if (!isRecord(raw)) return undefined;
  const relation = typeof raw.relation === 'string' && variantRelations.has(raw.relation as AuthoredQuestionVariantRelation)
    ? raw.relation as AuthoredQuestionVariantRelation
    : null;
  const preserved = stringList(raw.preserved, 240).slice(0, 12);
  const changed = stringList(raw.changed, 240).slice(0, 12);
  if (!relation || !preserved.length || !changed.length) return undefined;
  const preservedKeys = new Set(preserved.map(item => item.toLocaleLowerCase()));
  if (changed.some(item => preservedKeys.has(item.toLocaleLowerCase()))) return undefined;
  if (relation === 'single_condition' && changed.length !== 1) return undefined;
  let spoilsNext: AuthoredQuestionSpoilsNext;
  if (raw.spoilsNext === undefined || raw.spoilsNext === null || (typeof raw.spoilsNext === 'string' && !raw.spoilsNext.trim())) {
    spoilsNext = 'unknown';
  } else if (typeof raw.spoilsNext === 'string' && spoilsNextValues.has(raw.spoilsNext as AuthoredQuestionSpoilsNext)) {
    spoilsNext = raw.spoilsNext as AuthoredQuestionSpoilsNext;
  } else {
    return undefined;
  }
  return { relation, preserved, changed, spoilsNext };
}

function sanitizeDiscriminator(raw: unknown): AuthoredQuestionDiscriminator | undefined {
  if (!isRecord(raw)) return undefined;
  const term = text(raw.term, 120);
  const scope = text(raw.scope, 240);
  const change = text(raw.change, 500);
  const before = text(raw.before, 500);
  if (!term || !scope || !change || !before || !Array.isArray(raw.after) || raw.after.length !== 2) return undefined;
  const after0 = text(raw.after[0], 500);
  const after1 = text(raw.after[1], 500);
  if (!after0 || !after1 || after0 === after1) return undefined;
  return { term, scope, change, before, after: [after0, after1] };
}

function sanitizePythonCheck(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.trim();
  return cleaned && cleaned.length <= 500 ? cleaned : undefined;
}

const interactiveCatalogInstructions = [
  '若生成 interaction，必须是完整 JSON 对象并满足以下硬契约：顶层 {version:1, id, revision, title, fallback, sections:[{id,title,layout:"stack"|"columns",nodes:[...]}]}；id/revision 均 /^[a-z][a-z0-9_-]*$/；所有 section、node、scene.objects、selection.items 的 id 全图唯一；sections 1..12 个，每个 nodes 1..32 个。',
  '交互题必须包含至少一个可作答节点（selection 或 range），以及一个 intent:"submit" 的 action，其 inputs 引用这些作答节点。range.values 严格递增且 2..128 项，initial 是合法下标；selection.selected 引用合法且不重复的 item id；curve.source 指向同长度 range；listen.lanes 指向等长 beats selection。',
  '三类优先教学形态：①文言断句 selection layout:"passage"（items 为字间位置）配 multi-scheme-best@1；②节奏/序列选择 selection layout:"beats"（可加 listen）配 multi-scheme-best@1；③参数滑块 range + curve/scene 配 range-constraint@1 或 numeric-equivalence@1。',
  '同时给出 response_schema（每项 {slotId,schemaVersion,fields:[{path,kind}]}，kind 为 numeric|text|attachment|trace|structured，slotId 与作答节点同名）与 assessment_contract（每项 {criterionId,inputs:[{slotId,path}],evaluator:{id,version},parameters,maximum,missingEvidence}，不得含 source；evaluator 仅可用 multi-scheme-best@1、range-constraint@1、numeric-equivalence@1、selection-constraint@1）。',
  'multi-scheme-best parameters:{schemes:[{schemeId?,match?:"all"|"proportional",weight?(0<weight<=1),answers:[...]}]} 1..16 组，answers 长度必须等于 inputs 长度，每项必须是 AssessmentAnswerValue：selection 节点优先用 {kind:"structured",value:{kind:"selection",ids:[string]}}（亦可 "breaks"），其余可用 {kind:"numeric",value:number,unit:string|null} 或 {kind:"text",value:string}；range-constraint（单输入）parameters 要么 {min,max,inclusiveMin?,inclusiveMax?} 要么 {target,tolerance}，另可带 unit、partialMargin；numeric-equivalence（单输入）parameters:{expected:number|合法小数或分数字符串,tolerance,unit?,acceptedUnits?}；这三类判定器的 maximum 须为正数。',
  'answer 必须是离开交互界面也能被独立盲解核对的清晰文本答案；解析不得泄露已包含在界面的全部提交线索。',
];

function systemPrompt(mode: QuestionAuthorMode, count: number, format: QuestionAuthorFormat): string {
  return [
    '你是学习者的私人命题教师。每道题必须真实原创、可作答、答案与解析自洽；不得套静态模板、编造来源或只复述输入。',
    mode === 'concept_gap'
      ? '针对概念缺口与错因设计有区分度的原创练习，结合掌握度、来源和卡点，并避开 existingQuestionPrompts 中已有题干。'
      : '严格围绕 sourceQuestion 的核心考点与易错点生成同构变式：换情境、数值或问法，但不能换考点，也不能照抄原题；解析要说明原错法为何在此仍值得警惕。必须诚实输出 variant（preserved 与 changed 非空且互不重叠；若 relation 为 single_condition 则 changed 恰好 1 项；spoilsNext 诚实评估为 "none"|"former"|"latter"|"unknown"，不能确定时必须填 "unknown"，严禁一律写 "none"），必要时附最小辨别对比 discriminator。',
    '若题型为可数值或逻辑验算的题目，可附一行纯 Python 验算表达式 pythonCheck（仅用基础算术、比较与 math/Fraction/Decimal，不含 import 或 lambda）。',
    ...(format === 'interactive'
      ? ['本批每道题都必须携带合法 interaction 以及 response_schema、assessment_contract；不允许退回纯文字题。', ...interactiveCatalogInstructions]
      : format === 'auto'
        ? ['若某题适合交互表达，可携带合法 interaction、response_schema、assessment_contract；否则省略这些字段按普通文字题输出。', ...interactiveCatalogInstructions]
        : []),
    `恰好生成 ${count} 道题。hints 恰好三条：L1 仅给方向、单行且不超过25字；L2 给关键第一步；L3 给完整思路。`,
    `仅输出 JSON：{"questions":[{"title":string,"prompt":string,"answer":string,"explanation":string,"rubric":[string],"hints":[string,string,string],"difficulty":"foundation"|"standard"|"challenge","conceptIds":[string],"sourceIds":[string],"errorStage":string,"mistakeReason":string,"variantRationale":string,"variant":{"relation":"single_condition"|"representation_transfer"|"numbers_only"|"confusable","preserved":[string],"changed":[string],"spoilsNext":"none"|"former"|"latter"|"unknown"},"discriminator":{"term":string,"scope":string,"change":string,"before":string,"after":[string,string]},"pythonCheck":string${format === 'text' ? '' : ',"interaction":object,"response_schema":[object],"assessment_contract":[object]'}}]}。`,
  ].join('\n');
}

function sanitizeInteractionPayload(
  item: Record<string, unknown>,
  validateInteraction?: QuestionAuthorOptions['validateInteraction'],
): { interaction: InteractiveArtifactV1; responseSchema: readonly Record<string, unknown>[]; assessmentContract: readonly Record<string, unknown>[] } | null {
  const checked = validateInteractiveArtifactV1(item.interaction);
  if (!checked.ok) return null;
  if (validateInteraction) {
    const host = validateInteraction(checked.view);
    if (!host.ok) return null;
  }
  const responseSchema = sanitizeResponseSchema(item.response_schema, submittedInputIds(checked.view));
  if (!responseSchema) return null;
  const assessmentContract = sanitizeAssessmentContract(item.assessment_contract, responseSchema);
  if (!assessmentContract) return null;
  return { interaction: checked.view, responseSchema, assessmentContract };
}

function sanitizeQuestions(raw: Record<string, unknown>, context: ConceptAuthoringContext,
  mode: QuestionAuthorMode, format: QuestionAuthorFormat,
  validateInteraction?: QuestionAuthorOptions['validateInteraction']): SanitizedQuestionCandidate[] {
  if (!Array.isArray(raw.questions)) throw new AuthoringError('model_failed', '模型出题回复缺少 questions。');
  const concepts = new Set([...(context.concept ? [context.concept.id] : []),
    ...(context.relatedConcepts?.map(concept => concept.id) ?? []), ...(context.sourceQuestion?.conceptIds ?? [])]);
  const sources = new Set([...(context.sourceSnippets?.map(source => source.id) ?? []),
    ...(context.concept ? [context.concept.id] : []), ...(context.sourceQuestion ? [context.sourceQuestion.id] : []),
    ...(context.witnessFactIds ?? [])]);
  const existing = new Set(context.existingQuestionPrompts?.map(normalizedPrompt) ?? []);
  const sourcePrompt = context.sourceQuestion?.prompt.trim();
  if (sourcePrompt) existing.add(normalizedPrompt(sourcePrompt));
  const drafts: SanitizedQuestionCandidate[] = [];
  for (const item of raw.questions) {
    if (!isRecord(item)) continue;
    const title = text(item.title, 240);
    const prompt = text(item.prompt, 8_000);
    const answer = text(item.answer, 4_000);
    const explanation = text(item.explanation, 8_000);
    const hints = Array.isArray(item.hints) && item.hints.length === 3
      ? item.hints.map(value => text(value, 1_600)) : [];
    if (!title || !prompt || !answer || !explanation || existing.has(normalizedPrompt(prompt)) ||
        hints.length !== 3 || hints.some(hint => !hint) ||
        /[\r\n\u2028\u2029]/u.test(hints[0]!) || [...hints[0]!].length > 25) continue;
    const difficulty = item.difficulty === 'foundation' || item.difficulty === 'challenge' ? item.difficulty : 'standard';
    const rubric = Array.isArray(item.rubric) ? item.rubric.map(value => text(value, 500)).filter(Boolean).slice(0, 12) : [];
    const errorStage = text(item.errorStage, 80) || context.sourceQuestion?.errorStage || undefined;
    const mistakeReason = text(item.mistakeReason, 500);
    const variantRationale = text(item.variantRationale, 800);
    const variant = sanitizeVariant(item.variant);
    const discriminator = sanitizeDiscriminator(item.discriminator);
    const pythonCheck = sanitizePythonCheck(item.pythonCheck);
    const interactionPayload = format === 'text' || item.interaction === undefined
      ? null
      : sanitizeInteractionPayload(item, validateInteraction);
    if (format === 'interactive' && !interactionPayload) continue;
    drafts.push({ mode, title, prompt, answer, explanation, rubric,
      hints: [hints[0]!, hints[1]!, hints[2]!], difficulty, conceptIds: allowedValues(item.conceptIds, concepts),
      sourceIds: allowedValues(item.sourceIds, sources),
      ...(context.sourceQuestion ? { sourceQuestionId: context.sourceQuestion.id } : {}),
      ...(errorStage ? { errorStage } : {}), ...(mistakeReason ? { mistakeReason } : {}),
      ...(variantRationale ? { variantRationale } : {}), ...(variant ? { variant } : {}),
      ...(discriminator ? { discriminator } : {}), ...(pythonCheck ? { pythonCheck } : {}),
      ...(interactionPayload
        ? { format: 'interactive' as const, interaction: interactionPayload.interaction,
            response_schema: interactionPayload.responseSchema, assessment_contract: interactionPayload.assessmentContract }
        : format === 'interactive' || format === 'auto'
          ? { format: 'text' as const }
          : {}) });
  }
  return drafts;
}

export async function authorQuestionsWithModel(
  context: ConceptAuthoringContext,
  options: QuestionAuthorOptions,
): Promise<QuestionAuthorResult> {
  if (options.mode === 'mistake_variant' && !context.sourceQuestion?.prompt?.trim()) {
    throw new AuthoringError('invalid_input', '错题同构变式需要非空原题题干。');
  }
  const count = Math.max(1, Math.min(3, Math.trunc(options.count ?? (options.mode === 'concept_gap' ? 2 : 1))));
  const format = options.format ?? 'text';
  const startedAt = Date.now();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: systemPrompt(options.mode, count, format) },
      { role: 'user', content: `请围绕「${context.topic.trim() || '当前错题'}」出题。上下文：\n${JSON.stringify(context)}` },
    ], {
      requestPrefix: 'question-author',
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = extractJsonObject(completion.content);
    if (!parsed) throw new AuthoringError('model_failed', '模型出题回复不是合法 JSON 对象。');
    const candidates = sanitizeQuestions(parsed, context, options.mode, format, options.validateInteraction).slice(0, count);
    if (!candidates.length) throw new AuthoringError('model_failed', '模型未返回通过校验的有效题目。');
    const verified = await Promise.all(candidates.map(async (candidate, index) => ({
      ...candidate,
      verification: await verifyAuthoredQuestionDraft(candidate, {
        ...(options.verify !== undefined ? { verify: options.verify } : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.requestId !== undefined ? { requestId: `${options.requestId}:${index}` } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.pythonVerifier ? { pythonVerifier: options.pythonVerifier } : {}),
      }),
    })));
    const requireVerified = options.verify !== false;
    const questions = verified.filter(question =>
      requireVerified ? question.verification.status === 'verified' : question.verification.status !== 'conflict',
    );
    if (!questions.length) throw new AuthoringError('model_failed', '模型生成的题目未能通过独立验算或存在答案冲突。');
    return { questions, usage: {
      model: completion.model,
      ...(completion.reportedModel ? { reportedModel: completion.reportedModel } : {}),
      ...(completion.inputTokens !== undefined ? { inputTokens: completion.inputTokens } : {}),
      ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {}),
      durationMs: Date.now() - startedAt,
    } };
  } catch (error) {
    throw mapTeachingErrorToAuthoringError(error);
  }
}
