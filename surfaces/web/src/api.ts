import { mountQuery, type PartialMountPermissions } from './presentation/mount-coverage.ts';
import { bindDeletionWatermark, guardedPath, recordNewSubmission, synchronizeDeletion, verifyGenerationReceipt } from './deletion-watermark';
export interface TeachingCase {
  id: string;
  title: string;
  description: string;
  question: string;
  initialAnswer: string;
}

export type ProviderProtocol = "openai" | "anthropic";

export interface ProviderProfileSummary {
  accountRevision?: string;
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
  accountRevision?: string;
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
export type PageWrite =
  | {status: 'saved'; undo_token: string}
  | {status: 'proposed'; proposalId: string}
  | {status: 'withdrawn' | 'reverted' | 'changed'};

export type RelationWrite =
  | {status: 'saved'; undo_token: string}
  | {status: 'proposed'; proposalId: string}
  | {status: 'withdrawn' | 'changed'};

export interface Turn {
  backgroundUnderstanding?: {allowed: boolean; rev: number; accessEpoch: string};
  turnId?: string;
  artifacts?: unknown;
  trace?: string[];
  writes?: {id: string; rev: number; title: string; page?: PageWrite; relation?: RelationWrite; observation?:
    {status: 'saved'; text: string; undo_token: string} | {status: 'changed'} | {status: 'withdrawn'};
    memory?: {status: 'saved'; action: 'remember' | 'correct' | 'forget'; undo_token: string} |
      {status: 'changed'} | {status: 'withdrawn'}}[];
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

export interface Session extends PartialMountPermissions {
  currentObject?: import("./current-record").BoundObject;
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

export type SessionEvent = PartialMountPermissions & {
  authorizedMountIds?: string[];
  session: Pick<Session, "id" | "caseId" | "status" | "currentTurnId" | "pendingAnswer">;
  phase?: "queued" | "thinking" | "reading" | "checking" | "replying";
  message?: string;
};

export function sessionEvents(id: string, known: string[]) {
  return new EventSource(mountQuery(`/api${sessionPath(id)}/events`, known));
}

export class ApiError extends Error {
  constructor(readonly status: number, message = `HTTP ${status}`, readonly code?: string) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: "POST" | "PUT"; body?: object; signal?: AbortSignal } = {},
): Promise<T> {
  const body = options.body;
  let watermark:string|undefined;
  if (options.method === 'POST' && guardedPath(path)) {
    if (!body || !('requestId' in body) || typeof body.requestId !== 'string') throw new Error('缺少提交标识。');
    watermark = bindDeletionWatermark(body.requestId);
    await synchronizeDeletion();
  }
  const response = await fetch(`/api${path}`, {
    ...(options.method && { method: options.method }),
    ...(options.signal && { signal: options.signal }),
    ...(options.body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(watermark === undefined ? body : {...body,deletionWatermark:watermark}),
    }),
  });
  if (watermark !== undefined) verifyGenerationReceipt(response,watermark);
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new ApiError(response.status, typeof failure?.error === 'string' ? failure.error : undefined,
      typeof failure?.code === 'string' ? failure.code : undefined);
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

export function submissionId() { return recordNewSubmission(requestId()); }

export function deletedSubmission(error:unknown) {
  return error instanceof ApiError && (error.status === 410 || error.code === 'deletion_watermark_stale');
}
