export interface TeachingCase {
  id: string;
  title: string;
  description: string;
  question: string;
  initialAnswer: string;
}

export type ProviderProtocol = "openai" | "anthropic";

export interface ProviderProfileSummary {
  id: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  model: string;
  reasoningEffort: string;
  hasKey: boolean;
}

export interface McpServerSummary {
  id: string;
  label?: string;
  url: string;
  allowedTools: string[];
  enabled: boolean;
  hasToken: boolean;
}

export interface Settings {
  routes?: Partial<Record<"companion"|"preparation"|"diagnostic"|"assessment", string>>;
  baseUrl: string;
  model: string;
  protocol: ProviderProtocol;
  reasoningEffort: string;
  activeProviderId: string;
  providers: ProviderProfileSummary[];
  mcpServers: McpServerSummary[];
  hasKey: boolean;
  hasExaKey: boolean;
  allowSearch: boolean;
}

export interface ProviderProfileInput {
  id?: string;
  label?: string;
  baseUrl?: string;
  protocol?: ProviderProtocol;
  model?: string;
  reasoningEffort?: string;
  apiKey?: string;
}

export interface McpServerInput {
  id?: string;
  label?: string;
  url?: string;
  token?: string;
  allowedTools?: string[];
  enabled?: boolean;
}

export interface SettingsUpdate {
  routes?: Settings["routes"];
  activeProviderId?: string;
  providers?: ProviderProfileInput[];
  mcpServers?: McpServerInput[];
  exaApiKey?: string;
  allowSearch?: boolean;
  baseUrl?: string;
  apiKey?: string;
  protocol?: ProviderProtocol;
  model?: string;
  reasoningEffort?: string;
}

export type StudyAttachment = { id: string; title: string; text: string; mode: 'ask' | 'prepare' };
export interface Turn {
  turnId?: string;
  artifacts?: unknown;
  trace?: string[];
  writes?: {id: string; rev: number; title: string; observation?:
    {status: 'saved'; text: string; undo_token: string} | {status: 'changed'} | {status: 'withdrawn'}}[];
  recall?: { title: string; lesson: string; items: import('./recall-cards').RecallItem[] };
  answer?: string;
  action: "diagnostic_question" | "transfer_question" | "targeted_explanation" | "clarifying_question" | "companion_reply";
  rationale: string;
  message: string;
  reads: { id: string; title: string; text: string; workspace?: boolean }[];
  evidenceIds: string[];
  model: string;
  reasoningEffort?: string;
  reportedModel?: string;
}

export interface Session {
  artifacts?: unknown;
  attachment?: StudyAttachment;
  id: string;
  caseId: string;
  turns: Turn[];
  status: "pending" | "ready" | "failed" | "unknown";
  error?: string;
  pendingAnswer?: string;
  currentTurnId?: string | null;
}

export type SessionEvent = {
  session: Pick<Session, "id" | "caseId" | "status" | "currentTurnId" | "pendingAnswer">;
  phase?: "queued" | "thinking" | "reading" | "checking" | "replying";
  message?: string;
};

export function sessionEvents(id: string) {
  return new EventSource(`/api${sessionPath(id)}/events`);
}

export class ApiError extends Error {
  constructor(readonly status: number, message = `HTTP ${status}`) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: "POST" | "PUT"; body?: object; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...(options.method && { method: options.method }),
    ...(options.signal && { signal: options.signal }),
    ...(options.body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.body),
    }),
  });
  if (!response.ok) {
    const message = await response.json().then(
      (value) => typeof value?.error === "string" ? value.error : undefined,
      () => undefined,
    );
    throw new ApiError(response.status, message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function sessionPath(id: string) {
  return `/sessions/${encodeURIComponent(id)}`;
}

export function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  // A local HTTP installation may not expose randomUUID outside localhost.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const parts = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${parts.slice(0, 8)}-${parts.slice(8, 12)}-4${parts.slice(13, 16)}-8${parts.slice(17, 20)}-${parts.slice(20)}`;
}

export function remembered(key: string) {
  try {
    return localStorage.getItem(`mangekyo:${key}`);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(`mangekyo:${key}`);
    else localStorage.setItem(`mangekyo:${key}`, value);
  } catch {
    // The current conversation still works when storage is disabled.
  }
}
