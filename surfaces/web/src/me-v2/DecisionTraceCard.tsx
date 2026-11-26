import { useEffect, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import type { DecisionTraceCardProps, DecisionTraceItem } from './types';

const POLICY_LABELS: Readonly<Record<string, string>> = {
  'knowledge-maintenance-v1': '知识库园艺与维护策略',
  'research-worker-v1': '后台教研工作单策略',
  'background-research-scout-v1': '后台教研探查策略',
  'vision-ocr': '试卷视觉识题路由',
  'workbook-rubric': '主观题自动评阅路由',
  'teaching-model': '同伴实时对话路由',
  'intake-mineru': '云端文档提取路由',
  'question-independent-solve': '题库独立双解验算',
  'question-contract-validation': '题库契约校验策略',
  'question-meta-gardening': '题库元信息园艺策略',
  'onboarding-setup': '初始学习画像编排',
};

const CHANNEL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  night_chain: '夜间教研巡检触发',
  research: '作答后教研分诊触发',
  retention: '遗忘曲线与保持预测触发',
  notion: '外部笔记同步触发',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  done: '已完成',
  completed: '已完成',
  ready: '已就绪',
  running: '运行中',
  started: '执行中',
  queued: '排队中',
  waiting: '等待中',
  blocked: '已暂停',
  failed: '未完成',
  unknown: '待确认',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatUsdMicros(micros: number | null): string | undefined {
  if (micros === null || micros < 0) return undefined;
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

function formatTokens(
  prompt: number | null,
  completion: number | null,
  total: number | null,
): string | undefined {
  if (prompt !== null && completion !== null) {
    return `↑${Math.round(prompt).toLocaleString('zh-CN')} / ↓${Math.round(completion).toLocaleString('zh-CN')}`;
  }
  if (total !== null && total > 0) {
    return `${Math.round(total).toLocaleString('zh-CN')} tokens`;
  }
  return undefined;
}

function isSpaHref(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  if (/^\/api(?:\/|\?|#|$)/i.test(href)) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(href)) return false;
  return true;
}

function handleLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate?: (href: string) => void,
) {
  if (!onNavigate || !isSpaHref(href)) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  onNavigate(href);
}

function normalizeExplicitTrace(raw: unknown, index: number): DecisionTraceItem | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceEvent =
    textOf(raw.sourceEvent) ??
    textOf(raw.source_event) ??
    textOf(raw.trigger) ??
    textOf(raw.event);
  const matchedPolicy =
    textOf(raw.matchedPolicy) ??
    textOf(raw.matched_policy) ??
    textOf(raw.policy) ??
    textOf(raw.skill);
  const todoSummary =
    textOf(raw.todoSummary) ??
    textOf(raw.todo_summary) ??
    textOf(raw.todo) ??
    textOf(raw.workingTodo);

  if (!sourceEvent && !matchedPolicy && !todoSummary) return undefined;

  const modelCostRecord = isRecord(raw.modelAndCost) ? raw.modelAndCost : raw;
  const model =
    textOf(modelCostRecord.model) ??
    textOf(modelCostRecord.actualModel) ??
    textOf(modelCostRecord.actual_model) ??
    textOf(modelCostRecord.route);
  const micros = numberOf(
    modelCostRecord.actualMicros ??
      modelCostRecord.costMicros ??
      modelCostRecord.cost_micros ??
      modelCostRecord.reservedMicros,
  );
  const explicitCost =
    textOf(modelCostRecord.costText) ??
    textOf(modelCostRecord.cost_text) ??
    formatUsdMicros(micros);
  const tokenText =
    textOf(modelCostRecord.tokenText) ??
    formatTokens(
      numberOf(modelCostRecord.promptTokens ?? modelCostRecord.prompt_tokens),
      numberOf(modelCostRecord.completionTokens ?? modelCostRecord.completion_tokens),
      numberOf(modelCostRecord.totalTokens ?? modelCostRecord.total_tokens),
    );
  const tools = Array.isArray(modelCostRecord.tools)
    ? modelCostRecord.tools.map(textOf).filter((entry): entry is string => Boolean(entry))
    : undefined;

  const id = textOf(raw.id) ?? `trace-${index}`;
  const title = textOf(raw.title);
  const occurredAt = textOf(raw.occurredAt) ?? textOf(raw.createdAt);
  const status = textOf(raw.status);
  const href = textOf(raw.href);

  return {
    id,
    ...(title ? { title } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    ...(status ? { status: STATE_LABELS[status] ?? status } : {}),
    sourceEvent: sourceEvent ?? '系统事件触发',
    matchedPolicy: matchedPolicy ?? '默认调度策略',
    todoSummary: todoSummary ?? '后台工作单执行',
    modelAndCost: {
      ...(model ? { model } : {}),
      ...(explicitCost ? { costText: explicitCost } : {}),
      ...(tokenText ? { tokenText } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
    },
    ...(href ? { href } : {}),
  };
}

function humanizePolicyLabel(rawLabel: string | undefined): string {
  if (!rawLabel) return '后台调度路由';
  if (POLICY_LABELS[rawLabel]) return POLICY_LABELS[rawLabel]!;
  if (rawLabel.startsWith('model:')) return `教研模型策略（${rawLabel.slice('model:'.length)}）`;
  return rawLabel;
}

function projectFromAiActivity(payload: unknown): readonly DecisionTraceItem[] {
  if (!isRecord(payload)) return [];

  // 1. 优先直读后端直接返回的 decisionTraces / decision_traces 结构化数组。
  const explicit = payload.decisionTraces ?? payload.decision_traces;
  if (Array.isArray(explicit)) {
    return explicit
      .map(normalizeExplicitTrace)
      .filter((entry): entry is DecisionTraceItem => Boolean(entry));
  }

  // 2. 兼容现行 `/api/ai/activity`：仅当存在真实运行账本记录时，将其投影为 4 段因果链（绝不编造）。
  const traces: DecisionTraceItem[] = [];
  const usage = isRecord(payload.usage) ? payload.usage : null;
  const recentCalls = Array.isArray(usage?.recentCalls) ? usage.recentCalls : [];
  const handoffs = Array.isArray(payload.handoffs) ? payload.handoffs : [];
  const running = Array.isArray(payload.running) ? payload.running : [];
  const recentTools = Array.isArray(payload.recentTools) ? payload.recentTools : [];

  const tickKeyOf = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
  };

  const handoffsByTick = new Map<string, Record<string, unknown>[]>();
  const handoffById = new Map<string, Record<string, unknown>>();
  for (const item of handoffs) {
    if (!isRecord(item)) continue;
    const itemId = textOf(item.id);
    if (itemId && !handoffById.has(itemId)) {
      handoffById.set(itemId, item);
    }
    const tickKey = tickKeyOf(item.tick);
    if (tickKey) {
      const bucket = handoffsByTick.get(tickKey);
      if (bucket) bucket.push(item);
      else handoffsByTick.set(tickKey, [item]);
    }
  }
  const toolTurnsBySession = new Map<string, Record<string, unknown>[]>();
  for (const turn of recentTools) {
    if (!isRecord(turn)) continue;
    const sessionKey = textOf(turn.sessionId);
    if (!sessionKey) continue;
    const bucket = toolTurnsBySession.get(sessionKey);
    if (bucket) bucket.push(turn);
    else toolTurnsBySession.set(sessionKey, [turn]);
  }

  const isLocalZeroCostCall = (call: Record<string, unknown>, model: string | undefined): boolean => {
    if (call.local === true || call.isLocal === true || call.zeroCost === true) return true;
    const provider = (textOf(call.provider) ?? textOf(call.billing) ?? '').toLowerCase();
    if (provider === 'local' || provider === 'ollama' || provider === 'local-gateway') return true;
    if (model && /^(?:local|ollama)[:/]/i.test(model)) return true;
    return false;
  };

  for (let i = 0; i < recentCalls.length && traces.length < 8; i += 1) {
    const call = recentCalls[i];
    if (!isRecord(call)) continue;
    const label = textOf(call.label) ?? textOf(call.purpose);
    const ownerKind = textOf(call.ownerKind);
    const ownerId = textOf(call.ownerId);
    const startedTick = tickKeyOf(call.startedTick) ?? tickKeyOf(call.tick) ?? tickKeyOf(call.finishedTick);
    const tickCandidates = startedTick ? handoffsByTick.get(startedTick) : undefined;
    const matchedHandoff =
      (ownerId ? handoffById.get(ownerId) : undefined) ??
      (tickCandidates
        ? tickCandidates.find((entry) => ownerId && textOf(entry.id) === ownerId) ?? tickCandidates[0]
        : undefined);
    const sessionTurns = ownerId ? toolTurnsBySession.get(ownerId) : undefined;
    const matchedTurn = sessionTurns
      ? sessionTurns.find((entry) => startedTick && tickKeyOf(entry.tick) === startedTick) ?? sessionTurns[0]
      : undefined;
    const stateRaw = textOf(call.state) ?? textOf(call.status);
    const stateText = stateRaw ? STATE_LABELS[stateRaw] ?? stateRaw : undefined;

    const sourceEvent = matchedHandoff
      ? CHANNEL_SOURCE_LABELS[textOf(matchedHandoff.channel) ?? ''] ?? '后台状态变更触发'
      : ownerKind === 'session'
        ? '学习者会话请求触发'
        : '后台事实变更与定时巡检触发';

    const matchedPolicy = humanizePolicyLabel(label);

    const todoTitle =
      textOf(matchedHandoff?.title) ??
      textOf(matchedHandoff?.summary) ??
      (label ? POLICY_LABELS[label] ?? label : '模型推理工作单');
    const todoSummary = stateText ? `${todoTitle}（${stateText}）` : todoTitle;

    const model = textOf(call.model) ?? textOf(call.route);
    const micros = numberOf(call.actualMicros ?? call.reservedMicros ?? call.costMicros);
    const costText =
      formatUsdMicros(micros) ?? (isLocalZeroCostCall(call, model) ? '本地网关 · $0.0000' : '费用待结算');
    const tokenText = formatTokens(
      numberOf(call.promptTokens),
      numberOf(call.completionTokens),
      numberOf(call.totalTokens),
    );
    const tools = Array.isArray(matchedTurn?.tools)
      ? matchedTurn.tools.map(textOf).filter((entry): entry is string => Boolean(entry))
      : undefined;
    const href = textOf(matchedHandoff?.href) ?? textOf(matchedTurn?.href);

    traces.push({
      id: textOf(call.id) ?? `call-${i}`,
      ...(stateText ? { status: stateText } : {}),
      sourceEvent,
      matchedPolicy,
      todoSummary,
      modelAndCost: {
        ...(model ? { model } : {}),
        costText,
        ...(tokenText ? { tokenText } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      },
      ...(href ? { href } : {}),
    });
  }

  // 若尚无模型计费调用，但存在真实的 0-LLM 后台工作单或交班记录，也诚实呈现。
  if (traces.length === 0) {
    for (let i = 0; i < running.length && traces.length < 5; i += 1) {
      const task = running[i];
      if (!isRecord(task)) continue;
      const title = textOf(task.title) ?? '后台工作单';
      const deriver = textOf(task.deriver) ?? textOf(task.slotType) ?? '内核调度器';
      const stateRaw = textOf(task.state);
      const stateText = stateRaw ? STATE_LABELS[stateRaw] ?? stateRaw : '处理中';
      traces.push({
        id: textOf(task.id) ?? `run-${i}`,
        status: stateText,
        sourceEvent: '后台工作流事件入队',
        matchedPolicy: humanizePolicyLabel(deriver),
        todoSummary: `${title}（${stateText}）`,
        modelAndCost: {
          costText: '0-LLM 或待结算',
        },
      });
    }
  }

  return traces;
}

export function DecisionTraceCard({ decisionTraces, onNavigate }: DecisionTraceCardProps) {
  const [loadedTraces, setLoadedTraces] = useState<readonly DecisionTraceItem[]>([]);
  const [loading, setLoading] = useState(decisionTraces === undefined);

  useEffect(() => {
    if (decisionTraces !== undefined) {
      setLoading(false);
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void api<unknown>('/ai/activity', { signal: controller.signal, cache: 'no-store' })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setLoadedTraces(projectFromAiActivity(payload));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadedTraces([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [decisionTraces]);

  const traces = decisionTraces ?? loadedTraces;

  return (
    <article className="me-v2-card me-v2-trace-card" aria-labelledby="me-v2-trace-title">
      <details className="me-v2-trace-details">
        <summary className="me-v2-trace-summary">
          <div className="me-v2-trace-summary-copy">
            <h3 id="me-v2-trace-title">决策因果 Trace</h3>
            <p className="me-v2-card-sub">
              默认折叠；展开核对 源事件 → 命中策略 → Todo → 实际模型与费用 完整链路。
            </p>
          </div>
          <div className="me-v2-trace-summary-end">
            {!loading && traces.length > 0 && (
              <span className="me-v2-trace-count">{traces.length} 条链路</span>
            )}
            <span className="me-v2-trace-chevron" aria-hidden="true">
              <Icon name="chevron" />
            </span>
          </div>
        </summary>

        <div className="me-v2-trace-body">
          {loading ? (
            <p className="me-v2-empty-inline">正在读取后台决策因果链…</p>
          ) : traces.length === 0 ? (
            <div className="me-v2-empty me-v2-trace-empty">
              <p>
                暂无已记录的后台决策因果链；系统执行自主分诊、组卷或教研维护后会在此展示完整链路与费用。
              </p>
            </div>
          ) : (
            <ol className="me-v2-trace-list">
              {traces.map((trace) => (
                <li key={trace.id} className="me-v2-trace-item">
                  {(trace.title || trace.status || trace.occurredAt) && (
                    <div className="me-v2-trace-item-head">
                      {trace.title && <strong>{trace.title}</strong>}
                      <div className="me-v2-trace-item-meta">
                        {trace.status && <span className="me-v2-trace-pill">{trace.status}</span>}
                        {trace.occurredAt && <time>{trace.occurredAt}</time>}
                      </div>
                    </div>
                  )}

                  <div className="me-v2-trace-chain" role="list" aria-label="四步决策因果链">
                    <div className="me-v2-trace-step" role="listitem">
                      <span className="me-v2-trace-step-badge">1 · 源事件</span>
                      <p className="me-v2-trace-step-value">{trace.sourceEvent}</p>
                    </div>

                    <span className="me-v2-trace-arrow" aria-hidden="true">
                      <Icon name="arrow" />
                    </span>

                    <div className="me-v2-trace-step" role="listitem">
                      <span className="me-v2-trace-step-badge">2 · 命中策略</span>
                      <p className="me-v2-trace-step-value">{trace.matchedPolicy}</p>
                    </div>

                    <span className="me-v2-trace-arrow" aria-hidden="true">
                      <Icon name="arrow" />
                    </span>

                    <div className="me-v2-trace-step" role="listitem">
                      <span className="me-v2-trace-step-badge">3 · Todo</span>
                      <p className="me-v2-trace-step-value">{trace.todoSummary}</p>
                    </div>

                    <span className="me-v2-trace-arrow" aria-hidden="true">
                      <Icon name="arrow" />
                    </span>

                    <div className="me-v2-trace-step me-v2-trace-step--cost" role="listitem">
                      <span className="me-v2-trace-step-badge">4 · 实际模型与费用</span>
                      <div className="me-v2-trace-cost-meta">
                        {trace.modelAndCost.model && (
                          <span className="me-v2-trace-pill me-v2-trace-pill--model">
                            {trace.modelAndCost.model}
                          </span>
                        )}
                        {trace.modelAndCost.costText && (
                          <span className="me-v2-trace-pill me-v2-trace-pill--cost">
                            {trace.modelAndCost.costText}
                          </span>
                        )}
                        {!trace.modelAndCost.model && !trace.modelAndCost.costText && (
                          <span className="me-v2-trace-pill">0-LLM 确定性执行</span>
                        )}
                      </div>
                      {trace.modelAndCost.tokenText && (
                        <small className="me-v2-trace-submeta">{trace.modelAndCost.tokenText}</small>
                      )}
                      {trace.modelAndCost.tools && trace.modelAndCost.tools.length > 0 && (
                        <small className="me-v2-trace-submeta">
                          工具：{trace.modelAndCost.tools.slice(0, 3).join('、')}
                          {trace.modelAndCost.tools.length > 3 ? ` 等 ${trace.modelAndCost.tools.length} 项` : ''}
                        </small>
                      )}
                    </div>
                  </div>

                  {trace.href && isSpaHref(trace.href) && (
                    <div className="me-v2-trace-item-foot">
                      <a
                        className="me-v2-trace-link"
                        href={trace.href}
                        onClick={(event) => handleLinkClick(event, trace.href!, onNavigate)}
                      >
                        查看关联产物
                      </a>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </article>
  );
}
