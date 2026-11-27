import { classroomModelPrompt } from './classroom-evidence.ts';
import {
  runCompanionTurn,
  type TeachingDependencies,
} from './index.ts';
import { TeachingError } from './provider.ts';
import type { ProviderSettings } from './provider-settings.ts';
import { ChangedEvidence } from './turn-errors.ts';
import {
  assembleCompanionFeedback,
  composeCompanionMaterial,
  createOpenMemoryRegionHandler,
  extractPublicSearchQuery,
  isMetadataOnlyLearningMemory,
  parseClassroomTurnReply,
  shouldForwardCompanionProgress,
  validateFirstTurnJitConfig,
  walkCompanionHistory,
  type GuardableTurn,
  type HistoryReply,
} from './turn-context.ts';
import { evaluateCrisisSupport } from './crisis-support.ts';
import type {
  ObservedClassroomItem,
  TurnSlotBasis,
  TurnSlotInput,
  TurnMemoryPacket,
  TurnWitnessLedger,
  TurnWorkspaceWitness,
  TurnFactWitness,
} from './turn-witness.ts';
import type { TeachingCraftSignals } from './teaching-skills.ts';

type McpGrant = { readonly id: string; readonly url: string; readonly allowedTools: string[] };
type CompanionOptions = NonNullable<Parameters<typeof runCompanionTurn>[3]>;
type WorkspaceToolPort = NonNullable<NonNullable<CompanionOptions['tools']>['workspace']>;
type LearningToolsPort = NonNullable<CompanionOptions['learningTools']>;
type MemoryToolsPort = NonNullable<CompanionOptions['memoryTools']>;
type MemoryDeliveredPort = NonNullable<CompanionOptions['onMemoryDelivered']>;

export type CompanionTurnHandle<TWitness extends TurnWorkspaceWitness, TWrite> = WorkspaceToolPort & {
  publishedFormalArtifact: () => boolean;
  writes: () => readonly TWrite[];
  basis: () => readonly TWitness[];
  reads: () => readonly { id: string; title: string; text: string }[];
};

export type CompanionMemoryHandle<TWrite> = {
  execute: MemoryToolsPort;
  onDelivered: MemoryDeliveredPort;
  hasPending: () => boolean;
  used: () => boolean;
  commit: () => Promise<readonly TWrite[]>;
};

export type CompanionMemoryPacket<TWitness extends TurnWorkspaceWitness, TExpand extends { region: string; start: unknown; basisDigest: string }> = {
  bundle: { data: Record<string, unknown>; omitted: readonly ({ reason: 'budget'; expand: TExpand } | { reason: string })[] };
  context: string;
  receipt: { digest: string; basis: readonly TWitness[] };
};

export async function executeCompanionTurn<
  TTurn extends GuardableTurn & {
    readonly classroom?: { readonly mode: string };
    readonly currentObject?: { readonly basisDigest: string };
  },
  TWitness extends TurnWorkspaceWitness,
  TAssessment extends TurnSlotBasis,
  TRetention extends TurnSlotBasis,
  TMemoryPacket extends TurnMemoryPacket<TWitness>,
  TReply extends HistoryReply<TWitness>,
  TWrite,
  TCounter extends { readonly id: string },
  TExpand extends { region: string; start: unknown; basisDigest: string },
  TWorkspace extends CompanionTurnHandle<TWitness, TWrite>,
  TMemory extends CompanionMemoryHandle<TWrite>,
>(
  params: {
    slotKey: string;
    slotType: string;
    submission: TTurn;
    learningV1: boolean;
    memoryTurn?: string | undefined;
    teachingCraft?: TeachingCraftSignals | undefined;
    attachment?: { readonly id: string; readonly title: string; readonly text: string; readonly mode?: string } | undefined;
    settings: ProviderSettings;
    grants: readonly McpGrant[];
    mcpServers: NonNullable<NonNullable<CompanionOptions['tools']>['mcpServers']>;
    memoryId: string;
    ridingLesson: { title: string; distanceKm: number; movingMinutes: number; stoppedMinutes: number };
    averageSpeed: (distanceKm: number, minutes: number) => number;
    onProgress: NonNullable<TeachingDependencies['onProgress']>;
    onTextDelta?: TeachingDependencies['onTextDelta'];
    onActivity?: TeachingDependencies['onActivity'];
    runEffect: TeachingDependencies['runEffect'];
    ledger: TurnWitnessLedger<TWitness, TAssessment, TRetention, TMemoryPacket>;
  },
  ports: {
    loadClassroomAdjust: () => Promise<readonly ObservedClassroomItem<TWitness>[]>;
    getJitCounter: () => TCounter | undefined;
    prepareJit: (counter: TCounter) => Promise<{
      basis: readonly TWitness[];
      context: NonNullable<CompanionOptions['jitContext']>;
    } | undefined>;
    loadCurrentObject: () => Promise<{ view: unknown; basis: readonly TWitness[]; basisDigest: string } | undefined>;
    loadPreference: () => Promise<{ text: string; witness?: TWitness | undefined } | undefined>;
    loadLearningMemory: () => Promise<CompanionMemoryPacket<TWitness, TExpand> | undefined>;
    loadTeachingCraft?: (ctx: {
      historyLength: number; hasCurrentObject: boolean; hasContextMaterial: boolean;
      hasJitRefusal: boolean; hasJitEvidence: boolean; priorReferenceIds: readonly string[];
    }) => Promise<TeachingCraftSignals | undefined>;
    expandLearningMemory: (expand: TExpand, step: number) => Promise<CompanionMemoryPacket<TWitness, TExpand> | undefined>;
    withHistoryRead: <T>(
      fn: (reader: {
        readPriorTurn: (id: string) => Promise<{ ref: TurnFactWitness['ref']; accessEpoch: TurnFactWitness['accessEpoch']; data: TTurn } | undefined>;
        readReply: (id: string, previous: TTurn) => Promise<TReply | undefined>;
        savedNotionWitnesses: (reply: TReply) => Promise<readonly TWitness[]>;
        readAssessmentBasis: (slot: TurnSlotInput) => Promise<TAssessment | undefined>;
        readRetentionBasis: (slot: TurnSlotInput) => Promise<TRetention | undefined>;
        confirmNotionSend: (witnesses: readonly TWitness[]) => Promise<void>;
      }) => Promise<T>,
    ) => Promise<T>;
    isAssessmentSlot: (slotType: string) => boolean;
    isRetentionSlot: (slotType: string) => boolean;
    proofKey: (witness: TWitness) => string;
    readToolContract: (stepKey: string, tool: string, version: string) => Promise<string>;
    openWorkspace: (args: {
      prior: TWitness[];
      beliefTools: boolean;
      jitBasis?: readonly TWitness[];
      learningMemoryBasis?: readonly TWitness[];
    }) => TWorkspace;
    openTurnMemory: (args: {
      answer: string;
      beliefTools: boolean;
      workspace: TWorkspace | undefined;
    }) => TMemory;
    recordLearningTracking: () => Promise<void>;
    openLearningTools: (args: {
      workspace: TWorkspace;
      turnMemory: TMemory;
      manageBeliefs: boolean;
    }) => LearningToolsPort;
    parseClassroomReply: (raw: string) => { message: string; steps: string[] };
    isMemoryConflict: (error: unknown) => boolean;
  },
) {
  const {
    slotKey, slotType, submission, learningV1, memoryTurn, attachment, settings, grants, mcpServers,
    memoryId, ridingLesson, averageSpeed, onProgress, onTextDelta, onActivity, runEffect, ledger,
  } = params;
  let answer = submission.answer;
  if (!answer) throw new TeachingError('invalid_input', '请输入有效的学习问题。');
  const crisisSupport = evaluateCrisisSupport(answer);
  if (crisisSupport) {
    const result: Awaited<ReturnType<typeof runCompanionTurn>> = {
      message: crisisSupport.message,
      carePause: crisisSupport.carePause,
    };
    return assembleCompanionFeedback<typeof result, TWrite, TWitness>({
      result,
      generated: undefined,
      publishedFormalArtifact: false,
      historyNotice: '',
      writes: [],
      memoryManagement: false,
      workspaceReads: [],
      memoryId,
      settings,
    });
  }
  const classroom = submission.classroom;
  let evidenceMessage: string | undefined;
  if (classroom?.mode === 'adjust') {
    const items = await ports.loadClassroomAdjust();
    ({ question: answer, evidenceMessage } = classroomModelPrompt(answer, ledger.trackClassroomAdjust(items)));
  }
  let jit: Awaited<ReturnType<typeof ports.prepareJit>>;
  let currentObject: { view: unknown; basis: readonly TWitness[]; basisDigest: string } | undefined;
  if (submission.jitContextVersion === 1) {
    const counter = validateFirstTurnJitConfig(submission, ports.getJitCounter(), grants);
    jit = await ports.prepareJit(counter);
    if (!jit) throw new ChangedEvidence();
    ledger.trackJitBasis(jit.basis);
  } else if (submission.currentObject) {
    currentObject = await ports.loadCurrentObject();
    if (!currentObject || currentObject.basisDigest !== submission.currentObject.basisDigest) throw new ChangedEvidence();
    if (classroom) ledger.trackClassroomSources(currentObject.basis);
  }
  const pref = submission.caseId === 'companion' && !classroom && !jit ? await ports.loadPreference() : undefined;
  const preference = pref?.text;
  let learningMemory: CompanionMemoryPacket<TWitness, TExpand> | undefined;
  let expandedMemory: CompanionMemoryPacket<TWitness, TExpand> | undefined;
  if (submission.caseId === 'companion' && !classroom && submission.workspaceRevision && !grants.length && !jit) {
    learningMemory = await ports.loadLearningMemory();
  }
  const learningMemoryDigest = learningMemory?.context ? learningMemory.receipt.digest : undefined;
  const inherited = new Map<string, TWitness>();
  const history = await ports.withHistoryRead(reader =>
    walkCompanionHistory(
      { submission, settings, grants, preference, memoryId, learningMemoryDigest, slotType },
      {
        ...reader,
        isAssessmentSlot: ports.isAssessmentSlot,
        isRetentionSlot: ports.isRetentionSlot,
        proofKey: ports.proofKey,
        trackFact: ledger.trackFact,
        trackAssessment: ledger.trackAssessment,
        trackRetention: ledger.trackRetention,
        trackNotion: ledger.trackNotion,
        trackFeedback: ledger.trackFeedback,
      },
    ),
  );
  const { messages: publicHistory, historyNotice } = history;
  history.retain.forEach(keep => keep());
  history.priorBasis.forEach((witness, key) => inherited.set(key, witness));
  if (inherited.size) ledger.markWorkspaceDispatch();
  await onProgress({ phase: 'thinking' });
  const material = composeCompanionMaterial({ caseId: submission.caseId, ridingLesson, averageSpeed, attachment });
  const jitSlots = jit?.context.slots;
  const hostTeachingCraft = await ports.loadTeachingCraft?.({
    historyLength: publicHistory.length,
    hasCurrentObject: Boolean(currentObject || submission.currentObject),
    hasContextMaterial: Boolean(material?.trim() || learningMemory?.context?.trim() || evidenceMessage?.trim()),
    hasJitRefusal: Boolean(jitSlots?.pedagogy?.refusal),
    hasJitEvidence: Boolean(jitSlots?.anchor || jitSlots?.bridge || jitSlots?.misconception),
    priorReferenceIds: [...inherited.values()].map(witness => witness.id),
  });
  const teachingCraft: TeachingCraftSignals | undefined = params.teachingCraft || hostTeachingCraft ? {
    ...params.teachingCraft,
    ...hostTeachingCraft,
    ...(params.teachingCraft?.carePaused === true || hostTeachingCraft?.carePaused === true
      ? { carePaused: true } : {}),
    ...(params.teachingCraft?.hasActiveRefusal === true || hostTeachingCraft?.hasActiveRefusal === true
      ? { hasActiveRefusal: true } : {}),
    ...(params.teachingCraft?.sealedAssessment === true || hostTeachingCraft?.sealedAssessment === true
      ? { sealedAssessment: true } : {}),
  } : undefined;
  const publicSearchQuery = extractPublicSearchQuery(answer);
  const privateContext = Boolean(material || preference || publicHistory.length || submission.workspaceRevision);
  if (pref?.witness) inherited.set(`${pref.witness.id}:${pref.witness.rev}`, pref.witness);
  const hasTurnInput = ledger.inputs.get(slotKey)?.kind === 'fact';
  const beliefTools = learningV1 || Boolean(
    memoryTurn && learningMemory && hasTurnInput && await ports.readToolContract('belief-tools', 'save_belief', 'belief') === 'belief',
  );
  const manageBeliefs = learningV1 && await ports.readToolContract('management-context', 'read_context', 'management') === 'management';
  const workspace = (classroom ? classroom.mode !== 'adjust' : submission.workspaceRevision)
    ? ports.openWorkspace({
        prior: [...inherited.values()],
        beliefTools,
        ...(jit ? { jitBasis: jit.basis } : {}),
        ...(learningMemory ? { learningMemoryBasis: learningMemory.receipt.basis } : {}),
      })
    : undefined;
  const hasJitBasis = Boolean(jit?.basis.length || [...inherited.values()].some(witness => witness.jitBasis));
  const turnMemory = memoryTurn && !hasJitBasis && (learningMemory || jit) && hasTurnInput
    ? ports.openTurnMemory({ answer, beliefTools, workspace })
    : undefined;
  if (learningV1 && (!workspace || !turnMemory)) throw new ChangedEvidence();
  if (learningV1) await ports.recordLearningTracking();
  const toolsV1 = learningV1 && workspace && turnMemory
    ? ports.openLearningTools({ workspace, turnMemory, manageBeliefs })
    : undefined;
  const openMemoryRegion = learningMemory
    ? createOpenMemoryRegionHandler({
        omitted: learningMemory.bundle.omitted,
        hasExpanded: () => Boolean(expandedMemory),
        expandRegion: async (expand, step) => {
          expandedMemory = await ports.expandLearningMemory(expand, step);
          if (!expandedMemory) throw new ChangedEvidence();
          return expandedMemory.context;
        },
      })
    : undefined;
  const suppressTextDelta = Boolean(
    (classroom && classroom.mode !== 'advance') ||
    workspace?.publishedFormalArtifact() ||
    turnMemory?.hasPending(),
  );
  const result = await runCompanionTurn(
    answer,
    publicHistory,
    material,
    {
      provider: settings,
      runEffect,
      ...(learningV1 && !classroom ? { trackPhaticReplies: true } : {}),
      ...(learningMemory && isMetadataOnlyLearningMemory(learningMemory.bundle) ? { metadataOnlyLearningMemory: true } : {}),
      ...(toolsV1 ? { learningTools: toolsV1 } : {}),
      async onProgress(progress) {
        if (shouldForwardCompanionProgress(progress, Boolean(classroom || workspace?.publishedFormalArtifact() || turnMemory?.hasPending()))) {
          await onProgress(progress);
        }
      },
      ...(onTextDelta && !suppressTextDelta ? {onTextDelta} : {}),
      ...(onActivity && !suppressTextDelta ? {onActivity} : {}),
      ...(historyNotice ? { historyNotice } : {}),
      ...(teachingCraft ? { teachingCraft } : {}),
      ...(evidenceMessage ? { classroomEvidence: evidenceMessage } : {}),
      ...(jit ? { jitContext: jit.context } : currentObject ? { currentLearningObject: JSON.stringify(currentObject.view) } : {}),
      ...(learningMemory?.context ? { learningMemory: learningMemory.context } : {}),
      ...(turnMemory ? { memoryTools: turnMemory.execute, onMemoryDelivered: turnMemory.onDelivered, beliefTools } : {}),
      ...(openMemoryRegion ? { openMemoryRegion } : {}),
      ...(classroom
        ? { tools: { ...(workspace ? { workspace: { ...workspace, presentationOnly: true as const } } : {}) } }
        : submission.agentVersion
          ? {
              tools: {
                exaApiKey: settings.exaApiKey,
                mcpServers,
                ...(workspace ? { workspace } : {}),
                ...(publicSearchQuery ? { publicSearchQuery } : {}),
                allowSearch: submission.allowSearch === true && settings.allowSearch && (!privateContext || Boolean(publicSearchQuery)),
              },
            }
          : {}),
    },
    attachment?.mode === 'prepare' && !submission.parentId,
    preference,
  );
  const generated = parseClassroomTurnReply(classroom?.mode, result.message, ports.parseClassroomReply);
  const memoryWrites = (await turnMemory?.commit().catch(error => {
    if (ports.isMemoryConflict(error)) throw new ChangedEvidence();
    throw error;
  })) ?? [];
  return assembleCompanionFeedback({
    result,
    generated,
    publishedFormalArtifact: Boolean(workspace?.publishedFormalArtifact()),
    attachment,
    historyNotice,
    learningMemoryDigest,
    expandedMemoryDigest: expandedMemory?.receipt.digest,
    writes: [...(workspace?.writes() ?? []), ...memoryWrites],
    memoryManagement: Boolean(turnMemory?.used()),
    workspaceBasis: ledger.mergedWorkspaceBasis(workspace?.basis()),
    workspaceReads: workspace?.reads() ?? [],
    jitAnchor: jit?.context.slots.anchor?.version,
    jitBridge: jit?.context.slots.bridge?.oldMistake,
    preference,
    memoryId,
    settings,
  });
}
