import { createHash } from 'node:crypto';
import {
  first45Answer,
  first45Diagnostic,
  first45Histories,
  first45Question,
  runTeachingTurn,
  type CompanionMessage,
  type TeachingDependencies,
  type TeachingModelStep,
  type TeachingProgress,
  type TeachingResponse,
} from './index.ts';
import { providerEndpoint, TeachingError } from './provider.ts';
import { mcpRevision, resolveMcpGrants, sameRoute } from './provider-consent.ts';
import type { ProviderSettings } from './provider-settings.ts';
import type { TeachingFeedback } from './session-feedback.ts';
import { learningToolError } from './tool-error.ts';
import { ChangedEvidence } from './turn-errors.ts';
import type {
  TurnFactWitness,
  TurnManifestInput,
  TurnSlotInput,
  TurnTrackedReply,
  TurnWorkspaceWitness,
} from './turn-witness.ts';

type McpGrant = { readonly id: string; readonly url: string; readonly allowedTools: string[] };

export type GuardableTurn = {
  readonly caseId: string;
  readonly sessionId: string;
  readonly parentId?: string | null | undefined;
  readonly answer?: string | null | undefined;
  readonly baseUrl: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly protocol?: string;
  readonly providerId?: string;
  readonly accountRevision?: string;
  readonly accountConfirmation?: unknown;
  readonly workspaceRevision?: string;
  readonly mcpGrants?: readonly McpGrant[];
  readonly mcpRevision?: string;
  readonly attachment?: { readonly id: string; readonly title: string; readonly text: string; readonly mode?: string };
  readonly jitContextVersion?: number;
  readonly jitCounterId?: string;
  readonly learningToolsVersion?: number;
  readonly agentVersion?: number;
  readonly allowSearch?: boolean;
};

export function validateTurnMethodGuards(params: {
  submission: GuardableTurn;
  origin: GuardableTurn;
  deriver: string;
  methodName: string;
  learningToolsMethod: string;
  guarded: boolean;
}) {
  const { submission, origin, deriver, methodName, learningToolsMethod, guarded } = params;
  const learningV1 = submission.learningToolsVersion === 1;
  if (
    learningV1 !== (deriver === learningToolsMethod) ||
    (learningV1 && !guarded) ||
    guarded !== (deriver !== methodName) ||
    (guarded && (!origin.accountConfirmation || !submission.accountConfirmation))
  ) {
    throw new ChangedEvidence();
  }
  return learningV1;
}

export function validateAttachmentAccount(submission: GuardableTurn, origin: GuardableTurn) {
  if (origin.attachment && (!origin.accountRevision || submission.accountRevision !== origin.accountRevision)) {
    throw new TeachingError('provider_configuration', '请重新选择材料并确认发送账户。');
  }
}

export function validateTurnRoute(submission: GuardableTurn, settings: ProviderSettings) {
  if (!sameRoute(submission, settings)) {
    throw new TeachingError('provider_configuration', '本轮绑定的模型配置已变更，请切回原配置或新建对话。');
  }
}

export function validateParentRoutes(origin: GuardableTurn, previous: GuardableTurn, settings: ProviderSettings) {
  if (!sameRoute(origin, settings) || !sameRoute(previous, settings)) {
    throw new TeachingError('provider_configuration', '此对话使用过不同端点，请新建对话。');
  }
}

export function validateMcpAccess(grants: readonly McpGrant[], submissionMcpRevision: string | undefined, settings: ProviderSettings) {
  const servers = resolveMcpGrants(grants, settings);
  if (grants.length && submissionMcpRevision !== mcpRevision(grants, settings)) {
    throw new TeachingError('provider_configuration', 'MCP 服务凭证已变更，请重新选择工具并发送。');
  }
  return servers;
}

export function validateFirstTurnJitConfig<TCounter extends { id: string }>(
  submission: GuardableTurn,
  counter: TCounter | undefined,
  grants: readonly McpGrant[],
): TCounter {
  if (
    !counter ||
    counter.id !== submission.jitCounterId ||
    submission.caseId !== 'companion' ||
    submission.parentId ||
    submission.attachment ||
    !submission.workspaceRevision ||
    !submission.accountRevision ||
    grants.length
  ) {
    throw new TeachingError('provider_configuration', '本轮首轮教学资料的计数配置已变更。');
  }
  return counter;
}

export function validateStepDispatchRules(params: {
  step: TeachingModelStep;
  learningV1: boolean;
  hasRetention: boolean;
  hasSelected: boolean;
  selectedUnchanged: boolean;
  settings: ProviderSettings;
  current: ProviderSettings;
  submission: GuardableTurn;
  hasJit: boolean;
  jitCounter?: { id: string; endpoint: string; model: string } | undefined;
  grants: readonly McpGrant[];
}) {
  const {
    step, learningV1, hasRetention, hasSelected, selectedUnchanged,
    settings, current, submission, hasJit, jitCounter, grants,
  } = params;
  const localCalculation = learningV1 && step.provider === 'tool:run_calculation';
  if (
    hasRetention &&
    (step.model !== settings.model || (!step.provider.startsWith('tool:') && step.provider !== providerEndpoint(settings)))
  ) {
    throw new ChangedEvidence();
  }
  if (
    hasSelected &&
    ((!localCalculation && step.provider !== providerEndpoint(settings)) ||
      step.model !== settings.model ||
      !selectedUnchanged)
  ) {
    throw new ChangedEvidence();
  }
  if (!sameRoute(submission, current)) throw new ChangedEvidence();
  if (step.jitContext) {
    if (!hasJit || jitCounter?.id !== submission.jitCounterId || jitCounter?.endpoint !== step.provider || jitCounter?.model !== step.model) {
      throw new ChangedEvidence();
    }
  }
  if (!step.provider.startsWith('tool:') && current.apiKey !== settings.apiKey) throw new ChangedEvidence();
  if (step.provider === 'tool:exa_search' && (!current.allowSearch || current.exaApiKey !== settings.exaApiKey)) {
    throw new ChangedEvidence();
  }
  if (grants.length) validateMcpAccess(grants, submission.mcpRevision, current);
}

export function companionForegroundSummary(
  feedback: Pick<TeachingFeedback, 'action' | 'completion' | 'studyKit'> & { writes?: readonly unknown[] },
  sourceCount: number,
): string | undefined {
  if (feedback.action !== 'companion_reply' || feedback.completion === 'receipts_only') return undefined;
  if (feedback.studyKit) return '本轮完成讲义和练习。';
  if (feedback.writes?.length) return '本轮完成伴学回复并保存工作区变更。';
  if (sourceCount > 0) return '本轮依据已授权的学习记录给出伴学回复。';
  return '本轮完成一次伴学回复。';
}

export function composeCompanionMaterial(params: {
  caseId: string;
  ridingLesson: { title: string; distanceKm: number; movingMinutes: number; stoppedMinutes: number };
  averageSpeed: (distanceKm: number, minutes: number) => number;
  attachment?: { title: string; text: string } | undefined;
}): string | undefined {
  const { caseId, ridingLesson, averageSpeed, attachment } = params;
  if (caseId === 'riding') {
    const { title, distanceKm, movingMinutes, stoppedMinutes } = ridingLesson;
    return `《${title}》：全程 ${distanceKm} 公里，移动 ${movingMinutes} 分钟，停车 ${stoppedMinutes} 分钟。移动均速 ${averageSpeed(distanceKm, movingMinutes)} 公里/小时，全程均速 ${averageSpeed(distanceKm, movingMinutes + stoppedMinutes)} 公里/小时。`;
  }
  return attachment ? `《${attachment.title}》\n${attachment.text}` : undefined;
}

export function extractPublicSearchQuery(answer: string): string | undefined {
  return /(?:^|\n)公开检索[：:]([^\n]{1,400})(?:\n|$)/u.exec(answer)?.[1]?.trim();
}

export function isMetadataOnlyLearningMemory(bundle: {
  data: Record<string, unknown>;
  omitted: readonly { reason: string }[];
}): boolean {
  return !Object.keys(bundle.data).length && bundle.omitted.every(item => item.reason === 'unknown');
}

export function createOpenMemoryRegionHandler<TExpand extends { region: string; start: unknown; basisDigest: string }>(params: {
  omitted: readonly ({ reason: 'budget'; expand: TExpand } | { reason: string })[];
  hasExpanded: () => boolean;
  expandRegion: (expand: TExpand, step: number) => Promise<string>;
}) {
  if (!params.omitted.some(item => item.reason === 'budget')) return undefined;
  return async (input: Record<string, unknown>, step: number) => {
    if (params.hasExpanded()) {
      return JSON.stringify(learningToolError('budget_or_limit', 'region', '本轮已使用一次记忆区域展开。'));
    }
    const omitted = params.omitted.find(
      (item): item is { reason: 'budget'; expand: TExpand } =>
        item.reason === 'budget' &&
        'expand' in item &&
        item.expand.region === input.region &&
        item.expand.start === input.start &&
        item.expand.basisDigest === input.basisDigest,
    );
    if (!omitted) {
      return JSON.stringify(learningToolError('not_found', 'region', '请使用本轮提供的展开位置。'));
    }
    return params.expandRegion(omitted.expand, step);
  };
}

export function parseClassroomTurnReply<T extends { message: string; steps: readonly string[] }>(
  classroomMode: string | undefined,
  message: string,
  parseReply: (raw: string) => T,
): T | undefined {
  if (!classroomMode || classroomMode === 'advance') return undefined;
  try {
    const generated = parseReply(message);
    if (classroomMode === 'start' && generated.steps.length < 2) throw new Error('missing future steps');
    return generated;
  } catch {
    throw new TeachingError('provider_response', '模型返回的课堂编排不完整。');
  }
}

export function shouldForwardCompanionProgress(
  progress: TeachingProgress,
  suppressedReply: boolean,
): boolean {
  return progress.phase !== 'replying' || !suppressedReply;
}

export function assembleCompanionFeedback<
  TResult extends Record<string, unknown>,
  TWrite,
  TWitness extends TurnWorkspaceWitness,
>(params: {
  result: TResult;
  generated?: { message: string; steps: string[] } | undefined;
  publishedFormalArtifact: boolean;
  attachment?: { id: string; title: string; text: string } | undefined;
  historyNotice: string;
  learningMemoryDigest?: string | undefined;
  expandedMemoryDigest?: string | undefined;
  writes: TWrite[];
  memoryManagement: boolean;
  workspaceBasis?: TWitness[] | undefined;
  workspaceReads: readonly { id: string; title: string; text: string }[];
  jitAnchor?: { ref: string; text: string } | undefined;
  jitBridge?: { ref: string; text: string } | undefined;
  preference?: string | undefined;
  memoryId: string;
  settings: Pick<ProviderSettings, 'model' | 'reasoningEffort'>;
}) {
  const {
    result, generated, publishedFormalArtifact, attachment, historyNotice,
    learningMemoryDigest, expandedMemoryDigest, writes, memoryManagement,
    workspaceBasis, workspaceReads, jitAnchor, jitBridge, preference, memoryId, settings,
  } = params;
  return {
    ...result,
    ...(generated ? { message: generated.message, classroomPlan: generated.steps } : {}),
    ...(publishedFormalArtifact ? { message: '断句题已发放。请先保存预测。', trace: [] } : {}),
    action: 'companion_reply' as const,
    rationale: attachment ? '本次请求随附了你选择的材料片段。' : historyNotice,
    ...(learningMemoryDigest
      ? {
          learningMemoryDigest: expandedMemoryDigest
            ? createHash('sha256').update(learningMemoryDigest).update(expandedMemoryDigest).digest('hex')
            : learningMemoryDigest,
        }
      : {}),
    ...(writes.length ? { writes } : {}),
    ...(memoryManagement ? { memoryManagement: true as const } : {}),
    ...(workspaceBasis?.length ? { workspaceBasis } : {}),
    evidenceIds: [] as string[],
    reads: [
      ...workspaceReads,
      ...(jitAnchor ? [{ id: jitAnchor.ref, title: '首轮版本锚点', text: jitAnchor.text }] : []),
      ...(jitBridge ? [{ id: jitBridge.ref, title: '首轮同版旧错答', text: jitBridge.text }] : []),
      ...(attachment ? [{ id: attachment.id, title: attachment.title, text: attachment.text }] : []),
      ...(preference ? [{ id: memoryId, title: '本人保存的同伴备忘', text: preference }] : []),
    ],
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
  };
}

export async function prepareTeachingTurn<
  TTurn extends GuardableTurn,
  TTask,
>(
  params: {
    submission: TTurn;
    deriver: string;
    methodName: string;
    learningToolsMethod: string;
  },
  ports: {
    loadPriorTurn: (id: string) => Promise<{ data: TTurn; teaching: boolean }>;
    requiresAccountConfirmation: (turn: TTurn) => boolean;
    resolveTask: (caseId: string, prepare: boolean) => TTask;
    checkAttachmentCurrent: (origin: TTurn) => Promise<boolean>;
    loadSettings: (task: TTask) => Promise<ProviderSettings>;
    workspaceRouteRevision: (settings: ProviderSettings) => Promise<string | undefined>;
  },
) {
  const { submission, deriver, methodName, learningToolsMethod } = params;
  const original = submission.parentId ? await ports.loadPriorTurn(submission.sessionId) : { data: submission, teaching: true };
  const origin = original.data;
  const learningV1 = validateTurnMethodGuards({
    submission,
    origin,
    deriver,
    methodName,
    learningToolsMethod,
    guarded: ports.requiresAccountConfirmation(origin) || ports.requiresAccountConfirmation(submission),
  });
  const task = ports.resolveTask(submission.caseId, origin.attachment?.mode === 'prepare');
  let attachmentOrigin: TTurn | undefined;
  if (origin.attachment) {
    validateAttachmentAccount(submission, origin);
    attachmentOrigin = origin;
    if (!(await ports.checkAttachmentCurrent(origin))) throw new ChangedEvidence();
  }
  const settings = await ports.loadSettings(task);
  const checkTurnAccount = submission.accountRevision
    ? async () => sameRoute(submission, await ports.loadSettings(task))
    : undefined;
  validateTurnRoute(submission, settings);
  const checkWorkspaceRoute = async (current = settings) => {
    if ((await ports.workspaceRouteRevision(current)) !== submission.workspaceRevision) {
      throw new TeachingError('provider_configuration', '这个模型的学习工作区访问已关闭。请开始新会话。');
    }
  };
  if (submission.workspaceRevision) await checkWorkspaceRoute();
  const authorizeWorkspace = async () => {
    const current = await ports.loadSettings(task);
    if (
      !submission.workspaceRevision ||
      !sameRoute(submission, current) ||
      current.apiKey !== settings.apiKey ||
      (await ports.workspaceRouteRevision(current)) !== submission.workspaceRevision
    ) {
      throw new ChangedEvidence();
    }
  };
  const grants = submission.mcpGrants ?? [];
  const mcpServers = validateMcpAccess(grants, submission.mcpRevision, settings);
  if (submission.parentId) {
    const { data: previous } = await ports.loadPriorTurn(submission.parentId);
    validateParentRoutes(origin, previous, settings);
  }
  return {
    original,
    origin,
    learningV1,
    task,
    attachmentOrigin,
    settings,
    checkTurnAccount,
    checkWorkspaceRoute,
    authorizeWorkspace,
    grants,
    mcpServers,
  };
}

export function createTurnProgressHandler(params: {
  learningV1: boolean;
  recordReplyStarted: () => Promise<void>;
  publishProgress: (progress: TeachingProgress) => Promise<void>;
  warn?: (message: string) => void;
}): NonNullable<TeachingDependencies['onProgress']> {
  let recordedReplyProgress = false;
  return async progress => {
    try {
      if (params.learningV1 && progress.phase === 'replying' && !recordedReplyProgress) {
        await params.recordReplyStarted();
        recordedReplyProgress = true;
      }
      await params.publishProgress(progress);
    } catch (error) {
      if (error instanceof ChangedEvidence) throw error;
      (params.warn ?? console.warn)('本轮进度暂不可用。');
    }
  };
}

export type HistoryReply<TWitness extends TurnWorkspaceWitness> = TurnTrackedReply<TWitness> & {
  value: {
    action: string;
    message: string;
    memoryManagement?: true;
    learningMemoryDigest?: string;
    workspaceBasis?: readonly TWitness[];
    reads: readonly { id: string; text: string }[];
  };
};

export async function walkCompanionHistory<
  TTurn extends GuardableTurn,
  TWitness extends TurnWorkspaceWitness,
  TAssessment,
  TRetention,
  TReply extends HistoryReply<TWitness>,
>(
  params: {
    submission: TTurn;
    settings: ProviderSettings;
    grants: readonly McpGrant[];
    preference?: string | undefined;
    memoryId: string;
    learningMemoryDigest?: string | undefined;
    slotType: string;
  },
  ports: {
    readPriorTurn: (id: string) => Promise<{ ref: TurnFactWitness['ref']; accessEpoch: TurnFactWitness['accessEpoch']; data: TTurn } | undefined>;
    readReply: (id: string, previous: TTurn) => Promise<TReply | undefined>;
    savedNotionWitnesses: (reply: TReply) => Promise<readonly TWitness[]>;
    isAssessmentSlot: (slotType: string) => boolean;
    isRetentionSlot: (slotType: string) => boolean;
    readAssessmentBasis: (slot: TurnSlotInput) => Promise<TAssessment | undefined>;
    readRetentionBasis: (slot: TurnSlotInput) => Promise<TRetention | undefined>;
    confirmNotionSend: (witnesses: readonly TWitness[]) => Promise<void>;
    proofKey: (witness: TWitness) => string;
    trackFact: (id: string, fact: TurnFactWitness) => void;
    trackAssessment: (basis: TAssessment) => void;
    trackRetention: (basis: TRetention) => void;
    trackNotion: (witness: TWitness) => void;
    trackFeedback: (id: string, reply: TReply) => void;
  },
) {
  const { submission, settings, grants, preference, memoryId, learningMemoryDigest, slotType } = params;
  let historyNotice = '';
  const priorBasis = new Map<string, TWitness>();
  const retain: (() => void)[] = [];
  const messages: CompanionMessage[] = [];
  const coveredReplies = new Set<string>();
  let previousId = submission.parentId;
  let historyBytes = 0;
  const historyLimit = submission.workspaceRevision ? 32 : 3;

  for (let count = 0; previousId && count < historyLimit; count++) {
    const prior = await ports.readPriorTurn(previousId);
    if (!prior) {
      historyNotice = '旧回复的依据已变更，本轮从当前消息继续。';
      break;
    }
    const previous = prior.data;
    retain.push(() => ports.trackFact(prior.ref.id, prior));
    if (
      previous.sessionId !== submission.sessionId ||
      previous.caseId !== submission.caseId ||
      !sameRoute(previous, settings) ||
      !previous.answer
    ) {
      throw new ChangedEvidence();
    }
    // Legacy overview replies can lack workspaceBasis. The saved route still bounds their reuse.
    if (previous.workspaceRevision && previous.workspaceRevision !== submission.workspaceRevision) {
      historyNotice = '工作区授权已变更，本轮省略了使用旧授权的对话。';
      break;
    }
    if (
      previous.mcpGrants?.length &&
      (!previous.mcpRevision ||
        previous.mcpRevision !== submission.mcpRevision ||
        JSON.stringify(previous.mcpGrants) !== JSON.stringify(grants))
    ) {
      historyNotice = '本轮的工具授权已变化，旧工具回复已省略。';
      break;
    }
    const reply = await ports.readReply(previousId, previous);
    if (!reply) {
      historyNotice = '旧回复的依据已变更，本轮从当前消息继续。';
      break;
    }
    const { value: response, manifest } = reply;
    if (response.memoryManagement) {
      historyNotice = '记忆管理已结束，本轮使用当前获准的记忆。';
      break;
    }
    if (response.action === 'memory_claim') {
      previousId = previous.parentId;
      continue;
    }
    historyBytes += Buffer.byteLength(previous.answer) + Buffer.byteLength(response.message);
    if (submission.workspaceRevision && count > 0 && historyBytes > 12 * 1024) break;
    const priorMemory = response.reads.find(item => item.id === memoryId);
    if (priorMemory && priorMemory.text !== preference) break;
    if (response.learningMemoryDigest && response.learningMemoryDigest !== learningMemoryDigest) {
      historyNotice = '记忆范围或依据已变更，本轮从当前学习记录继续。';
      break;
    }
    const previousInputs = manifest.inputs;
    const assessmentSlots = previousInputs.filter(
      (input): input is TurnSlotInput => input.kind === 'slot' && ports.isAssessmentSlot(input.slotType),
    );
    const retentionSlots = previousInputs.filter(
      (input): input is TurnSlotInput => input.kind === 'slot' && ports.isRetentionSlot(input.slotType),
    );
    const notion = await ports.savedNotionWitnesses(reply);
    if (response.workspaceBasis?.length || assessmentSlots.length || retentionSlots.length || notion.length) {
      if (!submission.workspaceRevision || previous.workspaceRevision !== submission.workspaceRevision) {
        historyNotice = '工作区授权已变更，本轮省略了使用旧授权的对话。';
        break;
      }
      const witnesses: TWitness[] = [...(response.workspaceBasis ?? []), ...notion];
      const revisions = new Set([...priorBasis.values(), ...witnesses].map(witness => `${witness.id}:${witness.rev}`));
      if (revisions.size > 48) {
        historyNotice = '较早的学习记录可按需重新检索，本轮从最近的对话继续。';
        break;
      }
      for (const slot of assessmentSlots) {
        const basis = await ports.readAssessmentBasis(slot);
        if (!basis) throw new ChangedEvidence();
        retain.push(() => ports.trackAssessment(basis));
      }
      for (const slot of retentionSlots) {
        const basis = await ports.readRetentionBasis(slot);
        if (!basis) throw new ChangedEvidence();
        retain.push(() => ports.trackRetention(basis));
      }
      try {
        await ports.confirmNotionSend(witnesses);
      } catch {
        historyNotice = '选源或接收人授权已变化，本轮省略了旧回复。';
        break;
      }
      retain.push(() => witnesses.forEach(ports.trackNotion));
      for (const witness of witnesses) {
        const normalized =
          'image' in witness && (witness as { image?: unknown }).image === true
            ? ({ ...witness, writeBasis: true as const } as TWitness)
            : witness;
        const key = ports.proofKey(normalized);
        const newer = priorBasis.get(key);
        if (!newer || (normalized.jitBasis && !newer.jitBasis) || (normalized.writeBasis && !newer.writeBasis)) {
          priorBasis.set(key, { ...newer, ...normalized });
        }
      }
    }
    // A reply can reenter history after an intervening turn omitted it.
    // Its witness is needed unless an admitted reply already tracks it.
    if (!coveredReplies.has(reply.id)) retain.push(() => ports.trackFeedback(prior.ref.id, reply));
    for (const input of previousInputs) {
      if (input.kind === 'slot' && input.slotType === slotType && input.mode === 'following') {
        coveredReplies.add(input.derivationId);
      }
    }
    messages.unshift({ role: 'user', content: previous.answer }, { role: 'assistant', content: response.message });
    previousId = previous.parentId;
  }

  return { messages, historyNotice, retain, priorBasis };
}

export async function runIntroTeachingTurn(
  params: {
    selected: 'independent' | 'workedExample';
    parentId?: string | null | undefined;
    answer?: string | null | undefined;
    settings: ProviderSettings;
    onProgress: NonNullable<TeachingDependencies['onProgress']>;
    runEffect: TeachingDependencies['runEffect'];
  },
  ports: {
    loadParentReply: (parentId: string) => Promise<{
      action: string;
      rationale: string;
      message: string;
      evidenceIds: readonly string[];
    }>;
    readEvidenceRecord: (id: string) => Promise<{ id: string; title: string; text: string }>;
  },
): Promise<TeachingFeedback> {
  const { selected, parentId, answer, settings, onProgress, runEffect } = params;
  const catalog = first45Histories[selected].map(({ id, title }) => ({ id, title }));
  const actual = new Map<string, { id: string; title: string; text: string }>();
  let followUp:
    | { previous: TeachingResponse; answer: string }
    | undefined;
  if (parentId && answer) {
    const prev = await ports.loadParentReply(parentId);
    followUp = {
      previous: {
        action: prev.action as TeachingResponse['action'],
        rationale: prev.rationale,
        nextStep: prev.message,
        evidenceIds: prev.evidenceIds,
      },
      answer,
    };
  }
  await onProgress({ phase: 'thinking' });
  const result = await runTeachingTurn(
    {
      question: first45Question,
      answer: first45Answer,
      diagnostic: first45Diagnostic,
      evidenceCatalog: catalog,
      ...(followUp ? { followUp } : {}),
    },
    {
      provider: settings,
      onProgress,
      readEvidence: async id => {
        const value = await ports.readEvidenceRecord(id);
        actual.set(id, value);
        return value.text;
      },
      runEffect,
    },
  );
  return {
    action: result.action,
    rationale: result.rationale,
    message: result.nextStep,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    evidenceIds: result.evidenceIds,
    ...(result.reportedModel ? { reportedModel: result.reportedModel } : {}),
    reads: result.reads.map(record => ({
      ...actual.get(record.id)!,
      ...(record.reportedModel ? { reportedModel: record.reportedModel } : {}),
    })),
  };
}
