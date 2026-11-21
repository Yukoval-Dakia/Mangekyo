import { derivationId, type DerivationId, type FactId, type Json, type JsonObject, type Tick } from '@mangekyo/kernel';
import type { ClassroomModelEvidence } from './classroom-evidence.ts';
import type { TeachingModelStep } from './index.ts';

export type TurnFactInput = {
  kind: 'fact';
  id: FactId;
  rev: number;
  accessEpoch: Tick;
  mode: 'pinned' | 'following';
};

export type TurnSlotInput = {
  kind: 'slot';
  slotType: string;
  slotKey: string;
  derivationId: DerivationId;
  mode: 'pinned' | 'following' | 'asof';
};

export type TurnRangeInput = {
  kind: 'range';
  slotType: string;
  scope: Record<string, unknown>;
  watermark: Tick;
  members: { slotKey: string; derivationId: DerivationId }[];
};

export type TurnManifestInput = TurnFactInput | TurnSlotInput | TurnRangeInput;

export type TurnFactWitness = {
  ref: { id: FactId; rev: number };
  accessEpoch: Tick;
};

export type TurnWorkspaceWitness = {
  id: string;
  rev: number;
  epoch: string;
  type: string;
  mode?: 'pinned' | 'following';
  writeBasis?: true;
  jitBasis?: true;
};

export type TurnSlotBasis<TSlot extends TurnSlotInput = TurnSlotInput> = {
  slot: TSlot;
  facts: readonly TurnFactInput[];
};

export type TurnMemoryPacket<TWitness extends TurnWorkspaceWitness = TurnWorkspaceWitness> = {
  context?: string | undefined;
  receipt: {
    digest: string;
    expiresAt?: string | null | undefined;
    basis: readonly TWitness[];
    sent: readonly { id: string }[];
  };
};

export type TurnTrackedReply<TWitness extends TurnWorkspaceWitness = TurnWorkspaceWitness> = {
  id: string;
  manifest: { inputs: readonly TurnManifestInput[] };
  memoryBasis: {
    ids: ReadonlySet<string>;
    objects: readonly TWitness[];
  };
};

export type ObservedClassroomItem<TWitness extends TurnWorkspaceWitness = TurnWorkspaceWitness> = {
  snapshot: { stateRev: number; prediction: ClassroomModelEvidence['prediction'] };
  source: TurnFactWitness;
  basis: readonly TurnManifestInput[];
  notionWitnesses: readonly TWitness[];
  history: readonly { id: string; witness: TurnFactWitness; action: ClassroomModelEvidence['action'] }[];
  assessment?: { score: ClassroomModelEvidence['assessment']; derivationId?: string } | null | undefined;
  assessmentSlot?: { slot_type: string; slot_key: string; derivationId: string } | undefined;
};

export function createTurnWitnessLedger<
  TWitness extends TurnWorkspaceWitness,
  TAssessment extends TurnSlotBasis,
  TRetention extends TurnSlotBasis,
  TMemoryPacket extends TurnMemoryPacket<TWitness>,
>(options: {
  slotType: string;
  toInput: (witness: TWitness) => TurnFactInput;
  proofKey: (witness: TWitness) => string;
  canonicalKey: (input: TurnManifestInput) => string;
}) {
  const { slotType, toInput, proofKey, canonicalKey } = options;
  const inputs = new Map<string, TurnManifestInput>();
  const assessments = new Map<string, TAssessment>();
  const retention = new Map<string, TRetention>();
  const notionWitnesses = new Map<string, TWitness>();
  const memoryPackets: TMemoryPacket[] = [];
  const learningReadBasis = new Map<string, TWitness>();
  let protectWorkspaceDispatch = false;

  const trackNotion = (witness: TWitness) => {
    if (witness.type === 'capture.source') notionWitnesses.set(`${witness.id}:${witness.rev}`, witness);
  };

  function trackAssessment(basis: TAssessment) {
    const { slot, facts } = basis;
    assessments.set(slot.derivationId, basis);
    inputs.set('assessment:' + slot.derivationId, slot);
    for (const fact of facts) {
      inputs.set(`assessment-fact:${fact.id}:${fact.rev}:${fact.accessEpoch}:${fact.mode}`, fact);
    }
  }

  function trackRetention(basis: TRetention) {
    const { slot, facts } = basis;
    retention.set(slot.derivationId, basis);
    inputs.set('retention:' + slot.derivationId, slot);
    for (const fact of facts) {
      inputs.set(`retention-fact:${fact.id}:${fact.rev}:${fact.accessEpoch}:${fact.mode}`, fact);
    }
  }

  function trackFact(id: string, fact: TurnFactWitness, mode: 'pinned' | 'following' = 'following') {
    inputs.set(id, {
      kind: 'fact',
      id: fact.ref.id,
      rev: fact.ref.rev,
      accessEpoch: fact.accessEpoch,
      mode,
    });
  }

  function trackFeedback(id: string, reply: TurnTrackedReply<TWitness>) {
    inputs.set('feedback:' + id, {
      kind: 'slot',
      slotType,
      slotKey: id,
      derivationId: derivationId(reply.id),
      mode: 'following',
    });
    for (const input of reply.manifest.inputs) {
      if (input.kind === 'fact' && reply.memoryBasis.ids.has(input.id)) {
        inputs.set(`feedback-basis:${input.id}:${input.rev}:${input.accessEpoch}:${input.mode}`, input);
      }
    }
    for (const witness of reply.memoryBasis.objects) {
      trackNotion(witness);
      inputs.set(`feedback-object:${witness.id}:${witness.rev}:${witness.mode}`, toInput(witness));
    }
    if (reply.memoryBasis.ids.size) protectWorkspaceDispatch = true;
  }

  function trackWorkspace(witness: TWitness, checkAtDispatch?: true) {
    trackNotion(witness);
    inputs.set('workspace:' + proofKey(witness), toInput(witness));
    if (checkAtDispatch) protectWorkspaceDispatch = true;
  }

  function trackMemory(packet: TMemoryPacket) {
    memoryPackets.push(packet);
    for (const entry of packet.receipt.basis) {
      trackNotion(entry);
      inputs.set(`learning-memory:${entry.id}:${entry.rev}`, toInput(entry));
    }
  }

  function trackJitBasis(basis: readonly TWitness[]) {
    for (const item of basis) {
      trackNotion(item);
      const input = toInput(item);
      inputs.set('jit:' + canonicalKey(input), input);
    }
  }

  function trackClassroomSources(basis: readonly TWitness[]) {
    for (const witness of basis) {
      inputs.set('classroom-source:' + witness.id, toInput(witness));
    }
  }

  function trackClassroomAdjust(observed: readonly ObservedClassroomItem<TWitness>[]): ClassroomModelEvidence[] {
    const evidence: ClassroomModelEvidence[] = [];
    for (const item of observed) {
      trackFact(item.source.ref.id, item.source, 'pinned');
      for (const input of item.basis) inputs.set('classroom:' + canonicalKey(input), input);
      item.notionWitnesses.forEach(trackNotion);
      for (const row of item.history) trackFact(row.id, row.witness, 'pinned');
      if (item.assessmentSlot) {
        inputs.set('classroom-score:' + item.assessmentSlot.derivationId, {
          kind: 'slot',
          slotType: item.assessmentSlot.slot_type,
          slotKey: item.assessmentSlot.slot_key,
          derivationId: derivationId(item.assessmentSlot.derivationId),
          mode: 'following',
        });
      }
      evidence.push({
        mountId: item.source.ref.id,
        stateRev: item.snapshot.stateRev,
        action: item.history.at(-1)?.action,
        prediction: item.snapshot.prediction,
        assessment: item.assessment?.score ?? null,
      });
    }
    protectWorkspaceDispatch = true;
    return evidence;
  }

  function keepLearningBasis(witness: TWitness) {
    learningReadBasis.set(proofKey(witness), witness);
  }

  function draftBasis() {
    return [...inputs.values()].flatMap(input =>
      input.kind === 'fact' ? [{ id: input.id, rev: input.rev, epoch: input.accessEpoch }] : [],
    );
  }

  function pageBasis(turnKey: string, memoryBasis: readonly TWitness[] = [], jitBasis: readonly TWitness[] = []) {
    const turnInput = inputs.get(turnKey);
    return [
      ...(turnInput?.kind === 'fact'
        ? [{ id: turnInput.id, rev: turnInput.rev, epoch: turnInput.accessEpoch, type: 'activity.studyTurn' }]
        : []),
      ...memoryBasis,
      ...jitBasis,
    ];
  }

  function mergedWorkspaceBasis(workspaceBasis?: readonly TWitness[]) {
    if (!workspaceBasis?.length && !notionWitnesses.size) return undefined;
    return [
      ...new Map([...notionWitnesses.values(), ...(workspaceBasis ?? [])].map(witness => [proofKey(witness), witness])).values(),
    ];
  }

  function sourceIdsForDigest(workspaceBasis: readonly { id: string }[] | undefined, memoryId: string) {
    return [
      ...(workspaceBasis ?? []).filter(item => item.id !== memoryId),
      ...memoryPackets.flatMap(packet => packet.receipt.sent),
    ].map(item => item.id);
  }

  function hasExpiredMemory(nowIso: string) {
    return memoryPackets.some(item => item.receipt.expiresAt && item.receipt.expiresAt <= nowIso);
  }

  function buildStepBasis(params: {
    step: TeachingModelStep;
    jitReceipt?: Json | undefined;
    selectionReceipt: readonly JsonObject[];
    hasMemorySend: boolean;
  }): JsonObject {
    const { step, jitReceipt, selectionReceipt, hasMemorySend } = params;
    return {
      ...(step.jitContext && jitReceipt !== undefined ? { jitBasis: jitReceipt } : {}),
      ...(selectionReceipt.length ? { notionBasis: [...selectionReceipt] } : {}),
      ...(hasMemorySend ? { memoryBasis: memoryPackets.flatMap(packet => packet.receipt.basis) as unknown as Json } : {}),
      ...(assessments.size ? { assessmentBasis: [...assessments.values()] as unknown as Json } : {}),
      ...(retention.size ? { retentionBasis: [...retention.values()] as unknown as Json } : {}),
    };
  }

  function buildMemorySend(params: {
    step: TeachingModelStep;
    learningMemoryContext?: string | undefined;
    purpose: string;
    providerId: string;
    protocol: string;
    workspaceRevision?: string | undefined;
  }): JsonObject | undefined {
    const { step, learningMemoryContext, purpose, providerId, protocol, workspaceRevision } = params;
    if (!step.learningMemory || !learningMemoryContext) return undefined;
    return {
      purpose,
      recipient: {
        id: providerId,
        endpoint: step.provider,
        protocol,
        model: step.model,
        workspaceRevision: workspaceRevision!,
      },
      requestDigest: step.requestDigest,
      fragments: memoryPackets.flatMap(packet => packet.receipt.sent) as unknown as Json,
    };
  }

  return {
    inputs,
    assessments,
    retention,
    notionWitnesses,
    memoryPackets,
    learningReadBasis,
    get protectWorkspaceDispatch() {
      return protectWorkspaceDispatch;
    },
    markWorkspaceDispatch() {
      protectWorkspaceDispatch = true;
    },
    needsFreshEvidence(hasJit: boolean, hasMemorySend: boolean) {
      return Boolean(hasJit || notionWitnesses.size || protectWorkspaceDispatch || assessments.size || retention.size || hasMemorySend);
    },
    trackNotion,
    trackAssessment,
    trackRetention,
    trackFact,
    trackFeedback,
    trackWorkspace,
    trackMemory,
    trackJitBasis,
    trackClassroomSources,
    trackClassroomAdjust,
    keepLearningBasis,
    draftBasis,
    pageBasis,
    mergedWorkspaceBasis,
    sourceIdsForDigest,
    hasExpiredMemory,
    buildStepBasis,
    buildMemorySend,
  };
}

export type TurnWitnessLedger<
  TWitness extends TurnWorkspaceWitness = TurnWorkspaceWitness,
  TAssessment extends TurnSlotBasis = TurnSlotBasis,
  TRetention extends TurnSlotBasis = TurnSlotBasis,
  TMemoryPacket extends TurnMemoryPacket<TWitness> = TurnMemoryPacket<TWitness>,
> = ReturnType<typeof createTurnWitnessLedger<TWitness, TAssessment, TRetention, TMemoryPacket>>;
