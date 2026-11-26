import {
  invokeBackgroundCompletion,
  mapTeachingErrorToAuthoringError,
  resolveBackgroundProvider,
  AuthoringError,
  type BackgroundLlmProvider,
  type BackgroundLlmTransport,
} from './background-llm.ts';
import { extractJsonObject } from './onboarding-agent.ts';

export type QuestionMetaGardenGap =
  | 'missing_target_skill'
  | 'missing_discriminator'
  | 'missing_hint_ladder'
  | 'missing_time_calibration';

export type QuestionMetaGardenInput = {
  readonly questionId: string;
  readonly title?: string;
  readonly prompt: string;
  readonly answer?: string | null;
  readonly explanation?: string | null;
  readonly conceptIds?: readonly string[];
  readonly conceptTitles?: readonly string[];
  readonly recentMistakes?: readonly { readonly errorStage?: string | null; readonly summary: string }[];
  readonly gaps?: readonly QuestionMetaGardenGap[];
  readonly lockedStickyFields?: readonly string[];
  readonly sourceRef?: string;
};

export type QuestionMetaGardenTag =
  | { readonly kind: 'target_skill' | 'prerequisite' | 'optional_method'; readonly label: string; readonly detail?: string; readonly conceptId?: string }
  | { readonly kind: 'discriminator'; readonly label: string; readonly term: string; readonly scope: string; readonly change: string; readonly before: string; readonly after: readonly [string, string] };

export type QuestionMetaGardenHintLadder = {
  readonly l1: string;
  readonly l2: string;
  readonly l3: string;
  readonly worked_example?: string;
  readonly source_ref: string;
};

export type QuestionMetaGardenSolution = {
  readonly method: string;
  readonly explanation: string;
  readonly steps?: readonly string[];
  readonly hints?: readonly string[];
  readonly discriminator?: string;
  readonly source_ref: string;
};

export type QuestionMetaGardenDraft = {
  readonly questionId: string;
  readonly tags: readonly QuestionMetaGardenTag[];
  readonly hint_ladder?: QuestionMetaGardenHintLadder;
  readonly solutions: readonly QuestionMetaGardenSolution[];
  readonly estimatedMinutes?: number;
  readonly rationale: string;
};

export type QuestionMetaGardenOptions = {
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
};

export type QuestionMetaGardenResult = {
  readonly draft: QuestionMetaGardenDraft;
  readonly usage: {
    readonly model: string;
    readonly reportedModel?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs: number;
  };
};

const tagKinds = ['target_skill', 'prerequisite', 'optional_method', 'discriminator'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const cleanText = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';
const hasLineBreak = (value: string): boolean => /[\r\n\u2028\u2029]/u.test(value);

function gardenSystemPrompt(): string {
  return [
    '你是学习者题库的活外衣园艺师：只为既有题目补齐语义标签、三阶提示、等价解法与时间校准建议；绝不修改题干、答案或用户手工确认的字段，绝不编造来源。',
    '严格依据给出的题干、答案、概念与近期错因产出原创教研内容；若证据不足，相应字段宁可省略也不得硬编。',
    '语义标签最多四类：target_skill（本题考查目标）、prerequisite（先修）、optional_method（可选解法）、discriminator（最小条件辨别）。discriminator 必须给出改变后两种明确分离的预测 after[0] 与 after[1]，且二者绝不能相同。',
    'hint_ladder：l1 只给方向、单行且不超过 25 字；l2 给关键第一步（<=1600 字）；l3 给完整思路与参考解（<=4000 字）；worked_example 可选、只给局部示范（<=1600 字）。',
    'solutions 最多 8 条：method<=160 字，explanation<=4000 字，steps 最多 16 步、hints 最多 3 条，均可省略；不要重复已有解法。',
    'estimatedMinutes 仅在证据足以校准时间时给出正数分钟估计；rationale 用一句中文说明本次补齐了哪些缺口。',
    '仅输出 JSON：{"tags":[{"kind":"target_skill"|"prerequisite"|"optional_method"|"discriminator","label":string,"detail":string,"conceptId":string,"term":string,"scope":string,"change":string,"before":string,"after":[string,string]}],"hint_ladder":{"l1":string,"l2":string,"l3":string,"worked_example":string,"source_ref":string},"solutions":[{"method":string,"explanation":string,"steps":[string],"hints":[string],"discriminator":string,"source_ref":string}],"estimatedMinutes":number,"rationale":string}。省略不适用的键；除 rationale 外全部字段均可为空对象或空数组。',
  ].join('\n');
}

function sanitizeTags(raw: unknown, locked: ReadonlySet<string>, concepts: ReadonlySet<string>): QuestionMetaGardenTag[] {
  if (!Array.isArray(raw)) return [];
  const tags: QuestionMetaGardenTag[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || tags.length >= 16) continue;
    const kind = typeof entry.kind === 'string' && (tagKinds as readonly string[]).includes(entry.kind)
      ? entry.kind as (typeof tagKinds)[number]
      : null;
    if (!kind || locked.has(kind) || locked.has('tags')) continue;
    const label = cleanText(entry.label, 64) || cleanText(entry.term, 64);
    if (!label) continue;
    const key = JSON.stringify([kind, label.toLocaleLowerCase()]);
    if (seen.has(key)) continue;
    if (kind === 'discriminator') {
      const term = cleanText(entry.term, 64) || label;
      const scope = cleanText(entry.scope, 240);
      const change = cleanText(entry.change, 500);
      const before = cleanText(entry.before, 500);
      if (!term || !scope || !change || !before || !Array.isArray(entry.after) || entry.after.length !== 2) continue;
      const after0 = cleanText(entry.after[0], 500);
      const after1 = cleanText(entry.after[1], 500);
      if (!after0 || !after1 || after0 === after1) continue;
      seen.add(key);
      tags.push({ kind, label, term, scope, change, before, after: [after0, after1] });
      continue;
    }
    const detail = cleanText(entry.detail, 240);
    const conceptId = cleanText(entry.conceptId, 256);
    seen.add(key);
    tags.push({
      kind, label,
      ...(detail ? { detail } : {}),
      ...(conceptId && concepts.has(conceptId) ? { conceptId } : {}),
    });
  }
  return tags;
}

function sanitizeHintLadder(raw: unknown, sourceRef: string, locked: ReadonlySet<string>): QuestionMetaGardenHintLadder | undefined {
  if (locked.has('hint_ladder') || !isRecord(raw)) return undefined;
  const l1 = cleanText(raw.l1, 25);
  const l2 = cleanText(raw.l2, 1600);
  const l3 = cleanText(raw.l3, 4000);
  if (!l1 || !l2 || !l3 || hasLineBreak(l1)) return undefined;
  const worked = raw.worked_example === undefined ? undefined : cleanText(raw.worked_example, 1600);
  return {
    l1, l2, l3,
    ...(worked ? { worked_example: worked } : {}),
    source_ref: cleanText(raw.source_ref, 4096) || sourceRef,
  };
}

function sanitizeSolutions(raw: unknown, sourceRef: string, locked: ReadonlySet<string>): QuestionMetaGardenSolution[] {
  if (locked.has('solutions') || !Array.isArray(raw)) return [];
  const solutions: QuestionMetaGardenSolution[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || solutions.length >= 8) continue;
    const method = cleanText(entry.method, 160);
    const explanation = cleanText(entry.explanation, 4000);
    if (!method || !explanation || seen.has(method.toLocaleLowerCase())) continue;
    seen.add(method.toLocaleLowerCase());
    const steps = Array.isArray(entry.steps)
      ? entry.steps.map(step => cleanText(step, 1600)).filter(Boolean).slice(0, 16) : [];
    const hints = Array.isArray(entry.hints)
      ? entry.hints.map(hint => cleanText(hint, 1600)).filter(Boolean).slice(0, 3) : [];
    const discriminator = cleanText(entry.discriminator, 4000);
    solutions.push({
      method, explanation,
      ...(steps.length ? { steps } : {}),
      ...(hints.length ? { hints } : {}),
      ...(discriminator ? { discriminator } : {}),
      source_ref: cleanText(entry.source_ref, 4096) || sourceRef,
    });
  }
  return solutions;
}

function sanitizeEstimatedMinutes(raw: unknown, locked: ReadonlySet<string>): number | undefined {
  if (locked.has('estimatedMinutes') || locked.has('time_calibration')) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 240) return undefined;
  return Math.round(raw * 10) / 10;
}

function sanitizeGardenDraft(
  raw: Record<string, unknown>,
  input: QuestionMetaGardenInput,
): QuestionMetaGardenDraft | null {
  const locked = new Set(input.lockedStickyFields ?? []);
  const concepts = new Set(input.conceptIds ?? []);
  const sourceRef = input.sourceRef?.trim() || `question:${input.questionId}`;
  const tags = sanitizeTags(raw.tags, locked, concepts);
  const ladder = sanitizeHintLadder(raw.hint_ladder, sourceRef, locked);
  const solutions = sanitizeSolutions(raw.solutions, sourceRef, locked);
  const estimatedMinutes = sanitizeEstimatedMinutes(raw.estimatedMinutes, locked);
  const rationale = cleanText(raw.rationale, 800);
  if (!tags.length && !ladder && !solutions.length && estimatedMinutes === undefined) return null;
  return {
    questionId: input.questionId,
    tags,
    ...(ladder ? { hint_ladder: ladder } : {}),
    solutions,
    ...(estimatedMinutes !== undefined ? { estimatedMinutes } : {}),
    rationale: rationale || '根据题干、答案与近期错因补齐活外衣元信息。',
  };
}

/** Garden semantic tags, hint ladders, solutions and time calibration for one existing question. */
export async function gardenQuestionMetadataWithModel(
  input: QuestionMetaGardenInput,
  options: QuestionMetaGardenOptions = {},
): Promise<QuestionMetaGardenResult> {
  if (!input.questionId?.trim()) throw new AuthoringError('invalid_input', '题目园艺需要非空 questionId。');
  if (!input.prompt?.trim()) throw new AuthoringError('invalid_input', '题目园艺需要非空题干。');
  const startedAt = Date.now();
  try {
    resolveBackgroundProvider(options.provider);
    const completion = await invokeBackgroundCompletion(options.provider, [
      { role: 'system', content: gardenSystemPrompt() },
      { role: 'user', content: `请为下列既有题目补齐活外衣元信息。输入：\n${JSON.stringify(input)}` },
    ], {
      requestPrefix: 'question-meta-garden',
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = extractJsonObject(completion.content);
    if (!parsed) throw new AuthoringError('model_failed', '模型园艺回复不是合法 JSON 对象。');
    const draft = sanitizeGardenDraft(parsed, input);
    if (!draft) throw new AuthoringError('model_failed', '模型园艺回复未产出任何有效元信息。');
    return { draft, usage: {
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
