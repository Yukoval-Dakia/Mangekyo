import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { formatUsdMicros } from '../shared/format-time';
import { handleInternalLinkClick, isSafeInternalHref } from '../shared/safe-navigation';
import {
  isRecord,
  pickString,
  readArray,
  readNumeric,
  readStringList,
  readTrimmed,
} from '../shared/safe-values';
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

function formatTokens(
  prompt: number | undefined,
  completion: number | undefined,
  total: number | undefined,
): string | undefined {
  if (prompt !== undefined && completion !== undefined) {
    return `↑${Math.round(prompt).toLocaleString('zh-CN')} / ↓${Math.round(completion).toLocaleString('zh-CN')}`;
  }
  if (total !== undefined && total > 0) {
    return `${Math.round(total).toLocaleString('zh-CN')} tokens`;
  }
  return undefined;
}

function tickKeyOf(value: unknown): string | undefined {
  return readTrimmed(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined);
}

function pushBucket<T>(map: Map<string, T[]>, key: string | undefined, item: T): void {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(item);
  else map.set(key, [item]);
}

function humanizePolicyLabel(rawLabel: string | undefined): string {
  if (!rawLabel) return '后台调度路由';
  if (POLICY_LABELS[rawLabel]) return POLICY_LABELS[rawLabel]!;
  if (rawLabel.startsWith('model:')) return `教研模型策略（${rawLabel.slice('model:'.length)}）`;
  return rawLabel;
}

function isLocalZeroCostCall(call: Record<string, unknown>, model: string | undefined): boolean {
  if (call.local === true || call.isLocal === true || call.zeroCost === true) return true;
  const provider = (pickString(call, 'provider', 'billing') ?? '').toLowerCase();
  if (provider === 'local' || provider === 'ollama' || provider === 'local-gateway') return true;
  return Boolean(model && /^(?:local|ollama)[:/]/i.test(model));
}

function normalizeExplicitTrace(raw: unknown, index: number): DecisionTraceItem | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceEvent = pickString(raw, 'sourceEvent', 'source_event', 'trigger', 'event');
  const matchedPolicy = pickString(raw, 'matchedPolicy', 'matched_policy', 'policy', 'skill');
  const todoSummary = pickString(raw, 'todoSummary', 'todo_summary', 'todo', 'workingTodo');
  if (!sourceEvent && !matchedPolicy && !todoSummary) return undefined;

  const costRec = isRecord(raw.modelAndCost) ? raw.modelAndCost : raw;
  const model = pickString(costRec, 'model', 'actualModel', 'actual_model', 'route');
  const micros = readNumeric(
    costRec.actualMicros ?? costRec.costMicros ?? costRec.cost_micros ?? costRec.reservedMicros,
  );
  const explicitCost = pickString(costRec, 'costText', 'cost_text') ?? formatUsdMicros(micros) ?? undefined;
  const tokenText =
    readTrimmed(costRec.tokenText) ??
    formatTokens(
      readNumeric(costRec.promptTokens ?? costRec.prompt_tokens),
      readNumeric(costRec.completionTokens ?? costRec.completion_tokens),
      readNumeric(costRec.totalTokens ?? costRec.total_tokens),
    );
  const tools = readStringList(costRec.tools);
  const title = readTrimmed(raw.title);
  const occurredAt = pickString(raw, 'occurredAt', 'createdAt');
  const status = readTrimmed(raw.status);
  const href = readTrimmed(raw.href);

  return {
    id: readTrimmed(raw.id) ?? `trace-${index}`,
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
      ...(tools.length > 0 ? { tools } : {}),
    },
    ...(href ? { href } : {}),
  };
}

function projectFromAiActivity(payload: unknown): readonly DecisionTraceItem[] {
  if (!isRecord(payload)) return [];
  const explicit = payload.decisionTraces ?? payload.decision_traces;
  if (Array.isArray(explicit)) return readArray(explicit, normalizeExplicitTrace);

  const traces: DecisionTraceItem[] = [];
  const usage = isRecord(payload.usage) ? payload.usage : null;
  const recentCalls = Array.isArray(usage?.recentCalls) ? usage.recentCalls : [];
  const handoffs = Array.isArray(payload.handoffs) ? payload.handoffs : [];
  const running = Array.isArray(payload.running) ? payload.running : [];
  const recentTools = Array.isArray(payload.recentTools) ? payload.recentTools : [];

  const handoffsByTick = new Map<string, Record<string, unknown>[]>();
  const handoffById = new Map<string, Record<string, unknown>>();
  for (const item of handoffs) {
    if (!isRecord(item)) continue;
    const itemId = readTrimmed(item.id);
    if (itemId && !handoffById.has(itemId)) handoffById.set(itemId, item);
    pushBucket(handoffsByTick, tickKeyOf(item.tick), item);
  }
  const toolTurnsBySession = new Map<string, Record<string, unknown>[]>();
  for (const turn of recentTools) {
    if (isRecord(turn)) pushBucket(toolTurnsBySession, readTrimmed(turn.sessionId), turn);
  }

  for (let i = 0; i < recentCalls.length && traces.length < 8; i += 1) {
    const call = recentCalls[i];
    if (!isRecord(call)) continue;
    const label = pickString(call, 'label', 'purpose');
    const ownerKind = readTrimmed(call.ownerKind);
    const ownerId = readTrimmed(call.ownerId);
    const startedTick = tickKeyOf(call.startedTick) ?? tickKeyOf(call.tick) ?? tickKeyOf(call.finishedTick);
    const tickCandidates = startedTick ? handoffsByTick.get(startedTick) : undefined;
    const matchedHandoff =
      (ownerId ? handoffById.get(ownerId) : undefined) ??
      tickCandidates?.find((entry) => ownerId && readTrimmed(entry.id) === ownerId) ??
      tickCandidates?.[0];
    const sessionTurns = ownerId ? toolTurnsBySession.get(ownerId) : undefined;
    const matchedTurn =
      sessionTurns?.find((entry) => startedTick && tickKeyOf(entry.tick) === startedTick) ??
      sessionTurns?.[0];
    const stateRaw = pickString(call, 'state', 'status');
    const stateText = stateRaw ? STATE_LABELS[stateRaw] ?? stateRaw : undefined;

    const sourceEvent = matchedHandoff
      ? CHANNEL_SOURCE_LABELS[readTrimmed(matchedHandoff.channel) ?? ''] ?? '后台状态变更触发'
      : ownerKind === 'session'
        ? '学习者会话请求触发'
        : '后台事实变更与定时巡检触发';
    const todoTitle =
      (matchedHandoff ? pickString(matchedHandoff, 'title', 'summary') : undefined) ??
      (label ? POLICY_LABELS[label] ?? label : '模型推理工作单');
    const model = pickString(call, 'model', 'route');
    const micros = readNumeric(call.actualMicros ?? call.reservedMicros ?? call.costMicros);
    const costText =
      formatUsdMicros(micros) ?? (isLocalZeroCostCall(call, model) ? '本地网关 · $0.0000' : '费用待结算');
    const tokenText = formatTokens(
      readNumeric(call.promptTokens),
      readNumeric(call.completionTokens),
      readNumeric(call.totalTokens),
    );
    const tools = readStringList(matchedTurn?.tools);
    const href = readTrimmed(matchedHandoff?.href) ?? readTrimmed(matchedTurn?.href);

    traces.push({
      id: readTrimmed(call.id) ?? `call-${i}`,
      ...(stateText ? { status: stateText } : {}),
      sourceEvent,
      matchedPolicy: humanizePolicyLabel(label),
      todoSummary: stateText ? `${todoTitle}（${stateText}）` : todoTitle,
      modelAndCost: {
        ...(model ? { model } : {}),
        costText,
        ...(tokenText ? { tokenText } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      },
      ...(href ? { href } : {}),
    });
  }

  if (traces.length === 0) {
    for (let i = 0; i < running.length && traces.length < 5; i += 1) {
      const task = running[i];
      if (!isRecord(task)) continue;
      const title = readTrimmed(task.title) ?? '后台工作单';
      const deriver = pickString(task, 'deriver', 'slotType') ?? '内核调度器';
      const stateRaw = readTrimmed(task.state);
      const stateText = stateRaw ? STATE_LABELS[stateRaw] ?? stateRaw : '处理中';
      traces.push({
        id: readTrimmed(task.id) ?? `run-${i}`,
        status: stateText,
        sourceEvent: '后台工作流事件入队',
        matchedPolicy: humanizePolicyLabel(deriver),
        todoSummary: `${title}（${stateText}）`,
        modelAndCost: { costText: '0-LLM 或待结算' },
      });
    }
  }

  return traces;
}

function TraceStep({ badge, value }: { readonly badge: string; readonly value: string }) {
  return (
    <>
      <div className="me-v2-trace-step" role="listitem">
        <span className="me-v2-trace-step-badge">{badge}</span>
        <p className="me-v2-trace-step-value">{value}</p>
      </div>
      <span className="me-v2-trace-arrow" aria-hidden="true">
        <Icon name="arrow" />
      </span>
    </>
  );
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
        if (!controller.signal.aborted) setLoadedTraces(projectFromAiActivity(payload));
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
                    <TraceStep badge="1 · 源事件" value={trace.sourceEvent} />
                    <TraceStep badge="2 · 命中策略" value={trace.matchedPolicy} />
                    <TraceStep badge="3 · Todo" value={trace.todoSummary} />

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

                  {trace.href && isSafeInternalHref(trace.href) && (
                    <div className="me-v2-trace-item-foot">
                      <a
                        className="me-v2-trace-link"
                        href={trace.href}
                        onClick={(event) => handleInternalLinkClick(event, trace.href!, onNavigate)}
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
