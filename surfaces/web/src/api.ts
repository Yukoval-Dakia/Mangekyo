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

export interface TurnCarePause {
  triggered?: boolean;
  active?: boolean;
  reason?: string;
  scope?: string;
  durationHours?: number;
  version?: string;
}

export interface Turn {
  workspaceBasis?: readonly TurnWorkspaceWitness[];
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
  carePause?: TurnCarePause;
}

export function isCarePauseTurn(turn: Turn | undefined): boolean {
  return Boolean(turn?.carePause && (turn.carePause.triggered || turn.carePause.active));
}

export interface TurnWorkspaceWitness {
  readonly id: string;
  readonly rev: number;
  readonly epoch: string;
  readonly type: string;
  readonly mode?: 'pinned' | 'following';
  readonly writeBasis?: true;
  readonly jitBasis?: true;
  readonly title?: string;
  readonly kind?: string;
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
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
    readonly code?: string,
    readonly next?: string,
  ) {
    super(message);
  }
}

export interface GenerateTextbookInput {
  requestId: string;
  topic?: string;
  conceptId?: string;
  mode?: 'full' | 'cheatsheet';
}

export interface GenerateTextbookResponse {
  id: string;
  title: string;
  mode: 'full' | 'cheatsheet';
  blockCount: number;
  href: string;
  basisCount: number;
}

export function generatePersonalTextbook(input: GenerateTextbookInput) {
  return api<GenerateTextbookResponse>('/textbooks/generate', {method: 'POST', body: input});
}

export interface AuthorQuestionsInput {
  requestId: string;
  mode: 'concept_gap' | 'mistake_variant';
  conceptId?: string;
  sourceQuestionId?: string;
  attemptId?: string;
  count?: 1 | 2 | 3;
  issuePaper?: boolean;
  forceGenerate?: boolean;
  format?: QuestionAuthorFormat;
}

export type QuestionAuthorFormat = 'auto' | 'text' | 'interactive';

export interface AuthoredQuestionSummary {
  id: string;
  prompt: string;
  difficulty?: string;
  href: string;
  format?: 'text' | 'interactive';
  verification?: {
    status: 'verified' | 'conflict' | 'unverified';
    method: string;
    pythonChecked?: boolean;
    summary?: string;
  };
}

export interface AuthorQuestionsResponse {
  questions: AuthoredQuestionSummary[];
  paperId?: string;
  paperHref?: string;
  source?: 'variant_pool' | 'ai_authored';
  selectionPlan?: QuestionSelectionPlan;
}

// 与域 3 W2-1 契约精确对齐的可解释选题方案。
export interface SelectionPlanSelectedItem {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly prompt: string;
  readonly estMin: number;
  readonly infoGain: number | null;
  readonly reasonCode: 'probe-unknown' | 'reduce-uncertainty' | 'semantic-fallback';
  readonly reasonLabel: string;
  readonly uncertainty:
    | { readonly kind: 'unknown'; readonly reason: string; readonly needed: string }
    | { readonly kind: 'interval'; readonly low: number; readonly high: number }
    | null;
  readonly coveredConcepts: readonly string[];
  readonly matchReasons: readonly string[];
  readonly score: number;
  readonly novelty: 'same' | 'isomorphic' | 'transfer';
}

export interface SelectionPlanEliminatedItem {
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly reasonCode:
    | 'exposed_attempted' | 'exposed_posttest' | 'exposed_help'
    | 'variant_spoiled' | 'explicit_exclude' | 'over_budget'
    | 'low_info_gain' | 'unmapped_concepts' | 'duplicate_coverage';
  readonly reasonLabel: string;
  readonly detail: string;
  readonly estMin?: number;
  readonly infoGain?: number | null;
}

export interface SelectionPlanCoverageItem {
  readonly target: string;
  readonly conceptId?: string;
  readonly status: 'covered_high_gain' | 'covered_low_evidence' | 'uncovered_no_question' | 'uncovered_all_exposed';
  readonly statusLabel: string;
  readonly matchedQuestionIds: readonly string[];
}

export interface SelectionPlanGapItem {
  readonly kind: 'zero_question_concept' | 'all_exposed_need_variant' | 'error_stage_unaddressed' | 'budget_shortfall' | 'deriver_unavailable';
  readonly target?: string;
  readonly conceptId?: string;
  readonly errorStage?: string;
  readonly detail: string;
  readonly suggestedAction?: 'author_concept_gap' | 'author_mistake_variant';
}

export interface QuestionSelectionPlan {
  readonly selected: readonly SelectionPlanSelectedItem[];
  readonly eliminated: readonly SelectionPlanEliminatedItem[];
  readonly estimatedMinutes: number;
  readonly coverageReport: readonly SelectionPlanCoverageItem[];
  readonly gaps: readonly SelectionPlanGapItem[];
  readonly deriverStatus:
    | { readonly kind: 'ok'; readonly methodVersion: 'plan/information-gain@1' }
    | { readonly kind: 'unavailable'; readonly reason: string };
  readonly exposureLockCount: number;
}

export function describeAuthoringOrigin(response: AuthorQuestionsResponse): string | null {
  if (response.source === 'variant_pool') {
    return '秒开 · 命中题库未曝光同族变式';
  }
  const verified = response.questions.filter((question) => question.verification?.status === 'verified');
  if (verified.length > 0) {
    return verified.some((question) => question.verification?.pythonChecked)
      ? '已过独立双解 + Python 验算'
      : '已过独立双解验算';
  }
  return null;
}

export function authorIqdbQuestions(input: AuthorQuestionsInput) {
  return api<AuthorQuestionsResponse>('/iqdb/author', {method: 'POST', body: input});
}

export interface AuthoringUiError {
  kind: 'model_unavailable' | 'no_basis' | 'model_failed' | 'failed';
  message: string;
  actionHref?: string;
  actionLabel?: string;
}

export function describeAuthoringError(error: unknown): AuthoringUiError {
  if (error instanceof ApiError) {
    if (error.status === 503 || error.code === 'model_unavailable') return {
      kind: 'model_unavailable',
      message: '尚未配置可用的 AI 模型，请先前往设置配置模型后再试。',
      actionHref: '/me?section=settings',
      actionLabel: '前往配置模型',
    };
    if (error.status === 404) return {
      kind: 'no_basis',
      message: error.message || '当前还没有足够的学习资料或练习记录作为依据，请先交入资料或完成至少一次练习。',
      actionHref: '/intake',
      actionLabel: '去交入资料',
    };
    if (error.status === 502 || error.code === 'model_failed') return {
      kind: 'model_failed',
      message: error.message || 'AI 生成暂时失败，请稍后重试。',
    };
    return {kind: 'failed', message: error.message || '生成暂时失败，请稍后重试。'};
  }
  return {
    kind: 'failed',
    message: error instanceof Error && error.message ? error.message : '生成暂时失败，请检查网络后重试。',
  };
}

export async function api<T>(
  path: string,
  options: { method?: "POST" | "PUT"; body?: object; signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<T> {
  const body = options.body;
  let watermark:string|undefined;
  if (options.method === 'POST' && guardedPath(path)) {
    if (!body || !('requestId' in body) || typeof body.requestId !== 'string') throw new Error('缺少提交标识。');
    watermark = bindDeletionWatermark(body.requestId);
    if ('deletionWatermark' in body && body.deletionWatermark !== watermark)
      throw new Error('提交与原删除水位不符。');
    await synchronizeDeletion();
  }
  const response = await fetch(`/api${path}`, {
    ...(options.method && { method: options.method }),
    ...(options.cache && { cache: options.cache }),
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
      typeof failure?.code === 'string' ? failure.code : undefined,
      typeof failure?.next === 'string' ? failure.next : undefined);
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

export interface OnboardingStatus {
  completed: boolean;
  hasGoal: boolean;
  hasDisciplines: boolean;
  hasConcepts: boolean;
  hasQuestions: boolean;
  hasMemory: boolean;
  hasModel: boolean;
  currentDate: string;
  timeZone: string;
  goalText: string;
  disciplineCount: number;
  conceptCount: number;
  questionCount: number;
  upcomingExamCount: number;
}

export interface OnboardingQuickPrefs {
  stage?: string;
  dailyMinutes?: number;
  campaign?: 'steady' | 'sprint' | 'recovery';
  teachingStyle?: string;
}

export interface OnboardingProposeInput {
  profileText: string;
  timeZone: string;
  quickPrefs?: OnboardingQuickPrefs | undefined;
  mode?: 'llm' | 'offline_manual' | undefined;
}

export interface OnboardingCompletedExam {
  subject: string;
  examName: string;
  status: 'completed' | 'upcoming' | 'exempt';
  confidence: 'high' | 'needs_confirm';
  reason: string;
}

export interface OnboardingUpcomingExam {
  id: string;
  title: string;
  date: string;
  dateCertainty: 'exact' | 'estimated';
  scope: string[];
  weights: { topic: string; weight: number }[];
  note: string;
}

export interface OnboardingProposal {
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
    completedExams: OnboardingCompletedExam[];
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
}

export interface OnboardingProposeResponse {
  proposal: OnboardingProposal;
}

export type OnboardingStreamStageId =
  | 'connect'
  | 'profile_exams'
  | 'disciplines_plan'
  | 'knowledge_graph'
  | 'starter_questions'
  | 'verify';

export type OnboardingStreamFindingKind =
  | 'subject'
  | 'exam'
  | 'discipline'
  | 'concept'
  | 'edge'
  | 'question'
  | 'goal'
  | 'repair';

export type OnboardingStreamEvent =
  | { event: 'meta'; data: { model?: string; currentDate?: string; timeZone?: string } }
  | { event: 'stage'; data: { stage: OnboardingStreamStageId; status: 'active' | 'done' | 'error'; detail?: string } }
  | { event: 'thinking'; data: { stage: OnboardingStreamStageId; delta: string } }
  | { event: 'finding'; data: { stage: OnboardingStreamStageId; kind: OnboardingStreamFindingKind; label: string; detail?: string } }
  | { event: 'done'; data: { proposal: OnboardingProposal; mode?: 'llm' | 'offline_manual' } }
  | { event: 'error'; data: { message: string; code?: string; stage?: OnboardingStreamStageId; next?: string } };

export interface OnboardingStreamResult {
  proposal: OnboardingProposal;
  mode?: 'llm' | 'offline_manual' | undefined;
}

function onboardingStreamFailure(
  message: string,
  code?: string,
  next?: string,
  stage?: OnboardingStreamStageId,
): ApiError & { stage?: OnboardingStreamStageId } {
  const failure = new ApiError(0, message, code, next) as ApiError & { stage?: OnboardingStreamStageId };
  if (stage) failure.stage = stage;
  return failure;
}

/**
 * POST /api/onboarding/propose/stream 的健壮 SSE 消费。
 * 服务端尚未部署流式端点（404/405）时优雅回退到同步 proposeOnboarding；
 * 回退路径只透传真实 connect 阶段与 done，绝不伪造思考文本。
 */
export async function proposeOnboardingStream(
  input: OnboardingProposeInput,
  onEvent: (event: OnboardingStreamEvent) => void,
  signal?: AbortSignal,
): Promise<OnboardingStreamResult> {
  const response = await fetch('/api/onboarding/propose/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });

  if (response.status === 404 || response.status === 405) {
    onEvent({ event: 'stage', data: { stage: 'connect', status: 'active', detail: '正在请求方案生成…' } });
    const fallback = await proposeOnboarding(input, signal);
    const result: OnboardingStreamResult = {
      proposal: fallback.proposal,
      mode: fallback.proposal.meta?.source === 'offline_manual' ? 'offline_manual' : 'llm',
    };
    onEvent({ event: 'done', data: { proposal: result.proposal, ...(result.mode ? { mode: result.mode } : {}) } });
    return result;
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    const stage = typeof failure?.stage === 'string' ? (failure.stage as OnboardingStreamStageId) : undefined;
    const message = typeof failure?.error === 'string' && failure.error
      ? failure.error
      : `推演请求失败（HTTP ${response.status}）。`;
    const code = typeof failure?.code === 'string' ? failure.code : undefined;
    const next = typeof failure?.next === 'string' ? failure.next : undefined;
    onEvent({ event: 'error', data: { message, ...(code ? { code } : {}), ...(stage ? { stage } : {}), ...(next ? { next } : {}) } });
    const error = new ApiError(response.status, message, code, next) as ApiError & { stage?: OnboardingStreamStageId };
    if (stage) error.stage = stage;
    throw error;
  }

  if (!response.body) {
    throw onboardingStreamFailure('推演流不可用，请重试。');
  }
  if (!contentType.includes('text/event-stream')) {
    // 兼容服务端以 JSON 直出 { proposal } 的降级响应。
    const fallback = await response.json().catch(() => null);
    const proposal = (fallback as OnboardingProposeResponse | null)?.proposal;
    if (proposal) {
      const mode = proposal.meta?.source === 'offline_manual' ? 'offline_manual' : 'llm';
      onEvent({ event: 'done', data: { proposal, mode } });
      return { proposal, mode };
    }
    throw onboardingStreamFailure('推演响应格式无法识别，请重试。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished: OnboardingStreamResult | null = null;

  const dispatchFrame = (frame: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return; // 心跳或非 JSON 帧安全跳过
    }
    const streamEvent = { event: eventName, data: payload } as OnboardingStreamEvent;
    onEvent(streamEvent);
    if (streamEvent.event === 'done') {
      finished = { proposal: streamEvent.data.proposal, mode: streamEvent.data.mode };
    } else if (streamEvent.event === 'error') {
      const data = streamEvent.data;
      throw onboardingStreamFailure(
        typeof data?.message === 'string' && data.message ? data.message : '推演暂时失败，请重试。',
        data?.code,
        data?.next,
        data?.stage,
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.trim()) dispatchFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatchFrame(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!finished) {
    throw onboardingStreamFailure('推演流意外中断，未收到完成事件，请重试。');
  }
  return finished;
}

export interface OnboardingApplyInput {
  requestId: string;
  proposal: OnboardingProposal;
}

export interface OnboardingApplyResponse {
  applied: {
    goalId: string;
    ruleCount: number;
    disciplineCount: number;
    conceptCount: number;
    edgeCount: number;
    questionCount: number;
    memoryUpdated: boolean;
    skippedExistingConcepts: number;
  };
  links: {
    today: string;
    graph: string;
    bank: string;
    companion: string;
    me: string;
  };
}

export function onboardingStatus() {
  return api<OnboardingStatus>('/onboarding/status', { cache: 'no-store' });
}

export function proposeOnboarding(input: OnboardingProposeInput, signal?: AbortSignal) {
  return api<OnboardingProposeResponse>('/onboarding/propose', {
    method: 'POST',
    body: input,
    ...(signal ? { signal } : {}),
  });
}

export function applyOnboarding(input: OnboardingApplyInput) {
  return api<OnboardingApplyResponse>('/onboarding/apply', {
    method: 'POST',
    body: { requestId: input.requestId, proposal: input.proposal },
  });
}

export interface ResearchMaintenanceRunResponse {
  ran: boolean;
  reason: string;
  rationale?: string;
  proposedEdges: number;
  prepNoteId?: string | null;
}

export function runResearchMaintenance(signal?: AbortSignal) {
  return api<ResearchMaintenanceRunResponse>('/research/maintenance/run', {
    method: 'POST',
    body: { requestId: requestId() },
    ...(signal ? { signal } : {}),
  });
}

export type RecordFlowMasteryLevel = 'unknown' | 'fragile' | 'developing' | 'solid';

export interface RecordFlowIdentity {
  id: string;
  rev: number;
  kind: string;
  title: string;
  subject?: string;
  updatedAt: string | null;
  author: string;
}

export interface RecordFlowMastery {
  level: RecordFlowMasteryLevel;
  score: number | null;
  retrievability: number | null;
  evidenceCount: number;
}

export interface RecordFlowMisconception {
  id: string;
  summary: string;
  errorStage?: string;
  status: string;
  supportCount: number;
  contradictCount: number;
  evidenceHref?: string;
}

export interface RecordFlowAttempt {
  paperId: string;
  paperTitle: string;
  attemptId: string;
  itemId: string;
  verdict: string;
  errorStage?: string;
  scoreText?: string;
  occurredAt: string | null;
  href: string;
}

export interface RecordFlowDiscussion {
  sessionId: string;
  turnId: string;
  title: string;
  excerpt: string;
  occurredAt: string | null;
  href: string;
}

export interface RecordFlowProvenance {
  readonly id: string;
  readonly rev?: number;
  readonly kind: string;
  readonly title: string;
  readonly relation: string;
  readonly originBadge: string;
  readonly excerpt?: string;
  readonly href: string | null;
}

export interface RecordFlowNeighbor {
  id: string;
  title: string;
  kind: string;
  relation: string;
  direction: 'in' | 'out';
  href: string;
}

export interface RecordFlowNextAction {
  kind: 'practice' | 'review_mistake' | 'ask_companion' | 'open_graph';
  label: string;
  href: string;
}

export interface RecordFlowView {
  identity: RecordFlowIdentity;
  mastery: RecordFlowMastery;
  misconceptions: readonly RecordFlowMisconception[];
  attempts: readonly RecordFlowAttempt[];
  discussions: readonly RecordFlowDiscussion[];
  graphNeighbors: readonly RecordFlowNeighbor[];
  nextActions: readonly RecordFlowNextAction[];
  readonly provenance?: readonly RecordFlowProvenance[];
  readonly derived?: readonly RecordFlowProvenance[];
}

export interface WorkspaceRecordFlowSummary {
  masteryLevel?: RecordFlowMasteryLevel;
  errorStageCount: number;
  attemptCount: number;
  discussionCount: number;
  neighborCount: number;
  conceptTags: readonly string[];
  readonly originLabel?: string;
}

export function workspaceRecordFlow(id: string, signal?: AbortSignal) {
  return api<RecordFlowView>('/workspace/records/' + encodeURIComponent(id) + '/flow', signal ? { signal } : {});
}

export type GraphQuickPaperResponse =
  | {
      kind: 'paper';
      paperId: string;
      title: string;
      questionCount: number;
      reason?: string;
      href: string;
    }
  | {
      kind: 'empty';
      suggestedAction?: string;
      reason?: string;
    };

export function issueGraphQuickPaper(nodeId: string, id = requestId()) {
  return api<GraphQuickPaperResponse>(
    `/knowledge/graph/${encodeURIComponent(nodeId)}/quick-paper`,
    { method: 'POST', body: { requestId: id } },
  );
}
