import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons";
import {
  readAiActivity,
  type ActivityFallback,
  type AiActivity,
  type AiHandoffItem,
  type AiPendingProposalItem,
  type AiRecentToolItem,
  type AiRunningItem,
  type AiUsageCallItem,
} from "./aiActivity";

type ActivityState =
  | { status: "loading" }
  | { status: "ready"; source: "direct" | "fallback"; activity?: AiActivity; fallback?: ActivityFallback }
  | { status: "error"; message: string };

const ULID_SUFFIX_PATTERN = /\s*[·•-]\s*[0-9A-HJKMNP-TV-Z]{26}$/;
const COMMAND_TYPE_SUFFIX_PATTERN = /\s*[·•-]\s*[a-z][a-z0-9_]*\.[A-Za-z0-9_]+$/;

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="drawer-section">
      <div className="drawer-section-head">
        <h3>{title}</h3>
        {count !== undefined && <span className="drawer-hint">{count} 项</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="drawer-empty">{text}</p>;
}

function formatMicros(value: string | number | null | undefined) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return null;
  return `$${(parsed / 1_000_000).toFixed(4)}`;
}

function isSpaHref(href: string | null | undefined): href is string {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("/api/");
}

function cleanHumanTitle(text: string) {
  return text.replace(ULID_SUFFIX_PATTERN, "").replace(COMMAND_TYPE_SUFFIX_PATTERN, "").trim() || text;
}

function runningKindLabel(kind: string) {
  switch (kind) {
    case "teaching": return "同伴对话";
    case "research": return "后台教研";
    case "retention": return "记忆保持";
    case "intake": return "文档提取";
    case "assessment": return "自动评阅";
    case "verification": return "题库验收";
    default: return "后台任务";
  }
}

function runningStateLabel(item: AiRunningItem) {
  const raw = item.state ?? item.status ?? "";
  switch (raw) {
    case "running": return "运行中";
    case "queued": return "排队中";
    case "waiting": return "等待中";
    case "blocked": return "已受阻";
    default: return raw || "处理中";
  }
}

function handoffChannelLabel(item: AiHandoffItem) {
  switch (item.channel ?? item.kind) {
    case "night_chain": return "夜链交班";
    case "research": return "教研整理";
    case "retention": return "记忆保持";
    case "notion": return "Notion 同步";
    default: return "交班记录";
  }
}

function handoffStatusLabel(status: string) {
  switch (status) {
    case "completed": return "已完成";
    case "ready": return "已就绪";
    case "synced": return "已同步";
    case "observed": return "已对账";
    case "confirmed": return "已确认";
    case "missed": return "未命中";
    case "failed": return "未完成";
    default: return status || "已记录";
  }
}

function caseLabel(caseId: string | undefined) {
  switch (caseId) {
    case "companion":
    case "riding":
      return "同伴对话";
    case "diagnostic":
      return "诊断课堂";
    case "classroom":
      return "课堂";
    default:
      return null;
  }
}

function recentToolHeadline(item: AiRecentToolItem) {
  if (Array.isArray(item.tools) && item.tools.length > 0) {
    const preview = item.tools.slice(0, 3).join("、");
    const total = item.toolCount ?? item.tools.length;
    return total > 3 ? `${preview} 等 ${total} 项` : preview;
  }
  if (item.summary) return item.summary;
  if (item.tool) return item.tool;
  if (typeof item.toolCount === "number" && item.toolCount > 0) return `调用 ${item.toolCount} 项工具`;
  return "本轮对话记录";
}

function recentToolMeta(item: AiRecentToolItem) {
  const parts: string[] = [];
  const sourceLabel = caseLabel(item.caseId);
  if (sourceLabel) parts.push(sourceLabel);
  parts.push(`依据 ${item.basisCount ?? 0} 条`);
  if (typeof item.writeCount === "number" && item.writeCount > 0) parts.push(`写入 ${item.writeCount} 条`);
  if (item.model && item.model !== "unknown") parts.push(item.model);
  return parts.join(" · ");
}

function usageCallStateLabel(call: AiUsageCallItem) {
  switch (call.state ?? call.status) {
    case "done": return "已完成";
    case "started": return "进行中";
    case "unknown": return "状态待确认";
    default: return call.state ?? call.status ?? null;
  }
}

function usageCallMeta(call: AiUsageCallItem) {
  const cost = formatMicros(call.actualMicros ?? call.reservedMicros ?? call.costMicros);
  return [call.route || call.model || null, usageCallStateLabel(call), cost].filter(Boolean).join(" · ");
}

function proposalKindLabel(kind: string) {
  switch (kind) {
    case "knowledge_edge": return "图谱关联";
    case "graph_evolution": return "图谱演化";
    case "knowledge_entity": return "知识概念";
    case "textbook_patch": return "教材修订";
    case "question_draft": return "题库草稿";
    case "question_meta": return "题目补充";
    default: return "待裁决";
  }
}

function resolveProposalHref(item: AiPendingProposalItem) {
  if (isSpaHref(item.actionPath)) return item.actionPath;
  if (isSpaHref(item.actions?.inspect?.path)) return item.actions.inspect.path;
  switch (item.kind) {
    case "textbook_patch": return "/textbooks";
    case "question_draft":
    case "question_meta": return "/materials?view=iqdb";
    case "knowledge_edge":
    case "graph_evolution":
    case "knowledge_entity": return "/materials";
    default: return null;
  }
}

export function AiActivityDrawer({
  open,
  onClose,
  onNavigate,
  onRunningChange,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onRunningChange: (running: boolean) => void;
}) {
  const [state, setState] = useState<ActivityState>({ status: "loading" });
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async (forceProbe = false) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setState({ status: "loading" });
    try {
      const result = await readAiActivity(controller.signal, forceProbe);
      if (controller.signal.aborted) return;
      setState({ status: "ready", ...result });
      onRunningChange(result.source === "direct" && result.activity.running.length > 0);
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({ status: "error", message: error instanceof Error ? error.message : "暂时无法读取 AI 运作状态。" });
      }
    }
  }, [onRunningChange]);

  useEffect(() => {
    if (!open) return;
    void load(false);
    return () => activeRequest.current?.abort();
  }, [open, load]);

  useEffect(() => {
    if (!open || state.status !== "ready" || state.source !== "direct") return;
    const timer = window.setInterval(() => void load(false), 30000);
    return () => window.clearInterval(timer);
  }, [open, state, load]);

  return (
    <aside className="app-drawer" data-open={open} data-drawer="ai" aria-label="AI 运作" aria-hidden={!open}>
      <header className="drawer-header">
        <div>
          <h2>AI 运作</h2>
          <p className="drawer-subtitle">教研团状态、夜链交班与依据透明视图</p>
        </div>
        <div className="drawer-header-actions">
          <button className="icon-button" type="button" onClick={() => void load(true)} disabled={!open} aria-label="刷新 AI 运作状态">
            <Icon name="history" />
          </button>
          <button className="icon-button" type="button" onClick={onClose} disabled={!open} aria-label="关闭 AI 运作">
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="drawer-body">
        {state.status === "loading" && <p className="drawer-empty" role="status">正在读取真实状态…</p>}
        {state.status === "error" && (
          <div className="drawer-note problem" role="alert">
            <p>{state.message}</p>
            <button className="text-button" type="button" onClick={() => void load(true)}>重试</button>
          </div>
        )}
        {state.status === "ready" && state.source === "fallback" && state.fallback && (
          <>
            <div className="drawer-note">
              <p>汇总接口暂未就绪，已并行读取当前真实服务状态（更新时间 {state.fallback.asOf}）。尚未接入的明细保持如实留空。</p>
            </div>
            <Section title="教研团实时读数">
              <ul className="drawer-status-list">
                <li>
                  <span>后台教研整理</span>
                  <strong>
                    {state.fallback.research.status === "ready"
                      ? state.fallback.research.enabled
                        ? "已开启"
                        : "未开启"
                      : "暂时不可用"}
                  </strong>
                </li>
                <li>
                  <span>今日学习安排</span>
                  <strong>
                    {state.fallback.today.status === "ready"
                      ? state.fallback.today.resting
                        ? "今晚休息"
                        : `${state.fallback.today.itemCount} 项（约 ${state.fallback.today.totalMinutes} 分钟）`
                      : "暂时不可用"}
                  </strong>
                </li>
                <li>
                  <span>学习记录访问</span>
                  <strong>
                    {state.fallback.workspace.status === "ready"
                      ? `${state.fallback.workspace.recordCount} 条记录，已授权模型 ${state.fallback.workspace.authorizedProviders} 个`
                      : "暂时不可用"}
                  </strong>
                </li>
                <li>
                  <span>近期同伴会话</span>
                  <strong>
                    {state.fallback.conversations.status === "ready"
                      ? `${state.fallback.conversations.count} 段对话`
                      : "暂时不可用"}
                  </strong>
                </li>
              </ul>
              {state.fallback.research.status === "ready" && (state.fallback.research.settledUsdMicros || state.fallback.research.heldUsdMicros) && (
                <p className="drawer-hint">
                  教研已结算 {formatMicros(state.fallback.research.settledUsdMicros) ?? "$0.0000"}，预占 {formatMicros(state.fallback.research.heldUsdMicros) ?? "$0.0000"}。
                </p>
              )}
            </Section>
            <Section title="夜链与交班"><Empty text="暂未接入夜链交班摘要（等待 /api/ai/activity）。" /></Section>
            <Section title="工具调用与依据"><Empty text="暂未接入全局工具调用流；各轮对话依据可在学习同伴回复下方查看。" /></Section>
            <Section title="模型用量账本"><Empty text="暂未接入跨任务用量明细（等待 /api/ai/activity）。" /></Section>
            <Section title="待裁决提议"><Empty text="暂未接入全局待裁决汇总（等待 /api/ai/activity）。" /></Section>
          </>
        )}
        {state.status === "ready" && state.activity && (
          <>
            <Section title="运行中" count={state.activity.running.length}>
              {state.activity.running.length ? (
                <ul className="drawer-card-list">
                  {state.activity.running.map(item => (
                    <li key={item.id}>
                      <strong>{cleanHumanTitle(item.title)}</strong>
                      <span>{runningKindLabel(item.kind)} · {runningStateLabel(item)}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty text="现在没有运行中的任务。" />}
            </Section>
            <Section title="夜链与交班" count={state.activity.handoffs.length}>
              {state.activity.handoffs.length ? (
                <ul className="drawer-card-list">
                  {state.activity.handoffs.map(item => {
                    const heading = cleanHumanTitle(item.title || item.summary);
                    const meta = [
                      handoffChannelLabel(item),
                      handoffStatusLabel(item.status),
                      typeof item.basisCount === "number" && item.basisCount > 0 ? `依据 ${item.basisCount} 条` : null,
                    ].filter(Boolean).join(" · ");
                    const showSummary = Boolean(item.title && item.summary && item.summary !== item.title);
                    return (
                      <li key={item.id}>
                        {isSpaHref(item.href) ? (
                          <a href={item.href} onClick={event => {
                            event.preventDefault();
                            onNavigate(item.href!);
                          }}>{heading}</a>
                        ) : (
                          <strong>{heading}</strong>
                        )}
                        {showSummary && <span>{item.summary}</span>}
                        <span>{meta}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <Empty text="暂无交班记录。" />}
            </Section>
            <Section title="工具调用与依据" count={state.activity.recentTools.length}>
              {state.activity.recentTools.length ? (
                <ul className="drawer-card-list">
                  {state.activity.recentTools.map((item, index) => {
                    const headline = recentToolHeadline(item);
                    return (
                      <li key={`${item.turnId}-${item.step ?? index}`}>
                        {isSpaHref(item.href) ? (
                          <a href={item.href} onClick={event => {
                            event.preventDefault();
                            onNavigate(item.href!);
                          }}>{headline}</a>
                        ) : (
                          <strong>{headline}</strong>
                        )}
                        <span>{recentToolMeta(item)}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <Empty text="暂无工具调用。" />}
            </Section>
            <Section title="模型用量">
              <p className="drawer-metric">
                {formatMicros(state.activity.usage.spentMicros) ?? "$0.0000"}
                {typeof state.activity.usage.limitMicros === "number" && Number.isFinite(state.activity.usage.limitMicros)
                  ? ` / ${formatMicros(state.activity.usage.limitMicros)} USD`
                  : " USD（未设上限）"}
              </p>
              {((state.activity.usage.settledMicros ?? 0) > 0 || (state.activity.usage.heldMicros ?? 0) > 0) && (
                <p className="drawer-hint">
                  已结算 {formatMicros(state.activity.usage.settledMicros) ?? "$0.0000"} · 预占 {formatMicros(state.activity.usage.heldMicros) ?? "$0.0000"}
                </p>
              )}
              {state.activity.usage.recentCalls.length ? (
                <ul className="drawer-card-list">
                  {state.activity.usage.recentCalls.map(call => (
                    <li key={call.id}>
                      <strong>{call.label || call.purpose || "模型调用"}</strong>
                      <span>{usageCallMeta(call) || "已记录"}</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty text="暂无近期调用。" />}
            </Section>
            <Section title="待裁决提议" count={state.activity.pendingProposals.length}>
              {state.activity.pendingProposals.length ? (
                <ul className="drawer-card-list">
                  {state.activity.pendingProposals.map(item => {
                    const href = resolveProposalHref(item);
                    const heading = cleanHumanTitle(item.title);
                    return (
                      <li key={item.id}>
                        {href ? (
                          <a href={href} onClick={event => {
                            event.preventDefault();
                            onNavigate(href);
                          }}>{heading}</a>
                        ) : (
                          <strong>{heading}</strong>
                        )}
                        <span>{proposalKindLabel(item.kind)} · {item.summary}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : <Empty text="没有等待你裁决的提议。" />}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}
