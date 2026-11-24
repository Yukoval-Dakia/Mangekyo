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
import { extractJsonObject } from './onboarding-agent.ts';

export type BackgroundLlmProvider = TeachingProvider | ProviderSettings;

export type BackgroundLlmTransport = (
  endpoint: string,
  body: string,
  apiKey: string | undefined,
  clientRequestId: string,
  hooks: ProviderHooks,
  provider: TeachingProvider,
) => Promise<Completion | { rejectedHttpStatus: number }>;

export type SettingsUnderstandingTransportOptions<TRecipient = never> = {
  readonly route?: string;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly maySend?: TRecipient;
  readonly transport?: BackgroundLlmTransport;
};

export type SettingsUnderstandingTransport<TRecipient = never> = {
  readonly route: string;
  readonly cost: 0;
  readonly maySend?: TRecipient;
  sample(request: { instructions: string; input: string; providerEffectId: string }): Promise<string>;
};

export type KnowledgeMaintenanceConcept = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly masteryLevel?: string;
  readonly attemptCount?: number;
  readonly errorStages?: readonly string[];
};

export type KnowledgeMaintenanceEdge = {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: string;
};

export type KnowledgeMaintenanceSignal = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly excerpt: string;
};

export type KnowledgeMaintenanceContext = {
  readonly concepts: readonly KnowledgeMaintenanceConcept[];
  readonly edges: readonly KnowledgeMaintenanceEdge[];
  readonly recentSignals: readonly KnowledgeMaintenanceSignal[];
  readonly currentDate: string;
};

export type KnowledgeMaintenanceEdgeSuggestion = {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: 'prereq_of' | 'related_to';
  readonly rationale: string;
};

export type KnowledgeMaintenanceSummaryUpdate = {
  readonly conceptId: string;
  readonly summary: string;
  readonly rationale: string;
};

export type KnowledgeMaintenancePrepNote = {
  readonly title: string;
  readonly focusConceptIds: string[];
  readonly summary: string;
  readonly actionSteps: string[];
};

export type KnowledgeMaintenanceProposal = {
  readonly shouldAct: boolean;
  readonly rationale: string;
  readonly suggestedEdges: KnowledgeMaintenanceEdgeSuggestion[];
  readonly suggestedSummaryUpdates: KnowledgeMaintenanceSummaryUpdate[];
  readonly suggestedPrepNote?: KnowledgeMaintenancePrepNote;
};

export type KnowledgeMaintenanceOptions = {
  readonly provider?: BackgroundLlmProvider | null;
  readonly requestId?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly transport?: BackgroundLlmTransport;
  readonly signal?: AbortSignal;
};

export type KnowledgeMaintenanceResult = {
  readonly proposal: KnowledgeMaintenanceProposal;
  readonly usage: {
    readonly model: string;
    readonly reportedModel?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly durationMs: number;
  };
};

const defaultTimeoutMs = 60_000;
const defaultMaxTokens = 4_096;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalZeroCostProvider(provider: Pick<TeachingProvider, 'baseUrl' | 'apiKey'>): boolean {
  if (provider.apiKey?.trim()) return false;
  try {
    return loopbackHosts.has(new URL(provider.baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function cappedBackgroundEffort(effort: string): string {
  return effort === 'default' || effort === 'low' ? effort : 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizeRequestId(raw: string | undefined, prefix: string): string {
  const cleaned = raw?.replace(/[^\x21-\x7e]/g, '').slice(0, 512);
  return cleaned || `${prefix}-${randomUUID()}`;
}

function resolveBackgroundProvider(raw: BackgroundLlmProvider | null | undefined) {
  if (!raw || typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) {
    throw new TeachingError('provider_unavailable', '尚未配置可用的后台 AI 模型。');
  }
  const provider: TeachingProvider = {
    baseUrl: raw.baseUrl.trim(),
    ...(raw.apiKey ? { apiKey: raw.apiKey } : {}),
    protocol: providerProtocol(raw),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}),
  };
  const endpoint = providerEndpoint(provider);
  const profile = profileFor(provider);
  const reasoningEffort = cappedBackgroundEffort(profile.reasoningEffort);
  return { provider, endpoint, profile, reasoningEffort };
}

async function withAttemptTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new TeachingError('provider_timeout', '后台模型请求已取消。');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TeachingError('provider_timeout', `后台模型响应超时（${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);
    if (signal) {
      onAbort = () => reject(new TeachingError('provider_timeout', '后台模型请求已取消。'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function invokeBackgroundCompletion(
  rawProvider: BackgroundLlmProvider | null | undefined,
  messages: readonly { readonly role: 'system' | 'user'; readonly content: string }[],
  options: {
    readonly requestId?: string;
    readonly requestPrefix: string;
    readonly maxTokens?: number;
    readonly timeoutMs?: number;
    readonly transport?: BackgroundLlmTransport;
    readonly signal?: AbortSignal;
  },
) {
  const { provider, endpoint, profile, reasoningEffort } = resolveBackgroundProvider(rawProvider);
  const maxTokens = Math.max(512, Math.min(8_192, Math.trunc(options.maxTokens ?? defaultMaxTokens)));
  const timeoutMs = Math.max(50, Math.min(180_000, Math.trunc(options.timeoutMs ?? defaultTimeoutMs)));
  const transport = options.transport ?? requestCompletion;
  const clientRequestId = sanitizeRequestId(options.requestId, options.requestPrefix);

  const body = JSON.stringify({
    model: profile.model,
    max_tokens: maxTokens,
    stream: true,
    ...(reasoningEffort !== 'default' ? { reasoning_effort: reasoningEffort } : {}),
    messages,
  });

  const result = await withAttemptTimeout(
    transport(endpoint, body, provider.apiKey, clientRequestId, {}, provider),
    timeoutMs,
    options.signal,
  );
  checkProviderOutcome(result);
  const completion = result as Completion;
  const content = 'content' in completion && typeof completion.content === 'string' ? completion.content.trim() : '';
  if (!content) {
    throw new TeachingError('provider_response', '后台模型未返回有效文本内容。');
  }
  const reportedModel = providerIdentifier(completion.model, provider.apiKey);
  return {
    content,
    model: profile.model,
    ...(reportedModel ? { reportedModel } : {}),
    ...(completion.usage?.prompt_tokens !== undefined ? { inputTokens: completion.usage.prompt_tokens } : {}),
    ...(completion.usage?.completion_tokens !== undefined ? { outputTokens: completion.usage.completion_tokens } : {}),
  };
}

export function createSettingsUnderstandingTransport<TRecipient = never>(
  loadProvider: () => Promise<BackgroundLlmProvider | null | undefined> | BackgroundLlmProvider | null | undefined,
  options: SettingsUnderstandingTransportOptions<TRecipient> = {},
): SettingsUnderstandingTransport<TRecipient> {
  const route = options.route?.trim() || 'settings:active';
  return {
    route,
    cost: 0 as const,
    ...(options.maySend !== undefined ? { maySend: options.maySend } : {}),
    async sample({ instructions, input, providerEffectId }) {
      const provider = await loadProvider();
      const { provider: resolved } = resolveBackgroundProvider(provider);
      if (!isLocalZeroCostProvider(resolved)) {
        throw new TeachingError('provider_unavailable', '零成本后台理解通道仅允许本机无密钥回环端点；外部付费模型需通过预算授权路径运行。');
      }
      const result = await invokeBackgroundCompletion(
        resolved,
        [
          { role: 'system', content: instructions },
          { role: 'user', content: input },
        ],
        {
          requestId: providerEffectId,
          requestPrefix: 'understanding',
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.transport ? { transport: options.transport } : {}),
        },
      );
      return result.content;
    },
  };
}

function buildMaintenanceSystemPrompt(): string {
  return [
    '你是学习者的后台知识库园丁（Knowledge Gardener），负责在后台低打扰地检查概念图谱与近期学习信号。',
    '核心原则：宁缺毋滥。只有在发现明确的高信号缺口（关键前置/关联边缺失，或需要针对性复习备忘）时，才将 shouldAct 设为 true；否则必须返回 shouldAct: false、空数组且省略 suggestedPrepNote。',
    '硬约束：',
    '1. 所有 fromId、toId、focusConceptIds 必须严格逐字复用输入 concepts[].id，绝对禁止编造新 ID、禁止自环（fromId === toId）、禁止重复已有边。',
    '2. suggestedEdges 最多 6 条，kind 仅限 "prereq_of" 或 "related_to"；suggestedPrepNote 可选，focusConceptIds 1-5 个，actionSteps 1-5 条。',
    '3. 仅输出一个严格 JSON 对象，不要包含 Markdown 代码块之外的多余解释。',
    '输出 Schema：',
    '{"shouldAct":boolean,"rationale":string,"suggestedEdges":[{"fromId":string,"toId":string,"kind":"prereq_of"|"related_to","rationale":string}],"suggestedPrepNote":{"title":string,"focusConceptIds":[string],"summary":string,"actionSteps":[string]}}',
  ].join('\n');
}

function buildMaintenanceUserPrompt(context: KnowledgeMaintenanceContext): string {
  const payload = {
    currentDate: context.currentDate,
    concepts: context.concepts.slice(0, 80).map(c => ({
      id: c.id,
      title: c.title,
      summary: c.summary ?? null,
      ...(c.masteryLevel ? { masteryLevel: c.masteryLevel } : {}),
      ...(c.attemptCount !== undefined ? { attemptCount: c.attemptCount } : {}),
      ...(c.errorStages?.length ? { errorStages: c.errorStages.slice(0, 6) } : {}),
    })),
    edges: context.edges.slice(0, 120).map(e => ({ fromId: e.fromId, toId: e.toId, kind: e.kind })),
    recentSignals: context.recentSignals.slice(0, 30).map(s => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      excerpt: s.excerpt.slice(0, 300),
    })),
  };
  return `请根据以下学习者知识库快照（日期 ${context.currentDate}）判断是否需要执行高信号维护，并输出 JSON：\n${JSON.stringify(payload)}`;
}

function sanitizeMaintenanceProposal(
  raw: Record<string, unknown>,
  context: KnowledgeMaintenanceContext,
): KnowledgeMaintenanceProposal {
  const conceptIds = new Set(context.concepts.map(c => c.id));
  const existingEdges = new Set<string>();
  for (const edge of context.edges) {
    existingEdges.add(`${edge.fromId}\0${edge.toId}\0${edge.kind}`);
    if (edge.kind === 'related_to') existingEdges.add(`${edge.toId}\0${edge.fromId}\0related_to`);
  }

  const rawRationale = cleanText(raw.rationale, 320);
  if (raw.shouldAct !== true) {
    return {
      shouldAct: false,
      rationale: rawRationale || '当前无高信号维护项，保持知识库现状。',
      suggestedEdges: [],
      suggestedSummaryUpdates: [],
    };
  }

  const seenEdges = new Set<string>();
  const suggestedEdges: KnowledgeMaintenanceEdgeSuggestion[] = [];
  if (Array.isArray(raw.suggestedEdges)) {
    for (const item of raw.suggestedEdges) {
      if (suggestedEdges.length >= 6 || !isRecord(item)) continue;
      const fromId = typeof item.fromId === 'string' ? item.fromId.trim() : '';
      const toId = typeof item.toId === 'string' ? item.toId.trim() : '';
      const kind = item.kind === 'prereq_of' || item.kind === 'related_to' ? item.kind : null;
      const rationale = cleanText(item.rationale, 240);
      if (!fromId || !toId || fromId === toId || !kind || !rationale) continue;
      if (!conceptIds.has(fromId) || !conceptIds.has(toId)) continue;
      const key = `${fromId}\0${toId}\0${kind}`;
      const reverseRelated = kind === 'related_to' ? `${toId}\0${fromId}\0related_to` : '';
      if (existingEdges.has(key) || seenEdges.has(key) || (reverseRelated && seenEdges.has(reverseRelated))) continue;
      seenEdges.add(key);
      suggestedEdges.push({ fromId, toId, kind, rationale });
    }
  }

  let suggestedPrepNote: KnowledgeMaintenancePrepNote | undefined;
  if (isRecord(raw.suggestedPrepNote)) {
    const title = cleanText(raw.suggestedPrepNote.title, 120);
    const summary = cleanText(raw.suggestedPrepNote.summary, 400);
    const focusConceptIds = Array.isArray(raw.suggestedPrepNote.focusConceptIds)
      ? [...new Set(raw.suggestedPrepNote.focusConceptIds
          .filter((id): id is string => typeof id === 'string')
          .map(id => id.trim())
          .filter(id => conceptIds.has(id)))].slice(0, 5)
      : [];
    const actionSteps = Array.isArray(raw.suggestedPrepNote.actionSteps)
      ? raw.suggestedPrepNote.actionSteps
          .map(step => cleanText(step, 200))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    if (title && summary && focusConceptIds.length > 0 && actionSteps.length > 0) {
      suggestedPrepNote = { title, focusConceptIds, summary, actionSteps };
    }
  }

  if (suggestedEdges.length === 0 && !suggestedPrepNote) {
    return {
      shouldAct: false,
      rationale: rawRationale || '校验后无有效高信号维护项，保持现状。',
      suggestedEdges: [],
      suggestedSummaryUpdates: [],
    };
  }

  return {
    shouldAct: true,
    rationale: rawRationale || '发现需要维护的高信号知识点或关联。',
    suggestedEdges,
    suggestedSummaryUpdates: [],
    ...(suggestedPrepNote ? { suggestedPrepNote } : {}),
  };
}

export async function proposeKnowledgeMaintenanceWithAgent(
  context: KnowledgeMaintenanceContext,
  options: KnowledgeMaintenanceOptions = {},
): Promise<KnowledgeMaintenanceResult> {
  const { profile } = resolveBackgroundProvider(options.provider);
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();

  if (context.concepts.length === 0) {
    return {
      proposal: {
        shouldAct: false,
        rationale: '当前知识图谱尚无概念节点，无需执行维护。',
        suggestedEdges: [],
        suggestedSummaryUpdates: [],
      },
      usage: { model: profile.model, durationMs: 0 },
    };
  }

  const completion = await invokeBackgroundCompletion(
    options.provider,
    [
      { role: 'system', content: buildMaintenanceSystemPrompt() },
      { role: 'user', content: buildMaintenanceUserPrompt(context) },
    ],
    {
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      requestPrefix: 'knowledge-maint',
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );

  const parsed = extractJsonObject(completion.content);
  if (!parsed) {
    throw new TeachingError('provider_response', '后台知识库维护方案不是合法的 JSON 对象。');
  }

  const durationMs = Math.max(0, now().getTime() - startedAt);
  return {
    proposal: sanitizeMaintenanceProposal(parsed, context),
    usage: {
      model: completion.model,
      ...(completion.reportedModel ? { reportedModel: completion.reportedModel } : {}),
      ...(completion.inputTokens !== undefined ? { inputTokens: completion.inputTokens } : {}),
      ...(completion.outputTokens !== undefined ? { outputTokens: completion.outputTokens } : {}),
      durationMs,
    },
  };
}
