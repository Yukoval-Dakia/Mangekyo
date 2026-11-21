import {
  FactNotFoundError,
  factId,
  type BusWitness,
  type FactId,
  type FactRef,
  type FactSnapshot,
  type Json,
  type ReadContext,
  type Tick,
} from '@mangekyo/kernel';
import { AssetBasisError, assetType } from './asset.ts';
import {
  KnowledgeEdgeBasisError,
  knowledgeEdgeType,
  knowledgeEndpointKind,
  knowledgeUseKey,
  readKnowledgeUse,
  sourceUse,
  walkKnowledgeEdges,
  type KnowledgeEndpoint,
  type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';
import type { KnowledgeReadAccess } from './knowledge-reads.ts';

export const thoughtPinPurpose = 'storage' as const;
export const thoughtPinTextLimit = 60;

export type ThoughtPinAnchor = {
  readonly concept: KnowledgeSourceUse;
  readonly source?: KnowledgeSourceUse | null;
  readonly edgeIds: readonly FactId[];
};

export type ThoughtPinWriteInput = {
  readonly text: string;
  readonly anchor: ThoughtPinAnchor;
  readonly purpose?: typeof thoughtPinPurpose;
};

export type ThoughtPinReceipt = {
  readonly note: FactRef;
  readonly edge: FactRef;
  readonly undo_token: string;
};

/** The host owns the Activity short note and its undo semantics. `save` must persist the
 * learner-authored note and its complete concept/source Edge atomically, force storage purpose
 * and sticky=true, and reject a changed or already withdrawn undo token on replay. */
export type ThoughtPinWritePort = {
  readonly save: (input: {
    readonly text: string;
    readonly anchor: ThoughtPinAnchor;
    readonly purpose: typeof thoughtPinPurpose;
    readonly sticky: true;
  }) => Promise<ThoughtPinReceipt>;
  readonly withdraw: (input: { readonly undo_token: string }) => Promise<void>;
};

export type ThoughtPinRetention = {
  readonly createdAt: string;
  readonly source?: KnowledgeSourceUse;
};

export type ThoughtPinProof = {
  readonly note: BusWitness;
  readonly edge: BusWitness;
  readonly basis: readonly BusWitness[];
};

export type ThoughtPinNote = {
  readonly ref: FactRef;
  readonly text: string;
  readonly retention: ThoughtPinRetention;
  readonly proof: ThoughtPinProof;
};

/** Host-checked storage status for one pinned learner note revision. */
export type ThoughtPinNoteSnapshot = {
  readonly ref: FactRef;
  readonly text: string;
  readonly sticky: boolean;
  readonly purpose: readonly string[];
  readonly accessEpoch: Tick;
  readonly createdAt: string;
  readonly source?: KnowledgeSourceUse | null;
};

export type ThoughtPinReadGate =
  | { readonly kind: 'blind' }
  | { readonly kind: 'explicit-l0'; readonly authorization: string }
  | { readonly kind: 'post-submit'; readonly authorization: string };

export type ThoughtPinReadAccess = KnowledgeReadAccess & {
  /** Return the complete recursive fact basis collected by the host reader. */
  readonly dependenciesFor?: (witness: BusWitness) => readonly BusWitness[];
  readonly authorize: (input: {
    readonly conceptId: FactId;
    readonly gate: Exclude<ThoughtPinReadGate, { readonly kind: 'blind' }>;
    readonly purpose: string;
    readonly recipient: string;
  }) => Promise<boolean>;
  readonly readNote: (input: {
    readonly source: KnowledgeSourceUse;
    readonly purpose: string;
    readonly recipient: string;
  }) => Promise<ThoughtPinNoteSnapshot | undefined>;
  readonly preloadFollowingEdges?: (ids: readonly FactId[]) => Promise<void>;
};

export type ThoughtPinConceptQuery = {
  readonly conceptId: FactId;
  readonly concept: KnowledgeSourceUse;
  readonly edgeIds: readonly FactId[];
  readonly gate: ThoughtPinReadGate;
};

export function parseThoughtPinText(input: unknown): string {
  if (typeof input !== 'string' || !input.isWellFormed() ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    throw new Error('口诀必须是可保存的文字。');
  }
  const value = input.trim();
  if (!value) throw new Error('口诀不能为空。');
  if ([...value].length > thoughtPinTextLimit) throw new Error('口诀最多 60 字。');
  return value;
}

function validUse(input: unknown): input is KnowledgeSourceUse {
  try {
    sourceUse(input);
    return true;
  } catch {
    return false;
  }
}

function validFactId(input: unknown): input is FactId {
  if (typeof input !== 'string') return false;
  try {
    factId(input);
    return true;
  } catch {
    return false;
  }
}

function anchor(input: ThoughtPinAnchor): ThoughtPinAnchor {
  if (!input || typeof input !== 'object' || !Array.isArray(input.edgeIds) ||
      input.edgeIds.length === 0 || input.edgeIds.length > 128) {
    throw new Error('口诀必须绑定已授权的概念 Edge。');
  }
  let concept: KnowledgeSourceUse;
  try {
    concept = sourceUse(input.concept);
  } catch {
    throw new Error('口诀必须绑定已授权的概念 Edge。');
  }
  if (!input.edgeIds.every(validFactId)) throw new Error('口诀的 Edge 依据无效。');
  if (new Set(input.edgeIds).size !== input.edgeIds.length) {
    throw new Error('口诀的 Edge 依据不能重复。');
  }
  let source: KnowledgeSourceUse | undefined;
  if (input.source !== undefined && input.source !== null) {
    try {
      source = sourceUse(input.source);
    } catch {
      throw new Error('口诀题源无效。');
    }
  }
  return { concept, ...(source === undefined ? {} : { source }), edgeIds: [...input.edgeIds] };
}

function undoToken(input: unknown): string {
  if (typeof input !== 'string' || !input.isWellFormed() || !input.trim() || input.length > 200) {
    throw new Error('撤回凭据无效。');
  }
  return input;
}

/** Validate the learner's own words, then delegate the formal Activity carrier to the host. */
export async function writeThoughtPin(
  port: ThoughtPinWritePort,
  input: ThoughtPinWriteInput,
): Promise<ThoughtPinReceipt> {
  if (!input || typeof input !== 'object') {
    throw new Error('口诀参数无效。');
  }
  if (input.purpose !== undefined && input.purpose !== thoughtPinPurpose) {
    throw new Error('口诀只能保存为 storage。');
  }
  return port.save({
    text: parseThoughtPinText(input.text),
    anchor: anchor(input.anchor),
    purpose: thoughtPinPurpose,
    sticky: true,
  });
}

export async function withdrawThoughtPin(
  port: ThoughtPinWritePort,
  token: string,
): Promise<void> {
  await port.withdraw({ undo_token: undoToken(token) });
}

function unavailable(access: ThoughtPinReadAccess, error: unknown) {
  return error instanceof FactNotFoundError ||
    error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError ||
    access.isUnavailable(error);
}

function isWholeConcept(endpoint: KnowledgeEndpoint) {
  return endpoint.kind === 'concept' && endpoint.blockId === undefined;
}

function witnessKey(witness: BusWitness) {
  return `${knowledgeUseKey(witness)}:${witness.type}:${witness.mode}`;
}

function validPurposes(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every(item => typeof item === 'string' && item.isWellFormed() && item.trim().length > 0);
}

function normalizeWitness(input: unknown): BusWitness | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.learner !== 'string' || !candidate.learner.trim() ||
      !validFactId(candidate.id) ||
      typeof candidate.rev !== 'number' || !Number.isSafeInteger(candidate.rev) || candidate.rev < 1 ||
      typeof candidate.type !== 'string' || !candidate.type.trim() ||
      (candidate.mode !== 'pinned' && candidate.mode !== 'following') ||
      typeof candidate.accessEpoch !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(candidate.accessEpoch)) {
    return undefined;
  }
  return {
    learner: candidate.learner as BusWitness['learner'],
    id: candidate.id,
    rev: candidate.rev as BusWitness['rev'],
    type: candidate.type,
    mode: candidate.mode,
    accessEpoch: candidate.accessEpoch as Tick,
  };
}

function proofReader(access: ThoughtPinReadAccess) {
  const cache = new Map<string, Promise<{ readonly fact: FactSnapshot; readonly proofs: readonly BusWitness[] }>>();
  return (witnesses: Map<string, BusWitness>) => ({
    async fact<Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot<Value>> {
      const scopedOptions = options.mode === 'pinned'
        ? { ...options, requirePurpose: options.requirePurpose ?? access.purpose }
        : options;
      const key = JSON.stringify([
        id,
        scopedOptions.mode,
        scopedOptions.mode === 'pinned' ? [scopedOptions.rev, scopedOptions.requirePurpose] : null,
      ]);
      let pending = cache.get(key);
      if (!pending) {
        pending = access.read.fact(id, scopedOptions).then(fact => {
          if (!fact || !fact.ref || fact.ref.learner !== access.learner ||
              !validPurposes(fact.purpose) || !hasPurpose(fact.purpose, access.purpose)) {
            throw new KnowledgeEdgeBasisError('事实用途或归属未获授权。');
          }
          const witness = normalizeWitness({
            ...fact.ref,
            type: fact.type,
            accessEpoch: fact.accessEpoch,
            mode: scopedOptions.mode,
          });
          if (!witness) {
            throw new KnowledgeEdgeBasisError('事实证明字段不完整。');
          }
          const rawDependencies = access.dependenciesFor?.(witness);
          const dependencies = Array.isArray(rawDependencies)
            ? rawDependencies.map(normalizeWitness).filter((item): item is BusWitness => item !== undefined)
            : [];
          return { fact, proofs: [witness, ...dependencies] };
        });
        cache.set(key, pending);
      }
      const { fact, proofs } = await pending;
      for (const item of proofs) witnesses.set(witnessKey(item), item);
      return fact as FactSnapshot<Value>;
    },
  });
}

function validCreatedAt(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
    value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function validGate(input: ThoughtPinReadGate): input is Exclude<ThoughtPinReadGate, { readonly kind: 'blind' }> {
  return Boolean(input) && typeof input === 'object' &&
    (input.kind === 'explicit-l0' || input.kind === 'post-submit') &&
    typeof input.authorization === 'string' && input.authorization.isWellFormed() &&
    input.authorization.trim().length > 0 && input.authorization.length <= 200;
}

function hasPurpose(purposes: readonly string[], purpose: string) {
  return purposes.includes(purpose) || purposes.includes('all');
}

function witnessFor(
  proof: readonly BusWitness[],
  ref: { readonly id: FactId; readonly rev: number; readonly mode: BusWitness['mode']; readonly type?: string },
) {
  return proof.find(witness =>
    witness.id === ref.id &&
    witness.rev === ref.rev &&
    witness.mode === ref.mode &&
    (ref.type === undefined || witness.type === ref.type));
}

function parseAuthorizedNote(
  note: unknown,
  access: ThoughtPinReadAccess,
  use: KnowledgeSourceUse,
  noteFact: FactSnapshot,
): { readonly text: string; readonly retention: ThoughtPinRetention } | undefined {
  if (!note || typeof note !== 'object') return undefined;
  const candidate = note as Record<string, unknown>;
  const ref = candidate.ref;
  if (!ref || typeof ref !== 'object') return undefined;
  const refRecord = ref as Record<string, unknown>;
  if (refRecord.learner !== access.learner || refRecord.id !== use.id || refRecord.rev !== use.rev) {
    return undefined;
  }
  if (candidate.accessEpoch !== use.accessEpoch || candidate.sticky !== true) return undefined;
  if (!validPurposes(candidate.purpose) || !hasPurpose(candidate.purpose, access.purpose)) return undefined;
  if (!validPurposes(noteFact.purpose) || !hasPurpose(noteFact.purpose, access.purpose)) return undefined;
  if (!validCreatedAt(candidate.createdAt)) return undefined;
  let text: string;
  try {
    text = parseThoughtPinText(candidate.text);
  } catch {
    return undefined;
  }
  let source: KnowledgeSourceUse | undefined;
  if (candidate.source !== undefined && candidate.source !== null) {
    try {
      source = sourceUse(candidate.source);
    } catch {
      return undefined;
    }
  }
  return {
    text,
    retention: {
      createdAt: candidate.createdAt,
      ...(source ? { source } : {}),
    },
  };
}

/** Read the learner's own thought pins for one concept after a real disclosure gate. Blind
 * recall returns before opening any note or Edge. The host must verify the actual L0 click
 * or post-submit receipt, and independently authorize every note read for purpose, recipient,
 * access epoch, sticky status, and revocation. A malformed or unavailable note never prevents
 * another authorized note from being returned. */
export async function readThoughtPinsByConcept(
  access: ThoughtPinReadAccess,
  input: ThoughtPinConceptQuery,
): Promise<readonly ThoughtPinNote[]> {
  if (!access || typeof access !== 'object' || !input || typeof input !== 'object') return [];
  if (!input.gate || typeof input.gate !== 'object' || input.gate.kind === 'blind') return [];
  if (!validGate(input.gate) || !validFactId(input.conceptId) ||
      !validUse(input.concept) || input.concept.id !== input.conceptId || !Array.isArray(input.edgeIds) ||
      input.edgeIds.length > 128 || !input.edgeIds.every(validFactId) ||
      typeof access.purpose !== 'string' || !access.purpose.isWellFormed() || !access.purpose.trim() ||
      typeof access.recipient !== 'string' || !access.recipient.isWellFormed() || !access.recipient.trim()) return [];
  if (!await access.authorize({
    conceptId: input.conceptId,
    gate: input.gate,
    purpose: access.purpose,
    recipient: access.recipient,
  })) return [];

  const notes: ThoughtPinNote[] = [];
  const seen = new Set<string>();
  const scopedRead = proofReader(access);
  const rootProof = new Map<string, BusWitness>();
  const rootCtx: ThoughtPinReadAccess = { ...access, read: scopedRead(rootProof) };
  try {
    const concept = await readKnowledgeUse(rootCtx, input.concept, access.purpose);
    if (knowledgeEndpointKind(concept) !== 'concept' || concept.type !== assetType) return [];
    const canonical = await openKnowledgeEntity(rootCtx.read, concept.ref.id);
    if (canonical.entity.kind !== 'concept' || canonical.snapshot.ref.learner !== access.learner) return [];
    if (canonical.snapshot.ref.id !== input.conceptId && !await access.authorize({
      conceptId: canonical.snapshot.ref.id,
      gate: input.gate,
      purpose: access.purpose,
      recipient: access.recipient,
    })) return [];
    const uniqueEdgeIds = [...new Set(input.edgeIds)];
    if (uniqueEdgeIds.length === 0) return [];
    await access.preloadFollowingEdges?.(uniqueEdgeIds);
    const root: KnowledgeEndpoint = { kind: 'concept', sourceUse: input.concept };
    for (const edgeId of uniqueEdgeIds) {
      const edgeProof = new Map(rootProof);
      const edgeCtx: ThoughtPinReadAccess = { ...access, read: scopedRead(edgeProof) };
      try {
        const { paths } = await walkKnowledgeEdges(edgeCtx, {
          root,
          edgeIds: [edgeId],
          mode: 'following',
          direction: 'inbound',
          hops: 1,
          unavailable: error => unavailable(access, error),
          acceptEdge: edge => edge.kind === 'explains' &&
            edge.from.kind === 'note' && edge.from.blockId === undefined && isWholeConcept(edge.to),
        });
        for (const path of paths) {
          const noteEndpoint = path.endpoint;
          const edge = witnessFor([...edgeProof.values()], {
            id: path.via.id,
            rev: path.via.rev,
            mode: 'following',
            type: knowledgeEdgeType,
          });
          if (noteEndpoint.kind !== 'note' || noteEndpoint.blockId !== undefined ||
              !isWholeConcept(path.edge.to) || !edge) continue;
          const use = noteEndpoint.sourceUse;
          const key = knowledgeUseKey(use);
          if (seen.has(key)) continue;
          const noteFact = await readKnowledgeUse(edgeCtx, use, access.purpose);
          if (knowledgeEndpointKind(noteFact) !== 'note' ||
              ('sticky' in noteFact && (noteFact as { readonly sticky?: unknown }).sticky !== undefined &&
                (noteFact as { readonly sticky?: unknown }).sticky !== true)) continue;
          const noteWitness = witnessFor([...edgeProof.values()], {
            id: noteFact.ref.id,
            rev: noteFact.ref.rev,
            mode: 'pinned',
            type: noteFact.type,
          });
          if (!noteWitness) continue;
          const note = await access.readNote({
            source: use,
            purpose: access.purpose,
            recipient: access.recipient,
          });
          const parsed = parseAuthorizedNote(note, access, use, noteFact);
          if (!parsed) continue;
          seen.add(key);
          notes.push({
            ref: noteFact.ref,
            text: parsed.text,
            retention: parsed.retention,
            proof: { note: noteWitness, edge, basis: [...edgeProof.values()] },
          });
        }
      } catch (error) {
        if (!unavailable(access, error)) throw error;
      }
    }
    return notes;
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return [];
  }
}
