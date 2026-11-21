import { api, ApiError } from "../api";

export type AiRunningItem = {
  id: string;
  kind: string;
  title: string;
  state?: "queued" | "running" | "waiting" | "blocked" | string;
  status?: string;
  slotType?: string;
  slotKey?: string;
  deriver?: string;
  requestedTick?: string;
  generation?: number;
  workerProfile?: string | null;
  chainId?: string | null;
  hopCount?: number | null;
  startedAt?: string;
  targetRef?: string;
};

export type AiHandoffItem = {
  id: string;
  channel?: "night_chain" | "research" | "retention" | "notion" | string;
  kind?: string;
  status: string;
  title?: string;
  summary: string;
  tick?: string;
  basisCount?: number;
  href?: string | null;
  completedAt?: string;
  targetRef?: string;
};

export type AiRecentToolItem = {
  turnId: string;
  sessionId: string;
  caseId?: string;
  tick?: string;
  model?: string;
  tools?: string[];
  toolCount?: number;
  basisCount: number;
  writeCount?: number;
  href?: string | null;
  step?: number;
  tool?: string;
  summary?: string;
  status?: string;
  occurredAt?: string;
};

export type AiUsageCallItem = {
  id: string;
  ownerKind?: "derivation" | "session" | string;
  ownerId?: string;
  stepKey?: string;
  label?: string;
  state?: "started" | "done" | "unknown" | string;
  route?: string | null;
  reservedMicros?: number | null;
  actualMicros?: number | null;
  startedTick?: string;
  endedTick?: string | null;
  purpose?: string;
  model?: string;
  costMicros?: number;
  status?: string;
  occurredAt?: string;
};

export type AiProposalAction = {
  method: string;
  path: string;
  body?: Record<string, unknown>;
};

export type AiPendingProposalItem = {
  id: string;
  kind: string;
  commandType?: string;
  status?: string;
  title: string;
  summary: string;
  targetId?: string | null;
  createdTick?: string;
  actions?: {
    accept?: AiProposalAction;
    reject?: AiProposalAction;
    inspect?: { method: string; path: string };
  };
  actionPath?: string;
  createdAt?: string;
};

export type AiActivity = {
  asOf: string;
  running: AiRunningItem[];
  handoffs: AiHandoffItem[];
  recentTools: AiRecentToolItem[];
  usage: {
    currency: "USD_MICROS";
    spentMicros: number;
    settledMicros?: number;
    heldMicros?: number;
    limitMicros: number | null;
    recentCalls: AiUsageCallItem[];
  };
  pendingProposals: AiPendingProposalItem[];
};

export type ActivityFallback = {
  asOf: string;
  research:
    | { status: "ready"; enabled: boolean; hasBudget: boolean; settledUsdMicros?: string; heldUsdMicros?: string }
    | { status: "unavailable" };
  today:
    | { status: "ready"; day: string; itemCount: number; totalMinutes: number; resting: boolean }
    | { status: "unavailable" };
  workspace:
    | { status: "ready"; recordCount: number; activeProviderLabel: string | null; authorizedProviders: number }
    | { status: "unavailable" };
  conversations:
    | { status: "ready"; count: number }
    | { status: "unavailable" };
};

type ResearchSettingsSnapshot = {
  enabled?: boolean;
  scoutBudget?: unknown;
  heldUsdMicros?: string;
  settledUsdMicros?: string;
};

type TodaySnapshot = {
  day?: string;
  resting?: boolean;
  totalMinutes?: number;
  protectedItems?: unknown[];
  items?: unknown[];
};

type WorkspaceAccessSnapshot = {
  items?: unknown[];
  activeProviderId?: string;
  providers?: { id: string; label?: string; model?: string; active?: boolean; authorized?: boolean }[];
};

let directEndpointUnavailable = false;

export async function readAiActivity(signal: AbortSignal, forceProbe = false) {
  if (!directEndpointUnavailable || forceProbe) {
    try {
      const activity = await api<AiActivity>("/ai/activity", { signal });
      directEndpointUnavailable = false;
      return { source: "direct" as const, activity };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      directEndpointUnavailable = true;
    }
  }

  const todayQuery = new URLSearchParams({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  });
  const [researchData, todayData, workspaceData, conversationData] = await Promise.all([
    api<ResearchSettingsSnapshot>("/research/settings", { signal }).catch(() => null),
    api<TodaySnapshot>(`/today?${todayQuery}`, { signal }).catch(() => null),
    api<WorkspaceAccessSnapshot>("/workspace/access", { signal }).catch(() => null),
    api<unknown[]>("/conversations", { signal }).catch(() => null),
  ]);

  const activeProvider = workspaceData?.providers?.find(
    provider => provider.active || provider.id === workspaceData.activeProviderId,
  );
  const authorizedProviders = workspaceData?.providers?.filter(provider => provider.authorized).length ?? 0;

  return {
    source: "fallback" as const,
    fallback: {
      asOf: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      research: researchData
        ? {
            status: "ready",
            enabled: Boolean(researchData.enabled),
            hasBudget: Boolean(researchData.scoutBudget),
            ...(typeof researchData.settledUsdMicros === "string" ? { settledUsdMicros: researchData.settledUsdMicros } : {}),
            ...(typeof researchData.heldUsdMicros === "string" ? { heldUsdMicros: researchData.heldUsdMicros } : {}),
          }
        : { status: "unavailable" },
      today: todayData
        ? {
            status: "ready",
            day: typeof todayData.day === "string" ? todayData.day : "",
            itemCount: (Array.isArray(todayData.protectedItems) ? todayData.protectedItems.length : 0)
              + (Array.isArray(todayData.items) ? todayData.items.length : 0),
            totalMinutes: typeof todayData.totalMinutes === "number" ? todayData.totalMinutes : 0,
            resting: Boolean(todayData.resting),
          }
        : { status: "unavailable" },
      workspace: workspaceData
        ? {
            status: "ready",
            recordCount: Array.isArray(workspaceData.items) ? workspaceData.items.length : 0,
            activeProviderLabel: activeProvider?.label || activeProvider?.model || null,
            authorizedProviders,
          }
        : { status: "unavailable" },
      conversations: Array.isArray(conversationData)
        ? { status: "ready", count: conversationData.length }
        : { status: "unavailable" },
    } satisfies ActivityFallback,
  };
}
