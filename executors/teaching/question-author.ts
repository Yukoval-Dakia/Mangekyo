import {
  invokeBackgroundCompletion,
  mapTeachingErrorToAuthoringError,
  resolveBackgroundProvider,
  AuthoringError,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';
import type { ConceptAuthoringContext } from './textbook-author.ts';

export type QuestionAuthorMode = 'concept_gap' | 'mistake_variant';
export type QuestionDifficulty = 'foundation' | 'standard' | 'challenge';
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
};
export type QuestionAuthorOptions = {
  readonly mode: QuestionAuthorMode;
  readonly count?: number;
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';
const normalizedPrompt = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const allowedValues = (raw: unknown, allowed: ReadonlySet<string>): string[] =>
  Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && allowed.has(id.trim())).map(id => id.trim()))].slice(0, 12) : [];

function systemPrompt(mode: QuestionAuthorMode, count: number): string {
  return [
    '你是学习者的私人命题教师。每道题必须真实原创、可作答、答案与解析自洽；不得套静态模板、编造来源或只复述输入。',
    mode === 'concept_gap'
      ? '针对概念缺口与错因设计有区分度的原创练习，结合掌握度、来源和卡点，并避开 existingQuestionPrompts 中已有题干。'
      : '严格围绕 sourceQuestion 的核心考点与易错点生成同构变式：换情境、数值或问法，但不能换考点，也不能照抄原题；解析要说明原错法为何在此仍值得警惕。',
    `恰好生成 ${count} 道题。hints 恰好三条：L1 仅给方向、单行且不超过25字；L2 给关键第一步；L3 给完整思路。`,
    '仅输出 JSON：{"questions":[{"title":string,"prompt":string,"answer":string,"explanation":string,"rubric":[string],"hints":[string,string,string],"difficulty":"foundation"|"standard"|"challenge","conceptIds":[string],"sourceIds":[string],"errorStage":string,"mistakeReason":string,"variantRationale":string}]}。',
  ].join('\n');
}

function sanitizeQuestions(raw: Record<string, unknown>, context: ConceptAuthoringContext,
  mode: QuestionAuthorMode): AuthoredQuestionDraft[] {
  if (!Array.isArray(raw.questions)) throw new AuthoringError('model_failed', '模型出题回复缺少 questions。');
  const concepts = new Set([...(context.concept ? [context.concept.id] : []),
    ...(context.relatedConcepts?.map(concept => concept.id) ?? []), ...(context.sourceQuestion?.conceptIds ?? [])]);
  const sources = new Set([...(context.sourceSnippets?.map(source => source.id) ?? []),
    ...(context.concept ? [context.concept.id] : []), ...(context.sourceQuestion ? [context.sourceQuestion.id] : []),
    ...(context.witnessFactIds ?? [])]);
  const existing = new Set(context.existingQuestionPrompts?.map(normalizedPrompt) ?? []);
  const sourcePrompt = context.sourceQuestion?.prompt.trim();
  if (sourcePrompt) existing.add(normalizedPrompt(sourcePrompt));
  const drafts: AuthoredQuestionDraft[] = [];
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
    drafts.push({ mode, title, prompt, answer, explanation, rubric,
      hints: [hints[0]!, hints[1]!, hints[2]!], difficulty, conceptIds: allowedValues(item.conceptIds, concepts),
      sourceIds: allowedValues(item.sourceIds, sources),
      ...(context.sourceQuestion ? { sourceQuestionId: context.sourceQuestion.id } : {}),
      ...(errorStage ? { errorStage } : {}), ...(mistakeReason ? { mistakeReason } : {}),
      ...(variantRationale ? { variantRationale } : {}) });
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
  const startedAt = Date.now();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: systemPrompt(options.mode, count) },
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
    const questions = sanitizeQuestions(parsed, context, options.mode).slice(0, count);
    if (!questions.length) throw new AuthoringError('model_failed', '模型未返回通过校验的有效题目。');
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
