import { randomUUID } from 'node:crypto';
import {
  checkProviderOutcome,
  profileFor,
  providerEndpoint,
  providerIdentifier,
  providerProtocol,
  requestCompletion,
  TeachingError,
  type TeachingProvider,
} from './provider.ts';
import type { Completion, ProviderHooks } from './provider-stream.ts';
import type { ProviderSettings } from './provider-settings.ts';

export type OnboardingAgentErrorCode = 'model_unavailable' | 'timeout' | 'model_failed';

export class OnboardingAgentError extends Error {
  readonly code: OnboardingAgentErrorCode;

  constructor(code: OnboardingAgentErrorCode, message: string) {
    super(message);
    this.name = 'OnboardingAgentError';
    this.code = code;
  }
}

export type OnboardingQuickPrefs = {
  readonly stage?: string;
  readonly dailyMinutes?: number;
  readonly campaign?: 'steady' | 'sprint' | 'recovery';
  readonly teachingStyle?: string;
};

export type OnboardingAgentInput = {
  readonly profileText: string;
  readonly currentDate: string;
  readonly timeZone: string;
  readonly quickPrefs?: OnboardingQuickPrefs;
  readonly mode?: 'llm' | 'offline_manual';
};

export type OnboardingExamRecord = {
  subject: string;
  examName: string;
  status: 'completed' | 'upcoming' | 'exempt';
  confidence: 'high' | 'needs_confirm';
  reason: string;
};

export type OnboardingUpcomingExam = {
  id: string;
  title: string;
  date: string;
  dateCertainty: 'exact' | 'estimated';
  scope: string[];
  weights: { topic: string; weight: number }[];
  note: string;
};

export type OnboardingProposalDraft = {
  learnerSummary: {
    headline: string;
    stage: string;
    regionOrSchool: string;
    selectedSubjects: string[];
    inferredPeriod: string;
    dailyMinutes: number;
    teachingStyle: string;
  };
  examStatus: {
    completedExams: OnboardingExamRecord[];
    upcomingExams: OnboardingUpcomingExam[];
  };
  studyPlan: {
    goalText: string;
    campaign: 'steady' | 'sprint' | 'recovery';
    dailyWindow: { weekday: number | null; start: number; end: number; label: string };
    progressTopics: { topic: string; stage: 'current' | 'preview' }[];
    companionMemo: string;
    preferenceNotes: string[];
  };
  disciplines: {
    key: string;
    title: string;
    learningScope: string;
    mastery: string;
    assessment: string[];
    boundaries: string[];
  }[];
  knowledgeGraph: {
    concepts: {
      key: string;
      subject: string;
      title: string;
      summary: string;
      semesterTag: string;
      selected: boolean;
    }[];
    edges: {
      fromKey: string;
      toKey: string;
      kind: 'prereq_of' | 'related_to';
      rationale: string;
    }[];
  };
  starterQuestions: {
    key: string;
    subject: string;
    title: string;
    prompt: string;
    answer: string;
    rubric: string;
    conceptKeys: string[];
    difficulty: 'foundation' | 'core' | 'stretch';
    selected: boolean;
  }[];
  meta: {
    generatedAt: string;
    currentDate: string;
    timeZone: string;
    source: 'llm' | 'offline_manual';
    model?: string;
    honestyNote: string;
  };
};

export type OnboardingUsage = {
  readonly model: string;
  readonly reportedModel?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs: number;
};

export type OnboardingAgentResult = {
  readonly proposal: OnboardingProposalDraft;
  readonly usage: OnboardingUsage;
};

export type OnboardingTransport = (
  endpoint: string,
  body: string,
  apiKey: string | undefined,
  clientRequestId: string,
  hooks: ProviderHooks,
  provider: TeachingProvider,
) => Promise<Completion | { rejectedHttpStatus: number }>;

export type OnboardingAgentOptions = {
  readonly provider?: TeachingProvider | ProviderSettings | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly transport?: OnboardingTransport;
};

const defaultTimeoutMs = 90_000;
const defaultMaxTokens = 7_500;
const weekdaysZh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;
const weekdaysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeDate(currentDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(currentDate.trim());
  if (!match) return currentDate;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return `${currentDate}（${weekdaysZh[day]} / ${weekdaysEn[day]}）`;
}

function buildSystemPrompt(): string {
  return [
    '你是私人教研团的冷启动规划专家。你的任务是仅依据学习者的自然语言自我介绍、快捷偏好以及系统注入的精确当前日期与时区，为学习者一次性推演出高度贴合、诚实可核对的初始化配置方案。',
    '',
    '【通用性原则（严禁套用任何固定省市或固定学段模板）】',
    '- 必须完全根据学习者自述的自然语言与地区/学段/考试体系推理，自然适配任意学习者：国内各地新高考（如 3+3 / 7选3 / 3+1+2）、中考、大学本科/研究生专业课、考研（如 408/数学/英语）、语言考试（雅思/托福/GRE/JLPT）、竞赛或编程/工程自学等。',
    '- 若学习者没有提到特定地区或特定考试，绝不臆造未提及的地区考制或学校安排。',
    '',
    '【诚实不确定性原则（必须严格遵守）】',
    '1. 结合精确 currentDate 与星期，推断学习者当前所处的学期/备考阶段（写入 learnerSummary.inferredPeriod）。',
    '2. 在 examStatus.completedExams 中列出大概率已考、待考或免考的科目；凡非学习者明确声明已完成的推断项，confidence 必须设为 "needs_confirm"，并用 1 句中文 reason 说明推断依据并请学习者勾选核对。',
    '3. 在 examStatus.upcomingExams 中列出接下来最关键的考试节点；凡非学习者明确给出精确日期的考试，dateCertainty 必须设为 "estimated"，给出合理的约计 YYYY-MM-DD（晚于 currentDate），并在 note 说明系按常规考历估算；weights 中每项 topic 必须严格属于 scope，且所有 weight 之和 <= 100。',
    '4. meta.honestyNote 必须用 1–2 句诚实中文提醒学习者：哪些学期/已考科目/考试日期是结合当前日期推断的，建议核对后再一键配置。',
    '',
    '【高质量产出配额】',
    '- studyPlan：goalText 为清晰可执行的阶段目标；campaign 取 "steady"|"sprint"|"recovery"；dailyWindow 的 weekday 为 null（每天）或 0..6，start/end 为一天中的分钟数（0..1439，end > start）；progressTopics 为 3–6 个当前/预习主题；companionMemo 不超过 700 字，浓缩学习者身份、选科/方向、已考与待考状态、时间窗口与教学偏好。',
    '- disciplines：1–5 个核心学科/方向配置（key 用简短英文/拼音 slug，如 physics / chemistry / cs408）。',
    '- knowledgeGraph：10–15 个紧扣当前学期与核心科目的高信号知识点（selected 均设为 true，key 用唯一 slug），以及 8–14 条高质量关系边（kind 仅取 "prereq_of" 或 "related_to"，fromKey 与 toKey 均须存在于 concepts.key 且不自环）。',
    '- starterQuestions：6–8 道基础与诊断摸底题（selected 均设为 true，difficulty 取 "foundation"|"core"|"stretch"）；理科/数学/工程公式自然使用 $...$ LaTeX；每题包含明确标准答案 answer、可核对的评分要点 rubric，且 conceptKeys 引用上面 concepts 中的 key。',
    '',
    '【输出格式硬约束】',
    '只输出一个合法 JSON 对象，禁止在 JSON 外输出任何解释、标题或 Markdown 文本；所有反斜杠（如 LaTeX 的 \\frac）必须在 JSON 字符串内正确双转义。顶层键必须严格为：',
    '{"learnerSummary":{"headline":"","stage":"","regionOrSchool":"","selectedSubjects":[""],"inferredPeriod":"","dailyMinutes":45,"teachingStyle":""},"examStatus":{"completedExams":[{"subject":"","examName":"","status":"completed|upcoming|exempt","confidence":"high|needs_confirm","reason":""}],"upcomingExams":[{"id":"","title":"","date":"YYYY-MM-DD","dateCertainty":"exact|estimated","scope":[""],"weights":[{"topic":"","weight":30}],"note":""}]},"studyPlan":{"goalText":"","campaign":"steady|sprint|recovery","dailyWindow":{"weekday":null,"start":1260,"end":1305,"label":""},"progressTopics":[{"topic":"","stage":"current|preview"}],"companionMemo":"","preferenceNotes":[""]},"disciplines":[{"key":"","title":"","learningScope":"","mastery":"","assessment":[""],"boundaries":[""]}],"knowledgeGraph":{"concepts":[{"key":"","subject":"","title":"","summary":"","semesterTag":"","selected":true}],"edges":[{"fromKey":"","toKey":"","kind":"prereq_of|related_to","rationale":""}]},"starterQuestions":[{"key":"","subject":"","title":"","prompt":"","answer":"","rubric":"","conceptKeys":[""],"difficulty":"foundation|core|stretch","selected":true}],"meta":{"generatedAt":"","currentDate":"YYYY-MM-DD","timeZone":"","source":"llm","honestyNote":""}}',
  ].join('\n');
}

function buildUserPrompt(input: OnboardingAgentInput): string {
  const payload = {
    currentDate: input.currentDate,
    currentDateDetail: describeDate(input.currentDate),
    timeZone: input.timeZone,
    profileText: input.profileText.trim(),
    ...(input.quickPrefs ? { quickPrefs: input.quickPrefs } : {}),
  };
  return `请根据以下学习者信息与当前时间，生成完整的冷启动配置 JSON：\n${JSON.stringify(payload, null, 2)}`;
}

function buildRepairPrompt(rawOutput: string, reason: string, input: OnboardingAgentInput): string {
  const snippet = rawOutput.length > 12_000 ? rawOutput.slice(0, 12_000) : rawOutput;
  return [
    `上一次输出未能通过 JSON 校验（原因：${reason}）。`,
    '请仅返回一个完整、语法完全合法的 JSON 对象（不要输出任何 Markdown 围栏或额外说明）。若上次被截断，请适度精简每条 summary/rubric 文案以确保完整闭合，但仍需保留全部 7 个顶层字段（learnerSummary / examStatus / studyPlan / disciplines / knowledgeGraph / starterQuestions / meta）及 10–15 个知识点、6–8 道摸底题。',
    `当前日期：${describeDate(input.currentDate)}，时区：${input.timeZone}。`,
    snippet.trim() ? `上次残缺输出供修复参考：\n${snippet}` : '上次输出为空，请直接重新生成完整 JSON。',
  ].join('\n\n');
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!cleaned) return null;

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(cleaned);
  if (fenced?.[1]) {
    const fromFence = tryParse(fenced[1].trim());
    if (fromFence) return fromFence;
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const balanced = tryParse(cleaned.slice(start, i + 1));
        if (balanced) return balanced;
        start = -1;
      }
    }
  }
  return null;
}

function validateProposalShape(obj: Record<string, unknown>): string | null {
  if (!isRecord(obj.learnerSummary)) return '缺少 learnerSummary 对象';
  if (!isRecord(obj.examStatus)) return '缺少 examStatus 对象';
  if (!isRecord(obj.studyPlan)) return '缺少 studyPlan 对象';
  if (!Array.isArray(obj.disciplines)) return '缺少 disciplines 数组';
  if (!isRecord(obj.knowledgeGraph) || !Array.isArray(obj.knowledgeGraph.concepts) || !obj.knowledgeGraph.concepts.length)
    return '缺少非空的 knowledgeGraph.concepts 数组';
  if (!Array.isArray(obj.starterQuestions)) return '缺少 starterQuestions 数组';
  return null;
}

function finalizeProposal(
  raw: Record<string, unknown>,
  input: OnboardingAgentInput,
  model: string,
  generatedAt: string,
): OnboardingProposalDraft {
  const existingMeta = isRecord(raw.meta) ? raw.meta : {};
  const honestyNote = typeof existingMeta.honestyNote === 'string' && existingMeta.honestyNote.trim()
    ? existingMeta.honestyNote.trim()
    : `以上学期进度、已考/待考科目与考试日期基于 ${input.currentDate} 自动推断，标注“待确认”或“约计”的项目请核对后再一键配置。`;
  return {
    ...(raw as unknown as OnboardingProposalDraft),
    meta: {
      generatedAt,
      currentDate: input.currentDate,
      timeZone: input.timeZone,
      source: 'llm',
      model,
      honestyNote,
    },
  };
}

function mapProviderError(error: unknown): OnboardingAgentError {
  if (error instanceof OnboardingAgentError) return error;
  if (error instanceof TeachingError) {
    if (error.code === 'provider_timeout') return new OnboardingAgentError('timeout', error.message);
    if (error.code === 'provider_configuration' || error.code === 'provider_unavailable') {
      return new OnboardingAgentError('model_unavailable', error.message);
    }
    return new OnboardingAgentError('model_failed', error.message);
  }
  return new OnboardingAgentError('model_failed', error instanceof Error ? error.message : '冷启动推演调用失败。');
}

function withAttemptTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OnboardingAgentError('timeout', `冷启动推演超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请重试或切换更快的模型。`));
    }, timeoutMs);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function addTokens(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

export async function proposeOnboardingWithAgent(
  input: OnboardingAgentInput,
  options: OnboardingAgentOptions = {},
): Promise<OnboardingAgentResult> {
  if (!input.profileText || !input.profileText.trim()) {
    throw new OnboardingAgentError('model_failed', '请先输入你的学习背景与目标。');
  }
  const rawProvider = options.provider;
  if (!rawProvider || !rawProvider.baseUrl?.trim()) {
    throw new OnboardingAgentError('model_unavailable', '尚未配置可用的 AI 模型，请先前往设置配置模型或使用离线手动配置。');
  }

  let endpoint: string;
  let profile: { model: string; reasoningEffort: string };
  let provider: TeachingProvider;
  try {
    provider = {
      baseUrl: rawProvider.baseUrl,
      ...(rawProvider.apiKey ? { apiKey: rawProvider.apiKey } : {}),
      protocol: providerProtocol(rawProvider),
      ...(rawProvider.model ? { model: rawProvider.model } : {}),
      ...(rawProvider.reasoningEffort ? { reasoningEffort: rawProvider.reasoningEffort } : {}),
    };
    endpoint = providerEndpoint(provider);
    profile = profileFor(provider);
  } catch (error) {
    throw mapProviderError(error);
  }

  const maxTokens = Math.max(2048, Math.min(16_384, Math.trunc(options.maxTokens ?? defaultMaxTokens)));
  const timeoutMs = Math.max(50, Math.min(180_000, Math.trunc(options.timeoutMs ?? defaultTimeoutMs)));
  const transport = options.transport ?? requestCompletion;
  const baseRequestId = options.requestId?.replace(/[^!-~]/g, '').slice(0, 480) || `onboarding-${randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reportedModel: string | undefined;

  const invoke = async (messages: { role: 'system' | 'user' | 'assistant'; content: string }[], suffix: string) => {
    const body = JSON.stringify({
      model: profile.model,
      max_tokens: maxTokens,
      stream: true,
      ...(profile.reasoningEffort !== 'default' ? { reasoning_effort: profile.reasoningEffort } : {}),
      messages,
    });
    let result: Completion | { rejectedHttpStatus: number };
    try {
      result = await withAttemptTimeout(
        transport(endpoint, body, provider.apiKey, `${baseRequestId}-${suffix}`, {
          model(value) {
            const id = providerIdentifier(value, provider.apiKey);
            if (id) reportedModel = id;
          },
        }, provider),
        timeoutMs,
      );
    } catch (error) {
      throw mapProviderError(error);
    }
    if ('rejectedHttpStatus' in result) {
      try { checkProviderOutcome(result); } catch (error) { throw mapProviderError(error); }
    }
    const completion = result as Completion;
    const id = providerIdentifier(completion.model, provider.apiKey);
    if (id) reportedModel = id;
    inputTokens = addTokens(inputTokens, completion.usage?.prompt_tokens);
    outputTokens = addTokens(outputTokens, completion.usage?.completion_tokens);
    const truncated = 'truncated' in completion && completion.truncated === true;
    const content = 'content' in completion && typeof completion.content === 'string' ? completion.content : '';
    return { truncated, content };
  };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);
  const first = await invoke([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 'init');

  let parsed = !first.truncated ? extractJsonObject(first.content) : null;
  let shapeError = parsed ? validateProposalShape(parsed) : (first.truncated ? '输出达到长度上限被截断' : '输出不是合法的 JSON 对象');

  if (!parsed || shapeError) {
    const second = await invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      ...(first.content.trim() ? [{ role: 'assistant' as const, content: first.content.slice(0, 12_000) }] : []),
      { role: 'user', content: buildRepairPrompt(first.content, shapeError ?? 'JSON 解析失败', input) },
    ], 'repair');
    if (second.truncated) {
      throw new OnboardingAgentError('model_failed', '模型在 JSON 修复重试后仍达到生成上限，请精简描述或更换更大上下文模型重试。');
    }
    parsed = extractJsonObject(second.content);
    shapeError = parsed ? validateProposalShape(parsed) : '修复重试后仍无法解析为合法 JSON 对象';
    if (!parsed || shapeError) {
      throw new OnboardingAgentError('model_failed', `冷启动方案解析失败：${shapeError}。请重试或先用离线手动配置。`);
    }
  }

  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt);
  const servedModel = reportedModel ?? profile.model;
  return {
    proposal: finalizeProposal(parsed, input, servedModel, finishedAt.toISOString()),
    usage: {
      model: profile.model,
      ...(reportedModel ? { reportedModel } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      durationMs,
    },
  };
}
