import {
  invokeBackgroundCompletion,
  mapTeachingErrorToAuthoringError,
  resolveBackgroundProvider,
  AuthoringError,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';

export type AuthoringConceptSummary = {
  readonly id: string;
  readonly rev?: number;
  readonly title: string;
  readonly summary?: string | null;
  readonly subject?: string | null;
};
export type AuthoringMasterySummary = {
  readonly level: string;
  readonly score?: number | null;
  readonly retrievability?: number | null;
  readonly evidenceCount?: number;
  readonly forgettingTrend?: string | null;
};
export type AuthoringMistakeSignal = {
  readonly attemptId?: string;
  readonly paperId?: string;
  readonly paperTitle?: string;
  readonly itemId?: string;
  readonly questionId?: string;
  readonly questionPrompt?: string;
  readonly verdict?: string;
  readonly errorStage?: string | null;
  readonly errorStageLabel?: string | null;
  readonly summary: string;
  readonly learnerAnswer?: string | null;
  readonly occurredAt?: string | null;
};
export type AuthoringSourceSnippet = {
  readonly id: string;
  readonly rev?: number;
  readonly kind?: string;
  readonly title: string;
  readonly excerpt: string;
  readonly originLabel?: string | null;
};
export type AuthoringSourceQuestion = {
  readonly id: string;
  readonly rev?: number;
  readonly prompt: string;
  readonly answer?: string | null;
  readonly explanation?: string | null;
  readonly conceptIds?: readonly string[];
  readonly attemptId?: string;
  readonly itemId?: string;
  readonly learnerAnswer?: string | null;
  readonly verdict?: string | null;
  readonly errorStage?: string | null;
  readonly errorStageLabel?: string | null;
  readonly mistakeSummary?: string | null;
};
export type AuthoringStickingPointSignal = string | {
  readonly kind?: string;
  readonly id?: string;
  readonly title: string;
  readonly excerpt: string;
  readonly errorStage?: string | null;
  readonly errorStageLabel?: string | null;
  readonly occurredAt?: string | null;
};
export type ConceptAuthoringContext = {
  readonly mode?: 'full' | 'cheatsheet' | 'concept_gap' | 'mistake_variant';
  readonly hasSufficientBasis?: boolean;
  readonly emptyReason?: string | null;
  readonly topic: string;
  readonly concept?: AuthoringConceptSummary | null;
  readonly mastery?: AuthoringMasterySummary | null;
  readonly relatedConcepts?: readonly { readonly id: string; readonly title: string; readonly relation?: string }[];
  readonly mistakes?: readonly AuthoringMistakeSignal[];
  readonly stickingPoints?: readonly AuthoringStickingPointSignal[];
  readonly sourceSnippets?: readonly AuthoringSourceSnippet[];
  readonly existingTextbookPages?: readonly { readonly id: string; readonly rev?: number; readonly title: string; readonly excerpt?: string }[];
  readonly existingQuestionPrompts?: readonly string[];
  readonly sourceQuestion?: AuthoringSourceQuestion | null;
  readonly witnessFactIds?: readonly string[];
};
export type TextbookAuthorMode = 'full' | 'cheatsheet';
export type AuthoredTextbookSection = {
  readonly heading: string;
  readonly kind: 'overview' | 'explanation' | 'formula' | 'pitfall' | 'example' | 'checklist' | 'summary';
  readonly body: string;
  readonly latex?: string;
  readonly bullets?: readonly string[];
  readonly table?: readonly (readonly string[])[];
  readonly sourceIds?: readonly string[];
};
export type AuthoredTextbookDraft = {
  readonly mode: TextbookAuthorMode;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly sections: readonly AuthoredTextbookSection[];
  readonly sourceIds: readonly string[];
};
export type TextbookAuthorOptions = {
  readonly mode?: TextbookAuthorMode;
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
};
export type TextbookAuthorResult = {
  readonly draft: AuthoredTextbookDraft;
  readonly usage: {
    readonly model: string;
    readonly reportedModel?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs: number;
  };
};

const sectionKinds = new Set(['overview', 'explanation', 'formula', 'pitfall', 'example', 'checklist', 'summary']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

function validIds(raw: unknown, allowed: ReadonlySet<string>): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && allowed.has(id.trim())).map(id => id.trim()))].slice(0, 16) : [];
}

function buildSystemPrompt(mode: TextbookAuthorMode): string {
  return [
    '你是学习者的私人教材作者。只依据提供的个人学情与来源，创作准确、原创、能直接阅读的中文教材；不得套固定模板、编造事实或引用未提供的来源 ID。',
    mode === 'full'
      ? '写完整精讲：概念直觉与边界、核心公式或步骤、结合本人错因的易错对比、带解析的典型例题和总结。不同小节必须有实质且互补的内容。'
      : '写高密度考前速查页：核心结论、关键公式、可快速判别的速查表、考场检查清单。简洁但不能只剩标题或空泛口号。',
    '仅输出 JSON：{"title":string,"summary":string,"tags":[string],"sections":[{"heading":string,"kind":"overview"|"explanation"|"formula"|"pitfall"|"example"|"checklist"|"summary","body":string,"latex":string,"bullets":[string],"table":[[string]],"sourceIds":[string]}],"sourceIds":[string]}。至少两个实质 sections。',
  ].join('\n');
}

function sanitizeDraft(raw: Record<string, unknown>, context: ConceptAuthoringContext, mode: TextbookAuthorMode): AuthoredTextbookDraft {
  const allowedSources = new Set([
    ...(context.sourceSnippets?.map(source => source.id) ?? []),
    ...(context.concept ? [context.concept.id] : []),
    ...(context.witnessFactIds ?? []),
  ]);
  if (!Array.isArray(raw.sections)) throw new AuthoringError('model_failed', '模型教材缺少 sections。');
  const sections: AuthoredTextbookSection[] = [];
  for (const item of raw.sections) {
    if (!isRecord(item)) continue;
    const heading = text(item.heading, 160);
    const body = text(item.body, 12_000);
    const kind = typeof item.kind === 'string' && sectionKinds.has(item.kind) ? item.kind as AuthoredTextbookSection['kind'] : null;
    if (!heading || body.length < 8 || !kind) continue;
    const latex = text(item.latex, 4_000);
    const bullets = Array.isArray(item.bullets) ? item.bullets.map(value => text(value, 500)).filter(Boolean).slice(0, 12) : [];
    const table = Array.isArray(item.table)
      ? item.table.filter(Array.isArray).map(row => row.map(value => text(value, 500)).slice(0, 6)).filter(row => row.some(Boolean)).slice(0, 12)
      : [];
    const sourceIds = validIds(item.sourceIds, allowedSources);
    sections.push({ heading, kind, body, ...(latex ? { latex } : {}), ...(bullets.length ? { bullets } : {}),
      ...(table.length ? { table } : {}), ...(sourceIds.length ? { sourceIds } : {}) });
  }
  const title = text(raw.title, 240);
  const summary = text(raw.summary, 600);
  if (!title || !summary || sections.length < 2) throw new AuthoringError('model_failed', '模型教材结构不完整或实质小节不足。');
  const tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.map(value => text(value, 40)).filter(Boolean))].slice(0, 12) : [];
  return { mode, title, summary, tags, sections, sourceIds: validIds(raw.sourceIds, allowedSources) };
}

export async function authorTextbookWithModel(
  context: ConceptAuthoringContext,
  options: TextbookAuthorOptions = {},
): Promise<TextbookAuthorResult> {
  if (!context.topic?.trim()) throw new AuthoringError('invalid_input', '教材生成需要非空主题。');
  const mode = options.mode ?? (context.mode === 'cheatsheet' ? 'cheatsheet' : 'full');
  const startedAt = Date.now();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: buildSystemPrompt(mode) },
      { role: 'user', content: `请围绕「${context.topic.trim()}」生成${mode === 'full' ? '完整教材' : '考前速查页'}。上下文：\n${JSON.stringify(context)}` },
    ], {
      requestPrefix: 'textbook-author',
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = extractJsonObject(completion.content);
    if (!parsed) throw new AuthoringError('model_failed', '模型教材回复不是合法 JSON 对象。');
    return { draft: sanitizeDraft(parsed, context, mode), usage: {
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
