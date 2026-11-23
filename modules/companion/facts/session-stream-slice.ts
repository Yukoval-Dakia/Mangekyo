import { isJson, type Json } from '@mangekyo/kernel';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (value: unknown): value is string => typeof value === 'string' && ULID.test(value);
export type SessionStatus = 'pending' | 'ready' | 'failed' | 'unknown';
export type ErrorDescriptor = { readonly status: number; readonly message: string; readonly code?: string };
export const confirmedAccountError = (): ErrorDescriptor =>
  ({ status: 409, message: '请重新选择材料或开始新对话，并确认当前模型账户。', code: 'provider_account_confirmation_required' });

// --- SSE / stream primitives -------------------------------------------------

export const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
} as const;

export function sseEvent(name: string, id: string | undefined, payload: object): string {
  return (id ? 'id: ' + id + '\n' : '') + 'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n';
}

export type SessionDelta = { readonly session: string; readonly turnId: string; readonly seq: number; readonly delta: string };

export function isSessionDelta(value: unknown): value is SessionDelta {
  return Boolean(value && typeof value === 'object' && typeof (value as SessionDelta).session === 'string' &&
    typeof (value as SessionDelta).turnId === 'string' && typeof (value as SessionDelta).seq === 'number' &&
    typeof (value as SessionDelta).delta === 'string');
}

export function chunkSessionDelta(delta: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of delta) {
    if (chunk && new TextEncoder().encode(chunk + character).length > 1000) (chunks.push(chunk), chunk = character);
    else chunk += character;
  }
  chunks.push(chunk);
  return chunks;
}

// --- Stream event assembly ---------------------------------------------------

export type StreamSession = { readonly id: string; readonly caseId: string; readonly currentTurnId: string; readonly status: SessionStatus; readonly pendingAnswer?: string };

export function buildStreamSession(sessionId: string, turnId: string, status: SessionStatus,
  submission: { readonly caseId: string; readonly classroom?: unknown; readonly answer?: string | null }): StreamSession {
  return { id: sessionId, caseId: submission.caseId, currentTurnId: turnId, status,
    ...(status !== 'ready' && !submission.classroom && submission.answer ? { pendingAnswer: submission.answer } : {}) };
}

export function resolveStreamTurnState(lastErrorStatus: 'failed' | 'unknown' | null, settled: boolean, message: string | null): SessionStatus {
  return lastErrorStatus ?? (settled || message !== null ? 'ready' : 'pending');
}

export type MountPermissionData = { readonly mountPermissionsPartial?: true; readonly unconfirmedMountIds?: string[] };

export function mountPermissionData(unconfirmed: readonly string[], known: ReadonlySet<string>): MountPermissionData {
  return unconfirmed.length ? { mountPermissionsPartial: true as const, unconfirmedMountIds: unconfirmed.filter(id => known.has(id)) } : {};
}

export function buildProgressEventId(input: { readonly currentTurnId: string; readonly revision: number | null; readonly hasDraft: boolean; readonly artifacts: readonly { readonly mountId: string; readonly viewSeq: unknown }[]; readonly partial: MountPermissionData }): string {
  return [input.currentTurnId, input.revision ?? 0, Number(input.hasDraft), ...input.artifacts.map(a => a.mountId + '-' + a.viewSeq),
    ...(input.partial.mountPermissionsPartial ? ['partial', ...(input.partial.unconfirmedMountIds ?? [])] : [])].join(':');
}

export function buildProgressEventData(input: { readonly session: StreamSession; readonly phase: string | null; readonly artifacts: readonly { readonly mountId: string }[]; readonly partial: MountPermissionData; readonly draft: string | null }) {
  return { session: input.session, phase: input.phase ?? 'queued', authorizedMountIds: input.artifacts.map(a => a.mountId), ...input.partial, ...(input.draft ? { message: input.draft } : {}) };
}

export function buildCompleteEventData(session: StreamSession, message: string | null | undefined, recall: unknown) {
  return { session, ...(message ? { message } : {}), ...(recall ? { recall } : {}) };
}

// --- Session projection ------------------------------------------------------

export function projectTurnSubmission<T extends { readonly classroom?: unknown; readonly attachment?: unknown }>(stored: T, materialAvailable: boolean) {
  const { attachment: _attachment, ...withoutAttachment } = stored;
  if (stored.classroom) return { ...withoutAttachment, answer: null };
  return materialAvailable ? stored : withoutAttachment;
}

export function visibleTimelineTurnIds<T extends { readonly id: string; readonly feedback: unknown; readonly status: SessionStatus }>(timeline: readonly T[]): string[] {
  const last = timeline.at(-1);
  return timeline.filter(row => row.feedback || (row === last && row.status === 'pending')).map(row => row.id);
}

export function recoveryTurnIds<T extends { readonly id: string; readonly feedback: { readonly action?: string } | null }>(timeline: readonly T[]): string[] {
  return timeline.filter(row => !row.feedback || row.feedback.action === 'reply_unavailable').map(row => row.id);
}

export function buildSessionProjectionHead(input: { readonly sessionId: string; readonly lastId: string; readonly lastStatus: SessionStatus; readonly lastError?: string | undefined; readonly caseId: string; readonly pendingAnswer: string | null | undefined; readonly backgroundUnderstanding: unknown; readonly firstAttachment: unknown; readonly currentObjectView: { readonly alias: string; readonly id: string; readonly rev: number } | undefined; readonly pendingArtifacts: readonly unknown[]; readonly mountFields: MountPermissionData }) {
  return { id: input.sessionId, caseId: input.caseId, currentTurnId: input.lastId,
    ...(input.backgroundUnderstanding ? { backgroundUnderstanding: input.backgroundUnderstanding } : {}),
    ...(input.firstAttachment ? { attachment: input.firstAttachment } : {}),
    ...(input.currentObjectView ? { currentObject: input.currentObjectView } : {}),
    status: input.lastStatus,
    ...(input.lastStatus !== 'ready' && input.pendingAnswer ? { pendingAnswer: input.pendingAnswer } : {}),
    ...(input.lastError ? { error: input.lastError } : {}),
    ...(input.lastStatus === 'pending' ? { artifacts: input.pendingArtifacts } : {}),
    ...input.mountFields };
}

// --- Session request validation ----------------------------------------------

export function checkSessionStartInput(input: { readonly personal: boolean; readonly question: unknown; readonly hasShared: boolean }): ErrorDescriptor | null {
  if (input.personal && (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4000))
    return { status: 400, message: '请输入 1 至 4000 字的问题。' };
  if (input.hasShared && !input.personal) return { status: 400, message: '请在自由对话中使用个人材料。' };
  return null;
}

export function checkSessionAnswerInput(input: { readonly answer: unknown; readonly parent: unknown }): ErrorDescriptor | null {
  if (typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 4000)
    return { status: 400, message: '请输入 1 至 4000 字的回答。' };
  if (!isUlid(input.parent)) return { status: 400, message: '提交时须指明当前问题。' };
  return null;
}

export function checkSessionReplyGuard(input: { readonly lastExists: boolean; readonly lastIsClassroom: boolean; readonly lastIdMatches: boolean; readonly lastStatus: SessionStatus }): ErrorDescriptor | null {
  if (!input.lastExists) return { status: 404, message: '学习会话不存在。' };
  if (input.lastIsClassroom) return { status: 409, message: '请在课堂步骤内完成学习活动。' };
  if (!input.lastIdMatches) return { status: 409, message: '此题已有回答，请刷新后查看下一步。' };
  if (input.lastStatus !== 'ready') return { status: 409, message: '请先等同伴完成这一轮。' };
  return null;
}

// --- Turn submission ---------------------------------------------------------

export function resolveRequestedAccount(route: unknown): unknown {
  return route && typeof route === 'object' && 'accountRevision' in route ? (route as { accountRevision?: unknown }).accountRevision : undefined;
}

export type TurnRouteGuard = { readonly kind: 'ok' | 'confirm-account' | 'route-changed' | 'bound-route' };

export function resolveTurnRouteGuard(input: {
  readonly protectedTurn: boolean;
  readonly suppliedAccountRevision: unknown;
  readonly accountRevision: string | undefined;
  readonly originHasConfirmation: boolean;
  readonly routeMatchesSettings: boolean;
  readonly originMatchesSettings: boolean;
  readonly hasOrigin: boolean;
}): TurnRouteGuard {
  if (input.protectedTurn || input.suppliedAccountRevision !== undefined) {
    if (!input.accountRevision || input.suppliedAccountRevision !== input.accountRevision ||
        (input.protectedTurn && input.hasOrigin && !input.originHasConfirmation) ||
        !input.routeMatchesSettings || (input.hasOrigin && !input.originMatchesSettings)) return { kind: 'confirm-account' };
    return { kind: 'ok' };
  }
  if (!input.routeMatchesSettings) return { kind: 'route-changed' };
  if (input.hasOrigin && !input.originMatchesSettings) return { kind: 'bound-route' };
  return { kind: 'ok' };
}

export function resolveLearningToolsVersion(input: { readonly workspaceRevision: string | undefined; readonly accountRevision: string | undefined; readonly suppliedAccountRevision: unknown; readonly hasJit: boolean; readonly grantsLength: number | undefined; readonly originLearningToolsVersion: number | undefined; readonly hasOrigin: boolean }): number | undefined {
  return input.workspaceRevision && input.accountRevision && input.suppliedAccountRevision === input.accountRevision &&
    !input.hasJit && !input.grantsLength && (!input.hasOrigin || input.originLearningToolsVersion === 1) ? 1 : undefined;
}

export function resolveProtectedTurn(input: { readonly originAttachment: unknown; readonly originJitContextVersion: unknown; readonly attachment: unknown; readonly jitCounterId: unknown; readonly accountRevision: string | undefined }): boolean {
  return Boolean(input.originAttachment || input.originJitContextVersion || input.attachment || input.jitCounterId || input.accountRevision);
}

export function checkCurrentObjectRequest(input: { readonly selected: string; readonly hasOriginAttachment: boolean; readonly hasAttachment: boolean; readonly workspaceRevision: string | undefined }): ErrorDescriptor | null {
  if (input.selected !== 'companion' || input.hasOriginAttachment || input.hasAttachment)
    return { status: 400, message: '当前学习对象只用于未附选段的自由对话。' };
  if (!input.workspaceRevision) return { status: 403, message: '此模型未获准访问学习工作区。' };
  return null;
}

export function buildSubmitTurnData<TAttachment, TBoundObject, TGrants>(input: {
  readonly selected: string; readonly session: string; readonly parent: string | null; readonly answer: string | null;
  readonly allowBackgroundUnderstanding: boolean | undefined; readonly attachment: TAttachment; readonly attachmentBasisDigest: string | undefined;
  readonly boundObject: TBoundObject; readonly learningToolsVersion: number | undefined; readonly jitCounterId: string | undefined;
  readonly accountRevision: string | undefined; readonly workspaceRevision: string | undefined; readonly grantsLength: number | undefined;
  readonly settings: { readonly model: string; readonly reasoningEffort?: string; readonly activeProviderId: string; readonly protocol?: string; readonly allowSearch?: boolean; readonly baseUrl: string };
  readonly mcpRevision: string | undefined; readonly grants: TGrants;
}) {
  return { caseId: input.selected, sessionId: input.session, parentId: input.parent, answer: input.answer,
    ...(input.allowBackgroundUnderstanding ? { allowBackgroundUnderstanding: true } : {}),
    ...(input.attachmentBasisDigest ? { attachment: input.attachment, attachmentBasis: input.attachmentBasisDigest } : {}),
    ...(input.boundObject ? { currentObject: input.boundObject } : {}),
    ...(input.learningToolsVersion ? { learningToolsVersion: input.learningToolsVersion } : {}),
    ...(input.jitCounterId ? { jitContextVersion: 1, jitCounterId: input.jitCounterId } : {}),
    ...(input.accountRevision ? { accountRevision: input.accountRevision, accountConfirmation: 1 } : {}),
    ...((input.selected === 'companion' || input.selected === 'riding') ? { agentVersion: input.workspaceRevision ? 2 : 1, allowSearch: input.settings.allowSearch } : {}),
    ...(input.workspaceRevision ? { workspaceRevision: input.workspaceRevision, ...(!input.grantsLength && { memoryVersion: 1 }) } : {}),
    model: input.settings.model, reasoningEffort: input.settings.reasoningEffort, providerId: input.settings.activeProviderId, protocol: input.settings.protocol,
    ...(input.grantsLength ? { mcpGrants: input.grants, mcpRevision: input.mcpRevision } : {}),
    baseUrl: input.settings.baseUrl };
}

// --- Artifact mount / action validation --------------------------------------

export function checkMountArgs(input: { readonly viewOk: boolean; readonly viewError?: string | undefined; readonly predictionPrompt: unknown; readonly hasSentenceBreaks: boolean }): { readonly ok: true } | { readonly ok: false; readonly field: string; readonly message: string } {
  if (!input.viewOk) return { ok: false, field: 'view', message: input.viewError ?? '作品视图无效。' };
  const prompt = input.predictionPrompt;
  if (prompt !== null && prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 160))
    return { ok: false, field: 'predictionPrompt', message: '预测提示应为 1–160 字。' };
  if (input.hasSentenceBreaks && !prompt) return { ok: false, field: 'predictionPrompt', message: '正式断句须先保存预测。' };
  return { ok: true };
}

export function checkArtifactActionSubmit(input: { readonly predicting: boolean; readonly estimateIsValidText: boolean; readonly isSubmit: boolean; readonly traceOmitted: boolean }): ErrorDescriptor | null {
  if (input.predicting && !input.estimateIsValidText) return { status: 409, message: '请先写下预测。' };
  if (input.isSubmit && input.traceOmitted) return { status: 409, message: '操作轨迹不完整。' };
  return null;
}

export function buildArtifactActionData(input: { readonly stateRev: number; readonly mountId: string; readonly sessionId: string; readonly turnId: string; readonly requestId: string; readonly action: unknown; readonly predicting: boolean; readonly predictionRef: string | null; readonly submission: unknown }) {
  return { stateRev: input.stateRev, mountId: input.mountId, sessionId: input.sessionId, turnId: input.turnId, requestId: input.requestId,
    action: input.action, prediction: input.predicting, predictionRef: input.predictionRef,
    ...(input.submission ? { submission: input.submission, traceSource: 'learner-reported' as const } : {}) };
}

// --- Classroom ---------------------------------------------------------------

export const classroomPathPattern = /^\/api\/classrooms(?:\/([0-9A-HJKMNP-TV-Z]{26})(?:\/(adjust|advance|skip|finish|archive|print))?)?$/;

export function checkClassroomAction(input: { readonly isClassroom: boolean; readonly stateStatus: string; readonly activeTurnId: string | undefined; readonly turnId: string }): ErrorDescriptor | null {
  if (!input.isClassroom) return null;
  if (input.stateStatus !== 'active' || input.activeTurnId !== input.turnId)
    return { status: 409, message: '此课堂步骤已停止接收新操作。' };
  return null;
}

export function buildClassroomView(input: { readonly id: string; readonly rev: number; readonly topic: string; readonly minutes: number; readonly sessionId: string; readonly status: string; readonly steps: unknown; readonly activeStepId: string | null; readonly generation: unknown; readonly adjustmentFailed: boolean }) {
  return { id: input.id, rev: input.rev, topic: input.topic, minutes: input.minutes, sessionId: input.sessionId, status: input.status,
    steps: input.steps, activeStepId: input.activeStepId,
    ...(input.generation ? { generation: input.generation } : {}), ...(input.adjustmentFailed ? { adjustmentFailed: true as const } : {}) };
}

export function checkClassroomRoute(input: { readonly routeMatches: boolean; readonly routeAccountRevision: unknown; readonly accountRevision: string | undefined }): ErrorDescriptor | null {
  if (!input.routeMatches || (input.routeAccountRevision !== undefined && input.routeAccountRevision !== input.accountRevision))
    return { status: 409, message: '模型配置已变更，请重新确认。' };
  return null;
}

export function checkClassroomMutation(input: { readonly revMatches: boolean; readonly generationPending: boolean }): ErrorDescriptor | null {
  if (!input.revMatches) return { status: 409, message: '课堂已更新，请刷新。' };
  if (input.generationPending) return { status: 409, message: '请先等当前课堂回合完成。' };
  return null;
}

export function checkClassroomAdjustNote(input: { readonly isAdjust: boolean; readonly evidenceLength: number; readonly note: unknown }): ErrorDescriptor | null {
  if (input.isAdjust && input.evidenceLength === 0 && !input.note)
    return { status: 409, message: '请说明希望调整的内容，或先完成课堂作品。' };
  return null;
}

export function buildClassroomTurnData(input: { readonly sessionId: string; readonly answer: string; readonly workspaceRevision: string | undefined; readonly currentObject: unknown; readonly accountRevision: string | undefined; readonly providerId: string; readonly protocol: string; readonly model: string; readonly baseUrl: string; readonly reasoningEffort: string | undefined; readonly classroom: { readonly mode: string; readonly evidence: readonly unknown[] } }) {
  return { caseId: 'companion' as const, sessionId: input.sessionId, parentId: null, answer: input.answer, classroom: input.classroom, agentVersion: 1,
    ...(input.workspaceRevision ? { workspaceRevision: input.workspaceRevision } : {}),
    ...(input.currentObject ? { currentObject: input.currentObject } : {}),
    ...(input.accountRevision ? { accountRevision: input.accountRevision, accountConfirmation: 1 } : {}),
    providerId: input.providerId, protocol: input.protocol, model: input.model, baseUrl: input.baseUrl, reasoningEffort: input.reasoningEffort };
}

export function buildHistoryTurnView<TSubmission, TFeedback, TBackground>(input: { readonly id: string; readonly submission: TSubmission; readonly backgroundUnderstanding: TBackground; readonly feedback: TFeedback; readonly derivationId: string | null; readonly status: SessionStatus; readonly error?: { readonly message: string } | null }) {
  return { id: input.id, submission: input.submission,
    ...(input.backgroundUnderstanding !== undefined ? { backgroundUnderstanding: input.backgroundUnderstanding } : {}),
    feedback: input.feedback, derivationId: input.derivationId, status: input.status,
    ...(input.error ? { error: input.error.message } : {}) };
}

export function buildFormattedTurn(input: { readonly turnId: string; readonly artifacts: unknown; readonly writes: unknown; readonly backgroundUnderstanding: unknown; readonly answer: unknown; readonly feedbackProjection: unknown }) {
  return { ...(input.feedbackProjection as object), ...(input.writes ? { writes: input.writes } : {}), turnId: input.turnId, artifacts: input.artifacts,
    ...(input.backgroundUnderstanding ? { backgroundUnderstanding: input.backgroundUnderstanding } : {}), ...(input.answer ? { answer: input.answer } : {}) };
}

export function buildRecentConversation(id: string, title: string, caseId: string) {
  return { id, title: title.slice(0, 100), caseId };
}

export function buildAuthorizedReply(input: { readonly failed: boolean; readonly hasValue: boolean; readonly authority: 'authorized' | 'unconfirmed' | 'withdrawn'; readonly derivationId: string; readonly steps: unknown }): { readonly status: 'pending' | 'failed' | 'ready' | 'unconfirmed' | 'unavailable'; readonly derivationId?: string; readonly steps?: unknown } {
  if (!input.hasValue) return { status: input.failed ? 'failed' : 'pending' };
  if (input.authority === 'unconfirmed') return { status: 'unconfirmed' };
  if (input.authority !== 'authorized') return { status: 'unavailable' };
  return { status: 'ready', derivationId: input.derivationId, steps: input.steps };
}

export function isStudioTurnCreateChange(change: { readonly factType?: string; readonly kind?: string }): boolean {
  return change.factType === 'activity.studyTurn' && change.kind === 'create';
}

export function resolveStudioTurnDeriver(input: { readonly learningToolsVersion?: number | undefined; readonly guarded: boolean }): { readonly method: string; readonly pending: 'pending' | 'routed_pending' } {
  const method = input.learningToolsVersion ? 'activity/evidence-tutor-learning-tools-v1' : input.guarded ? 'activity/evidence-tutor-confirmed-v1' : 'activity/evidence-tutor';
  return { method, pending: input.guarded ? 'routed_pending' : 'pending' };
}


export function checkSessionTurnError(isUnavailable: boolean): ErrorDescriptor | null {
  return isUnavailable ? { status: 409, message: '本次教学引用的依据已经变更。请重新开始一轮。' } : null;
}

export function checkStudyCaseId<T>(value: unknown, isValid: (v: unknown) => v is T): ErrorDescriptor | null {
  return isValid(value) ? null : { status: 400, message: '对话类型无效。' };
}

export function checkMcpGrantsAllowed(selected: string): ErrorDescriptor | null {
  return selected !== 'companion' && selected !== 'riding' ? { status: 400, message: '此活动未开放 MCP 工具。' } : null;
}

export function checkBackgroundUnderstandingAllowed(selected: string): ErrorDescriptor | null {
  return selected !== 'companion' ? { status: 400, message: '本轮后台理解授权仅用于普通同伴对话。' } : null;
}

export function checkAttachmentFreshness(materialAvailable: boolean): ErrorDescriptor | null {
  return materialAvailable ? null : { status: 409, message: '选段的原件或版本已经变化，请重新打开原文。' };
}

export function checkMcpGrantsResolved(resolved: boolean): ErrorDescriptor | null {
  return resolved ? null : { status: 409, message: 'MCP 设置已变化，请重新选择本轮工具。' };
}

export function checkAccountSettings(settings: unknown, sameRoute: boolean, workspaceRevisionMatches: boolean): ErrorDescriptor | null {
  return settings && sameRoute && workspaceRevisionMatches ? null
    : { status: 409, message: '请重新选择材料或开始新对话，并确认当前模型账户。', code: 'provider_account_confirmation_required' };
}

export function buildReplayRouteSettings(existing: { readonly providerId?: string; readonly protocol?: string; readonly baseUrl: string; readonly model: string; readonly reasoningEffort?: string }) {
  return { activeProviderId: existing.providerId ?? 'default', protocol: (existing.protocol === 'anthropic' ? 'anthropic' : 'openai') as 'anthropic' | 'openai', baseUrl: existing.baseUrl, model: existing.model, reasoningEffort: existing.reasoningEffort ?? 'high' };
}

export function buildSessionTurnRequest(input: { readonly req: string; readonly session: string; readonly selected?: string | undefined; readonly parent: string | null; readonly answer: string | null; readonly attachment?: unknown; readonly grants: unknown; readonly requestedRoute: unknown; readonly currentObject: unknown; readonly allowBackgroundUnderstanding: boolean | undefined }): {
  req: string; session: string; selected?: string | undefined; parent: string | null; answer: string | null;
  attachment: unknown; grants: unknown; requestedRoute: unknown; currentObject: unknown; allowBackgroundUnderstanding: boolean | undefined;
} {
  return { req: input.req, session: input.session, selected: input.selected, parent: input.parent, answer: input.answer, attachment: input.attachment, grants: input.grants, requestedRoute: input.requestedRoute, currentObject: input.currentObject, allowBackgroundUnderstanding: input.allowBackgroundUnderstanding };
}

export function checkSubmitOrReplayFallback(input: { readonly hasParent: boolean; readonly lastTurnIdMatchesParent: boolean }): ErrorDescriptor | null {
  return input.hasParent && !input.lastTurnIdMatchesParent ? { status: 409, message: '另一份回答已提交，请刷新会话。' } : null;
}

export function buildMountViewData<TView>(checkedView: TView, mountId: string) {
  return { ...checkedView, id: 'work-' + mountId.toLowerCase() };
}

export function buildMountArtifactInput(id: string, data: unknown) {
  return { id, data };
}

export function buildMountProjectionResult<TProjected extends object, TMount, TGrant, THistory extends readonly unknown[], TSource, TRelease, TManifest, TAssessment>(
  input: {
    readonly source: TSource;
    readonly turnIdMatches: boolean;
    readonly workFailed: boolean;
    readonly viewOk: boolean;
    readonly authority: 'authorized' | 'unconfirmed' | 'withdrawn';
    readonly history: THistory;
    readonly projected: TProjected;
    readonly projectedOk: boolean;
    readonly hostState: any;
    readonly submitted: any;
    readonly predicting: any;
    readonly unavailable: any;
    readonly prediction: any;
    readonly release: any;
    readonly submissionEvent: TAssessment;
    readonly saved: any;
    readonly commandId: string | null;
    readonly grant: TGrant;
    readonly mount: TMount;
    readonly manifest: TManifest;
  },
) {
  const snapshot = { ...input.projected, hostState: input.hostState, submitted: input.submitted, predicting: input.predicting, unavailable: input.unavailable,
    prediction: input.prediction ? { id: input.prediction.id, ...(input.release ? { rev: 1 } : {}), answer: input.prediction.action.answers.estimate } : null,
    ...(input.release ? { questionRef: (input.release as { releaseRef?: unknown }).releaseRef } : {}), ...(input.release && input.submissionEvent ? { assessment: input.submissionEvent } : {}),
    saved: input.saved, commandId: input.commandId };
  return { mount: input.mount, grant: input.grant, history: input.history, snapshot, release: input.release, source: input.source, manifest: input.manifest };
}

export function buildConfirmedActionResult(input: { readonly receipt: { readonly state?: string; readonly commandId?: string } | null | undefined; readonly key: string; readonly snapshot: unknown; readonly requestId: string; readonly mountId: string }) {
  return input.receipt?.state === 'done' && input.receipt.commandId === input.key
    ? { receipt: { ...(input.receipt as object), requestId: input.requestId, mountId: input.mountId, status: 'accepted' }, snapshot: input.snapshot } : null;
}

export function buildSessionMountEvidenceItem(item: { readonly mountId: string; readonly stateRev: number; readonly assessment?: any }) {
  return { mountId: item.mountId, stateRev: item.stateRev, assessmentId: item.assessment && 'derivationId' in item.assessment ? item.assessment.derivationId : null };
}

export function buildSessionEventResult(input: { readonly session: unknown; readonly row: unknown; readonly mounts: unknown }) {
  return { session: input.session, row: input.row, mounts: input.mounts };
}

export function buildStartPrepareResult<TState>(input: { readonly state: TState; readonly turn: { readonly id: any; readonly data: any } }) {
  return { state: input.state, turn: input.turn };
}

export function buildMutatePrepareResult<TState>(input: { readonly state: TState; readonly expectedRev: any; readonly turn?: { readonly id: any; readonly data: any } | undefined }) {
  return { state: input.state, expectedRev: input.expectedRev, ...(input.turn ? { turn: input.turn } : {}) };
}

export function buildClassroomCommandInput(input: { readonly id: string; readonly start?: unknown; readonly route?: unknown; readonly op?: string; readonly mutation?: unknown }) {
  return input.start !== undefined ? { id: input.id, start: input.start, route: input.route ?? null } : { id: input.id, op: input.op, ...(input.mutation as object) };
}

export function buildReadClassroomResult<TFact, TState, TOrigin, TGeneration>(input: { readonly fact: TFact; readonly state: TState; readonly origin: TOrigin; readonly generation: TGeneration; readonly adjustmentFailed: boolean }) {
  return { fact: input.fact, state: input.state, origin: input.origin, generation: input.generation, adjustmentFailed: input.adjustmentFailed };
}

export function buildActiveClassroomItem(id: string, rev: number, topic: string, stepTitle: string | undefined) {
  return { id, rev, topic, activeStepTitle: stepTitle };
}

export function checkClassroomRouteMatches(routeMatches: boolean): ErrorDescriptor | null {
  return routeMatches ? null : { status: 409, message: '课堂绑定的模型已变更。' };
}

export function checkArtifactActionReceipt(receipt: { readonly state?: string; readonly commandId?: string } | null | undefined, key: string): ErrorDescriptor | null {
  return receipt?.state === 'done' && receipt.commandId === key ? null : { status: 409, message: '操作回执尚未确认。' };
}

// --- Composed payload builders ------------------------------------------------

export function buildSubmitTurnPayload<TAttachment, TBoundObject, TGrants, TData>(input: {
  readonly selected: string;
  readonly session: string;
  readonly parent: string | null;
  readonly answer: string | null;
  readonly allowBackgroundUnderstanding: boolean | undefined;
  readonly attachment: TAttachment;
  readonly attachmentBasisDigest: string | undefined;
  readonly origin: { readonly attachment?: unknown; readonly jitContextVersion?: unknown; readonly learningToolsVersion?: number; readonly accountRevision?: string; readonly accountConfirmation?: unknown; readonly workspaceRevision?: string } | undefined;
  readonly requestedRoute: unknown;
  readonly currentObject: unknown;
  readonly settings: { readonly model: string; readonly reasoningEffort?: string; readonly activeProviderId: string; readonly protocol?: string; readonly allowSearch?: boolean; readonly baseUrl: string };
  readonly workspaceRevision: string | undefined;
  readonly account: { readonly accountRevision?: string } | undefined;
  readonly jitCounter: { readonly id: string } | undefined;
  readonly grants: TGrants & { readonly length?: number };
  readonly mcpRevision: string | undefined;
  readonly boundObject: TBoundObject;
  readonly routeMatchesSettings: boolean;
  readonly originMatchesSettings: boolean;
}): { readonly error?: ErrorDescriptor; readonly data?: any } {
  if (input.allowBackgroundUnderstanding === true) {
    const background = checkBackgroundUnderstandingAllowed(input.selected);
    if (background) return { error: background };
  }
  const supplied = resolveRequestedAccount(input.requestedRoute);
  const learningToolsVersion = resolveLearningToolsVersion({
    workspaceRevision: input.workspaceRevision, accountRevision: input.account?.accountRevision, suppliedAccountRevision: supplied,
    hasJit: Boolean(input.jitCounter), grantsLength: input.grants?.length, originLearningToolsVersion: input.origin?.learningToolsVersion, hasOrigin: Boolean(input.origin),
  });
  const accountRevision = input.attachment || input.jitCounter || learningToolsVersion ? input.account?.accountRevision : input.origin?.accountRevision;
  const protectedTurn = resolveProtectedTurn({ originAttachment: input.origin?.attachment, originJitContextVersion: input.origin?.jitContextVersion, attachment: input.attachment, jitCounterId: input.jitCounter?.id, accountRevision });
  const routeGuard = resolveTurnRouteGuard({
    protectedTurn, suppliedAccountRevision: supplied, accountRevision: input.account?.accountRevision,
    originHasConfirmation: Boolean(input.origin?.accountConfirmation), routeMatchesSettings: input.routeMatchesSettings,
    originMatchesSettings: input.originMatchesSettings, hasOrigin: Boolean(input.origin),
  });
  if (routeGuard.kind === 'confirm-account') return { error: confirmedAccountError() };
  if (routeGuard.kind === 'route-changed') return { error: { status: 409, message: '模型配置已更改，请重新确认。' } };
  if (routeGuard.kind === 'bound-route') return { error: { status: 422, message: '这次对话已绑定原模型配置，请切回该配置或新建对话。' } };
  if (input.currentObject) {
    const objectError = checkCurrentObjectRequest({ selected: input.selected, hasOriginAttachment: Boolean(input.origin?.attachment), hasAttachment: Boolean(input.attachment), workspaceRevision: input.workspaceRevision });
    if (objectError) return { error: objectError };
  }
  return { data: buildSubmitTurnData({
    selected: input.selected, session: input.session, parent: input.parent, answer: input.answer,
    allowBackgroundUnderstanding: input.allowBackgroundUnderstanding, attachment: input.attachment,
    attachmentBasisDigest: input.attachmentBasisDigest, boundObject: input.boundObject, learningToolsVersion,
    jitCounterId: input.jitCounter?.id, accountRevision, workspaceRevision: input.workspaceRevision, grantsLength: input.grants?.length,
    settings: input.settings, mcpRevision: input.mcpRevision, grants: input.grants,
  }) };
}

export function buildSessionEventView<TRow extends { turnId: string; message: string | null; settled: boolean; status: 'failed' | 'unknown' | null; draft: string | null; hasStudyKit: boolean | null }, TM extends { snapshots: readonly unknown[]; unconfirmed: readonly string[] }>(input: {
  readonly sessionId: string;
  readonly row: TRow;
  readonly submission: { readonly caseId: string; readonly classroom?: unknown; readonly answer?: string | null };
  readonly authority: 'authorized' | 'unconfirmed' | 'withdrawn';
  readonly allowed: boolean;
  readonly mounts: TM;
  readonly status: SessionStatus;
}): { readonly session: StreamSession; readonly row: TRow; readonly mounts: TM } {
  const { status } = input;
  if (!input.allowed && status === 'pending') return { session: buildStreamSession(input.sessionId, input.row.turnId, status, input.submission), row: input.row, mounts: { snapshots: [], unconfirmed: [] } as unknown as TM };
  if (input.authority !== 'authorized') input.row.draft = null;
  if (status === 'ready' && (input.authority !== 'authorized' || input.row.message === null)) {
    input.row.message = input.authority === 'unconfirmed' ? '暂时无法核对本轮依据，旧回复已隐藏。' : '本轮已完成，依据已变更，旧回复已隐藏。';
    input.row.hasStudyKit = false;
  }
  return { session: buildStreamSession(input.sessionId, input.row.turnId, status, input.submission), row: input.row, mounts: status === 'pending' ? input.mounts : { snapshots: [], unconfirmed: [] } as unknown as TM };
}

export function buildMountArtifactRequest<TView>(input: {
  readonly viewOk: boolean;
  readonly viewError?: string | undefined;
  readonly predictionPrompt: unknown;
  readonly hasSentenceBreaks: boolean;
  readonly checkedView: TView;
  readonly mountId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly manifest: unknown;
  readonly gatherTick: string | undefined;
  readonly assessment: unknown;
}): { readonly error?: { readonly field: string; readonly message: string }; readonly view?: TView & { id: string }; readonly prompt?: string | null; readonly data?: unknown } {
  const check = checkMountArgs({ viewOk: input.viewOk, viewError: input.viewError, predictionPrompt: input.predictionPrompt, hasSentenceBreaks: input.hasSentenceBreaks });
  if (!check.ok) return { error: { field: check.field, message: check.message } };
  const view = buildMountViewData(input.checkedView, input.mountId);
  const prompt = (input.predictionPrompt ?? null) as string | null;
  return { view, prompt, data: { turnId: input.turnId, sessionId: input.sessionId, manifest: input.manifest, view, predictionPrompt: prompt, ...(input.assessment ? { assessment: input.assessment } : {}) } };
}

export function buildArtifactActionRequest<TView, TAction, TSubmission>(input: {
  readonly mountStateRev: number;
  readonly snapshot: { readonly predicting: any; readonly prediction?: { readonly id: string } | null; readonly view: TView };
  readonly action: TAction & { readonly intent: string; readonly trace?: { readonly omitted?: boolean | number }; readonly answers: { readonly estimate?: { readonly kind?: string; readonly text?: string } } };
  readonly sessionId: string;
  readonly turnId: string;
  readonly mountId: string;
  readonly requestId: string;
  readonly release: any;
  readonly projectSubmission: (mountId: string, view: TView, id: string, action: TAction, release: any) => TSubmission;
  readonly id: string;
}): { readonly error?: ErrorDescriptor; readonly data?: unknown } {
  const estimate = input.action.answers.estimate;
  const submitError = checkArtifactActionSubmit({ predicting: input.snapshot.predicting, estimateIsValidText: estimate?.kind === 'text' && Boolean(estimate.text?.trim()),
    isSubmit: input.action.intent === 'submit', traceOmitted: Boolean(input.action.trace?.omitted) });
  if (submitError) return { error: submitError };
  const stateRev = input.mountStateRev + 1;
  const submission = input.action.intent === 'submit' ? input.projectSubmission(input.mountId, input.snapshot.view, input.id, input.action, input.release) : undefined;
  if (input.action.intent === 'submit' && !submission) return { error: { status: 409, message: '提交动作未声明。' } };
  return { data: buildArtifactActionData({ stateRev, mountId: input.mountId, sessionId: input.sessionId, turnId: input.turnId, requestId: input.requestId,
    action: { ...input.action }, predicting: input.snapshot.predicting, predictionRef: input.snapshot.prediction?.id ?? null, submission }) };
}

export function buildClassroomStartPayload<TState>(input: {
  readonly start: { readonly currentObject?: unknown };
  readonly sessionId: string;
  readonly state: TState;
  readonly route: { readonly accountRevision?: unknown } | undefined;
  readonly settings: { readonly model: string; readonly reasoningEffort?: string; readonly activeProviderId: string; readonly protocol: string; readonly baseUrl: string };
  readonly account: { readonly accountRevision?: string } | undefined;
  readonly workspaceRevision: string | undefined;
  readonly source: any;
  readonly prompt: string;
  readonly routeMatches: boolean;
}): { readonly error?: ErrorDescriptor; readonly result?: { readonly state: TState; readonly turn: { readonly id: string; readonly data: any } } } {
  const routeError = checkClassroomRoute({ routeMatches: input.routeMatches, routeAccountRevision: input.route?.accountRevision, accountRevision: input.account?.accountRevision });
  if (routeError) return { error: routeError };
  if (input.start.currentObject && (!input.account || input.route?.accountRevision !== input.account.accountRevision))
    return { error: { status: 403, message: '请确认模型账户与工作区教学授权。' } };
  if (input.start.currentObject && !input.source) return { error: { status: 404, message: '这次课堂不可读。' } };
  return { result: { state: input.state, turn: { id: input.sessionId, data: buildClassroomTurnData({
    sessionId: input.sessionId, answer: input.prompt, workspaceRevision: input.workspaceRevision,
    currentObject: input.source ? { ...(input.start.currentObject as object), basisDigest: input.source.basisDigest } : undefined,
    accountRevision: input.account?.accountRevision, providerId: input.settings.activeProviderId, protocol: input.settings.protocol,
    model: input.settings.model, baseUrl: input.settings.baseUrl, reasoningEffort: input.settings.reasoningEffort,
    classroom: { mode: 'start', evidence: [] },
  }) } } };
}

export function buildClassroomMutatePayload<TState, TOrigin>(input: {
  readonly factRev: number;
  readonly expectedRev: any;
  readonly generation: unknown;
  readonly nextState: TState;
  readonly origin: TOrigin;
  readonly mode: 'adjust' | 'advance' | undefined;
  readonly evidence: readonly unknown[];
  readonly note: unknown;
  readonly parentId: string | null;
  readonly turnId: string;
  readonly activeTurnId: string | undefined;
  readonly sameRoute: boolean;
  readonly prompt: string;
}): { readonly error?: ErrorDescriptor; readonly result?: { readonly state: TState; readonly expectedRev: number; readonly turn?: { readonly id: any; readonly data: any } } } {
  const mutationError = checkClassroomMutation({ revMatches: input.factRev === input.expectedRev, generationPending: input.generation === 'pending' });
  if (mutationError) return { error: mutationError };
  if (!input.mode) return { result: { state: input.nextState, expectedRev: input.expectedRev } };
  const noteError = checkClassroomAdjustNote({ isAdjust: input.mode === 'adjust', evidenceLength: input.evidence.length, note: input.note });
  if (noteError) return { error: noteError };
  if (!input.sameRoute) return { error: { status: 409, message: '课堂绑定的模型已变更。' } };
  const noteOnly = input.mode === 'adjust' && input.evidence.length === 0;
  return { result: { state: input.nextState, expectedRev: input.expectedRev,
    turn: { id: input.turnId, data: { ...(input.origin as object), parentId: input.parentId,
      answer: input.prompt,
      classroom: { mode: input.mode, evidence: input.evidence, ...(noteOnly ? { noteOnly } : {}), ...(input.mode === 'adjust' ? { evidenceTurn: input.activeTurnId } : {}) } } } } };
}

export function buildSessionProjectionView<TTurns extends readonly unknown[], TBackground>(input: {
  readonly sessionId: string;
  readonly lastId: string;
  readonly lastStatus: SessionStatus;
  readonly lastError?: string | undefined;
  readonly caseId: string;
  readonly pendingAnswer: string | null | undefined;
  readonly backgroundUnderstanding: TBackground;
  readonly firstAttachment: unknown;
  readonly currentObjectView: { readonly alias: string; readonly id: string; readonly rev: number } | undefined;
  readonly pendingArtifacts: readonly unknown[];
  readonly mountFields: MountPermissionData;
  readonly turns: TTurns;
}) {
  return { ...buildSessionProjectionHead(input), turns: input.turns };
}
