import { FactNotFoundError, type BusWitness, type FactId, type FactSnapshot, type Json, type JsonObject, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import {
  AssetBasisError, assetType, checkTextbookBasis, parseAsset, type AssetReadContext,
} from './asset.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, openKnowledgeEdgeRevision,
  readKnowledgeUse, workspaceEntryType, type KnowledgeEdge, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';

export type ArchetypeFoldingAnchor = JsonObject;
export type ArchetypeFoldingActivityHandle = {
  readonly kind: 'activity';
  readonly id: FactId;
  readonly rev: Revision;
  readonly [key: string]: Json | undefined;
};
export type ArchetypeFoldingMastery = 'steady' | 'due' | 'weak' | 'unknown';

export type ArchetypeFoldingItem = {
  readonly question: KnowledgeSourceUse;
  readonly anchor: ArchetypeFoldingAnchor;
  readonly practice: ArchetypeFoldingActivityHandle;
};

export type ArchetypeFoldingEdgeSet = { readonly complete: boolean; readonly edgeIds: readonly FactId[] };

export type ArchetypeFoldingOrigin =
  | { readonly kind: 'original'; readonly key: string }
  | { readonly kind: 'non-paper' };

export type ArchetypeFoldingMasteryRead = {
  readonly question: KnowledgeSourceUse;
  readonly mastery: ArchetypeFoldingMastery;
  readonly proof?: readonly BusWitness[];
};

export type ArchetypeFoldingMemberProof = {
  readonly question: BusWitness;
  readonly memberships: readonly BusWitness[];
  readonly basis: readonly BusWitness[];
  readonly mastery?: readonly BusWitness[];
};

export type ArchetypeFoldingMember = {
  readonly question: KnowledgeSourceUse;
  readonly anchor: ArchetypeFoldingAnchor;
  readonly origin: 'original' | 'non-paper';
  readonly mastery: ArchetypeFoldingMastery;
  readonly copies: readonly KnowledgeSourceUse[];
  readonly proof: ArchetypeFoldingMemberProof;
  readonly practice: ArchetypeFoldingActivityHandle;
};

/** Canonical-member variant edge within one archetype card. `from` and `to` align to the group's
 * canonical member `question`, while `edge` and `basis` retain the recorded edge and endpoint witnesses. */
export type ArchetypeFoldingVariant = {
  readonly changed: readonly string[];
  readonly from: KnowledgeSourceUse;
  readonly to: KnowledgeSourceUse;
  readonly edge: BusWitness;
  readonly basis: readonly BusWitness[];
};

export type ArchetypeFoldingCard = {
  readonly kind: 'archetype';
  readonly archetype: KnowledgeSourceUse;
  readonly title: string;
  readonly representative: ArchetypeFoldingMember;
  readonly members: readonly ArchetypeFoldingMember[];
  readonly coveredQuestionCount: number;
  readonly steadyCount: number;
  readonly dueCount: number;
  readonly weakCount: number;
  readonly unknownCount: number;
  readonly variants: readonly ArchetypeFoldingVariant[];
  readonly variationDimensions: readonly { readonly dimension: string; readonly evidence: BusWitness }[];
};

export type StandaloneArchetypeFoldingCard = {
  readonly kind: 'question';
  readonly question: ArchetypeFoldingMember;
};

export type ArchetypeFoldingConflict = {
  readonly question: KnowledgeSourceUse;
  readonly groups: readonly KnowledgeSourceUse[];
  readonly memberships: readonly BusWitness[];
};

export type ArchetypeFoldingProjection = {
  readonly cards: readonly (ArchetypeFoldingCard | StandaloneArchetypeFoldingCard)[];
  readonly conflicts: readonly ArchetypeFoldingConflict[];
};

export type ArchetypeFoldingAccess = AssetReadContext & {
  readonly purpose: string;
  readonly recipient: string;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly reopenLegacyQuestion?: (use: KnowledgeSourceUse) => Promise<boolean>;
  readonly preloadFollowingEdges?: (ids: readonly FactId[]) => Promise<void>;
  readonly dependenciesFor?: (witness: BusWitness) => readonly BusWitness[];
};

type CandidateItem = ArchetypeFoldingItem & {
  readonly identity: string;
  readonly origin: ArchetypeFoldingOrigin;
  readonly questionWitness: BusWitness;
  readonly basis: Map<string, BusWitness>;
  readonly copies: Map<string, KnowledgeSourceUse>;
};

type CanonicalGroup = {
  readonly archetype: KnowledgeSourceUse;
  readonly title: string;
  readonly entityBasis: readonly BusWitness[];
  readonly members: Map<string, CandidateItem>;
};

type PreparedVariant = {
  readonly edge: KnowledgeEdge;
  readonly witness: BusWitness;
  readonly basis: readonly BusWitness[];
};

function unavailable(access: ArchetypeFoldingAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort(compareText)
    .map(key => `${JSON.stringify(key)}:${stableJson(object[key]!)}`)
    .join(',')}}`;
}

function compareUnknown(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (typeof left !== typeof right) return compareText(typeof left, typeof right);
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'string' && typeof right === 'string') return compareText(left, right);
  return compareText(stableJson(left as Json), stableJson(right as Json));
}

function compareObjectValues(left: Readonly<Record<string, Json | undefined>>, right: Readonly<Record<string, Json | undefined>>) {
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined).sort(compareText);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined).sort(compareText);
  const count = Math.max(leftKeys.length, rightKeys.length);
  for (let index = 0; index < count; index++) {
    const leftKey = leftKeys[index];
    const rightKey = rightKeys[index];
    const order = compareUnknown(leftKey, rightKey);
    if (order) return order;
    if (leftKey === undefined || rightKey === undefined) continue;
    const valueOrder = compareUnknown(left[leftKey], right[rightKey]);
    if (valueOrder) return valueOrder;
  }
  return 0;
}

function anchorOrder(left: JsonObject, right: JsonObject) {
  const keys = ['date', 'paperId', 'paperRev', 'position', 'itemId', 'questionId', 'kind'];
  for (const key of keys) {
    const order = compareUnknown(left[key], right[key]);
    if (order) return order;
  }
  return compareObjectValues(left, right);
}

function useOf({ ref: { id, rev }, accessEpoch }: FactSnapshot): KnowledgeSourceUse {
  return { id, rev, accessEpoch };
}

function whole(edge: KnowledgeEdge) {
  return edge.from.blockId === undefined && edge.to.blockId === undefined;
}

function validPractice(practice: ArchetypeFoldingActivityHandle) {
  return practice !== null && typeof practice === 'object' && !Array.isArray(practice) &&
    practice.kind === 'activity' && typeof practice.id === 'string' && practice.id.trim().length > 0 &&
    Number.isSafeInteger(practice.rev) && practice.rev > 0;
}

export type ArchetypeFoldingClockWatermark = Tick | number;

function validClockWatermark(value: unknown): value is ArchetypeFoldingClockWatermark {
  return (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function validInput(input: {
  readonly scope: string;
  readonly items: readonly ArchetypeFoldingItem[];
  readonly memberships: ArchetypeFoldingEdgeSet;
  readonly variants: ArchetypeFoldingEdgeSet;
  readonly mastery?: {
    readonly complete: boolean;
    readonly asOf?: string;
    readonly clockWatermark?: ArchetypeFoldingClockWatermark;
  };
}) {
  const scope = input.scope.trim();
  return Boolean(scope && scope.length <= 1000 && input.items.length > 0 && input.items.length <= 128 &&
    input.memberships.complete && input.variants.complete && (input.mastery?.complete ?? true) &&
    (input.mastery?.asOf === undefined || (typeof input.mastery.asOf === 'string' && input.mastery.asOf.trim().length > 0)) &&
    (input.mastery?.clockWatermark === undefined || validClockWatermark(input.mastery.clockWatermark)) &&
    input.memberships.edgeIds.length <= 128 && input.variants.edgeIds.length <= 128 &&
    input.items.every(({ anchor, practice }) => anchor !== null && typeof anchor === 'object' && !Array.isArray(anchor) &&
      validPractice(practice)));
}

function witnessKey(witness: BusWitness) {
  return `${knowledgeUseKey(witness)}:${witness.type}:${witness.mode}`;
}

function proofReader(access: ArchetypeFoldingAccess, witnesses: Map<string, BusWitness>) {
  const cache = new Map<string, Promise<FactSnapshot>>();
  return {
    async fact<Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot<Value>> {
      if (options.mode === 'pinned' && options.requirePurpose !== undefined && options.requirePurpose !== access.purpose) {
        throw new Error('折叠视图的来源用途与授权用途不一致。');
      }
      const pinned = options.mode === 'pinned' ? { ...options, requirePurpose: access.purpose } : options;
      const key = stableJson([id, pinned.mode, pinned.mode === 'pinned' ? [pinned.rev, pinned.requirePurpose] : null]);
      let pending = cache.get(key);
      if (!pending) {
        pending = access.read.fact(id, pinned).then(fact => {
          const witness: BusWitness = { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode: pinned.mode };
          witnesses.set(witnessKey(witness), witness);
          for (const dependency of access.dependenciesFor?.(witness) ?? []) {
            witnesses.set(witnessKey(dependency), dependency);
          }
          return fact;
        });
        cache.set(key, pending);
      }
      return (await pending) as FactSnapshot<Value>;
    },
  };
}

function cachedFactReader(access: ArchetypeFoldingAccess) {
  const cache = new Map<string, Promise<FactSnapshot>>();
  let tail = Promise.resolve();
  return {
    async fact<Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot<Value>> {
      if (options.mode === 'pinned' && options.requirePurpose !== undefined && options.requirePurpose !== access.purpose) {
        throw new Error('折叠视图的来源用途与授权用途不一致。');
      }
      const pinned = options.mode === 'pinned' ? { ...options, requirePurpose: access.purpose } : options;
      const key = stableJson([id, pinned.mode, pinned.mode === 'pinned' ? [pinned.rev, pinned.requirePurpose] : null]);
      let pending = cache.get(key);
      if (!pending) {
        pending = tail.then(() => access.read.fact(id, pinned));
        tail = pending.then(() => {}, () => {});
        cache.set(key, pending);
      }
      return (await pending) as FactSnapshot<Value>;
    },
  };
}

async function openQuestion(access: ArchetypeFoldingAccess, use: KnowledgeSourceUse) {
  const fact = await readKnowledgeUse(access, use, access.purpose);
  if (fact.ref.learner !== access.learner || knowledgeEndpointKind(fact) !== 'question') return undefined;
  if (fact.type === assetType) {
    await checkTextbookBasis(access.read, parseAsset(fact.value).basis ?? []);
    return fact;
  }
  if (fact.type === workspaceEntryType && await access.reopenLegacyQuestion?.(use)) return fact;
  return undefined;
}

async function prepareItem(
  access: ArchetypeFoldingAccess,
  item: ArchetypeFoldingItem,
  reopenOrigin: (access: ArchetypeFoldingAccess, question: KnowledgeSourceUse, anchor: ArchetypeFoldingAnchor) =>
    Promise<ArchetypeFoldingOrigin | undefined>,
) {
  const itemProof = new Map<string, BusWitness>();
  const scoped: ArchetypeFoldingAccess = { ...access, read: proofReader(access, itemProof) };
  try {
    const fact = await openQuestion(scoped, item.question);
    if (!fact) return undefined;
    const origin = await reopenOrigin(scoped, item.question, item.anchor);
    if (!origin || (origin.kind === 'original' && !origin.key.trim())) return undefined;
    const normalizedOrigin = origin.kind === 'original' ? { kind: 'original' as const, key: origin.key.trim() } : origin;
    const questionWitness = { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode: 'pinned' as const };
    return { ...item, identity: normalizedOrigin.kind === 'original' ? `original:${normalizedOrigin.key}` : `question:${knowledgeUseKey(item.question)}`,
      origin: normalizedOrigin, questionWitness, basis: itemProof,
      copies: new Map([[knowledgeUseKey(item.question), item.question]]) };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return undefined;
  }
}

function memberOrder(left: CandidateItem, right: CandidateItem) {
  return compareText(left.identity, right.identity) ||
    compareText(knowledgeUseKey(left.question), knowledgeUseKey(right.question)) ||
    anchorOrder(left.anchor, right.anchor) ||
    compareObjectValues(left.practice, right.practice);
}

function chooseMember(items: readonly CandidateItem[]) {
  return [...items].sort(memberOrder)[0]!;
}

function conflictOrder(left: ArchetypeFoldingConflict, right: ArchetypeFoldingConflict) {
  return compareText(knowledgeUseKey(left.question), knowledgeUseKey(right.question));
}

function variantOrder(left: PreparedVariant, right: PreparedVariant) {
  return compareText(stableJson([left.witness.id, left.witness.rev, ...left.edge.variant?.changed ?? []]),
    stableJson([right.witness.id, right.witness.rev, ...right.edge.variant?.changed ?? []]));
}

function cardOrder(left: ArchetypeFoldingCard | StandaloneArchetypeFoldingCard,
  right: ArchetypeFoldingCard | StandaloneArchetypeFoldingCard) {
  const leftMember = left.kind === 'archetype' ? left.representative : left.question;
  const rightMember = right.kind === 'archetype' ? right.representative : right.question;
  const leftTitle = left.kind === 'archetype' ? left.title : 'question';
  const rightTitle = right.kind === 'archetype' ? right.title : 'question';
  return compareText(`${leftTitle}\0${knowledgeUseKey(leftMember.question)}`,
    `${rightTitle}\0${knowledgeUseKey(rightMember.question)}`);
}

const masteryPriority = { weak: 0, due: 1, unknown: 2, steady: 3 } as const;
const masteryValues = new Set<ArchetypeFoldingMastery>(['steady', 'due', 'weak', 'unknown']);
const masteryMergePriority = { weak: 0, due: 1, steady: 2, unknown: 3 } as const;

function mergeMastery(values: readonly ArchetypeFoldingMastery[]) {
  return [...values].sort((left, right) => masteryMergePriority[left] - masteryMergePriority[right])[0] ?? 'unknown';
}

function witnessOrder(left: BusWitness, right: BusWitness) {
  return compareText(witnessKey(left), witnessKey(right));
}

function practiceTarget(members: readonly ArchetypeFoldingMember[]) {
  return [...members].sort((left, right) =>
    masteryPriority[left.mastery] - masteryPriority[right.mastery] ||
    compareText(knowledgeUseKey(left.question), knowledgeUseKey(right.question)) ||
    anchorOrder(left.anchor, right.anchor) ||
    compareObjectValues(left.practice, right.practice))[0]!;
}

function mergeVariantDimensions(variants: readonly PreparedVariant[]) {
  const dimensions = new Map<string, BusWitness>();
  for (const variant of variants) for (const dimension of variant.edge.variant?.changed ?? []) {
    const key = dimension.trim();
    if (key && !dimensions.has(key)) dimensions.set(key, variant.witness);
  }
  return [...dimensions].map(([dimension, evidence]) => ({ dimension, evidence }));
}

/** Read a deterministic material-library folding projection in one host-bound snapshot.
 * Membership edges are grouped by their canonical `merged_into` endpoint while retaining each
 * original edge witness. The host must bind `read` to the same learner, recipient, purpose and
 * snapshot; duplicate paper questions are deduplicated by the authorized origin key. */
export async function readArchetypeFolding(
  access: ArchetypeFoldingAccess,
  input: {
    readonly scope: string;
    readonly items: readonly ArchetypeFoldingItem[];
    readonly memberships: ArchetypeFoldingEdgeSet;
    readonly variants: ArchetypeFoldingEdgeSet;
    readonly mastery?: {
      readonly complete: boolean;
      readonly asOf?: string;
      readonly clockWatermark?: ArchetypeFoldingClockWatermark;
      readonly read: (access: ArchetypeFoldingAccess, questions: readonly KnowledgeSourceUse[],
        at?: { readonly asOf?: string; readonly clockWatermark?: ArchetypeFoldingClockWatermark }) =>
        Promise<readonly ArchetypeFoldingMasteryRead[]>;
    };
  },
  reopenOrigin: (access: ArchetypeFoldingAccess, question: KnowledgeSourceUse, anchor: ArchetypeFoldingAnchor) =>
    Promise<ArchetypeFoldingOrigin | undefined>,
): Promise<ArchetypeFoldingProjection | undefined> {
  if (!access.purpose.trim() || !access.recipient.trim() || !validInput(input)) return undefined;

  const scopedBase: ArchetypeFoldingAccess = { ...access, read: cachedFactReader(access) };
  const membershipEdgeIds = [...new Set(input.memberships.edgeIds)].sort(compareText);
  const variantEdgeIds = [...new Set(input.variants.edgeIds)].sort(compareText);
  const edgeIds = [...new Set([...membershipEdgeIds, ...variantEdgeIds])].sort(compareText);
  if (edgeIds.length) await access.preloadFollowingEdges?.(edgeIds);

  const candidatesByQuestion = new Map<string, CandidateItem[]>();
  for (let index = 0; index < input.items.length; index += 16) {
    const prepared = await Promise.all(input.items.slice(index, index + 16).map(item =>
      prepareItem(scopedBase, item, reopenOrigin)));
    for (const item of prepared) {
      if (!item) continue;
      const questionKey = knowledgeUseKey(item.question);
      const items = candidatesByQuestion.get(questionKey);
      if (items) items.push(item);
      else candidatesByQuestion.set(questionKey, [item]);
    }
  }
  if (!candidatesByQuestion.size) return { cards: [], conflicts: [] };

  // A question can appear at several anchors. Keep every authorized candidate while choosing one
  // deterministic representative before origin identities are merged.
  const preparedByIdentity = new Map<string, CandidateItem[]>();
  for (const items of candidatesByQuestion.values()) {
    const representative = chooseMember(items);
    const basis = new Map(representative.basis);
    for (const item of items) {
      if (item.identity !== representative.identity) continue;
      for (const [key, witness] of item.basis) basis.set(key, witness);
    }
    const item = { ...representative, basis };
    const identityItems = preparedByIdentity.get(item.identity);
    if (identityItems) identityItems.push(item);
    else preparedByIdentity.set(item.identity, [item]);
  }

  // Merge every permitted copy of the same origin into one canonical member. Keep each copy's
  // source use so mastery reads and conflict checks see the full permitted question set.
  const preparedItems = new Map<string, CandidateItem>();
  for (const [identity, items] of preparedByIdentity) {
    const canonical = chooseMember(items);
    const basis = new Map(canonical.basis);
    const copies = new Map(canonical.copies);
    for (const item of items) {
      for (const [key, copy] of item.copies) if (!copies.has(key)) copies.set(key, copy);
      for (const [key, witness] of item.basis) basis.set(key, witness);
    }
    preparedItems.set(identity, { ...canonical, basis, copies });
  }

  const questionToIdentity = new Map<string, string>();
  for (const [identity, item] of preparedItems) {
    for (const copy of item.copies.values()) questionToIdentity.set(knowledgeUseKey(copy), identity);
  }

  const groups = new Map<string, CanonicalGroup>();
  const membershipsByIdentity = new Map<string, Map<string, BusWitness>>();
  const basisByIdentity = new Map<string, Map<string, BusWitness>>();
  for (const id of membershipEdgeIds) {
    try {
      const localProof = new Map<string, BusWitness>();
      const opened = await openKnowledgeEdgeRevision({ ...scopedBase, read: proofReader(scopedBase, localProof) }, id,
        { mode: 'following' });
      if (opened.edge.kind !== 'instance_of' || opened.edge.scope !== input.scope.trim() || !whole(opened.edge) ||
          opened.edge.from.kind !== 'question' || opened.edge.to.kind !== 'archetype') continue;
      const identity = questionToIdentity.get(knowledgeUseKey(opened.edge.from.sourceUse));
      const item = identity !== undefined ? preparedItems.get(identity) : undefined;
      if (!item) continue;
      const canonical = opened.edge.to.sourceUse;
      const groupKey = knowledgeUseKey(canonical);
      let group = groups.get(groupKey);
      if (!group) {
        const entityProof = new Map<string, BusWitness>();
        const entity = await openKnowledgeEntity(proofReader(scopedBase, entityProof), canonical.id, canonical.rev);
        group = { archetype: useOf(entity.snapshot), title: entity.entity.canonicalName,
          entityBasis: [...entityProof.values()], members: new Map() };
        groups.set(groupKey, group);
      }
      const existing = group.members.get(item.identity);
      if (!existing || memberOrder(item, existing) < 0) group.members.set(item.identity, item);
      const member = group.members.get(item.identity)!;
      const witness = { ...opened.snapshot.ref, type: opened.snapshot.type,
        accessEpoch: opened.snapshot.accessEpoch, mode: 'following' as const };
      let memberships = membershipsByIdentity.get(member.identity);
      if (!memberships) membershipsByIdentity.set(member.identity, memberships = new Map());
      memberships.set(witnessKey(witness), witness);
      let basis = basisByIdentity.get(member.identity);
      if (!basis) basisByIdentity.set(member.identity, basis = new Map());
      for (const [key, value] of localProof) basis.set(key, value);
      for (const value of group.entityBasis) basis.set(witnessKey(value), value);
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }

  const groupsByIdentity = new Map<string, Set<string>>();
  for (const [groupKey, group] of groups) {
    for (const identity of group.members.keys()) {
      let identityGroups = groupsByIdentity.get(identity);
      if (!identityGroups) groupsByIdentity.set(identity, identityGroups = new Set());
      identityGroups.add(groupKey);
    }
  }
  const conflictingIdentities = new Set<string>();
  const conflicts = [...groupsByIdentity].flatMap(([identity, groupKeys]) => {
    if (groupKeys.size <= 1) return [];
    conflictingIdentities.add(identity);
    const item = preparedItems.get(identity)!;
    const memberships = [...(membershipsByIdentity.get(identity) ?? new Map<string, BusWitness>()).values()]
      .sort(witnessOrder);
    return { question: item.question, groups: [...groupKeys].sort((left, right) => compareText(left, right))
      .map(groupKey => groups.get(groupKey)!.archetype), memberships };
  }).sort(conflictOrder);

  const variants: PreparedVariant[] = [];
  for (const id of variantEdgeIds) {
    try {
      const localProof = new Map<string, BusWitness>();
      const opened = await openKnowledgeEdgeRevision({ ...scopedBase, read: proofReader(scopedBase, localProof) }, id,
        { mode: 'following' });
      const { edge, snapshot } = opened;
      if (edge.kind !== 'variant_of' || edge.scope !== input.scope.trim() || !edge.variant || !whole(edge)) continue;
      const fromIdentity = questionToIdentity.get(knowledgeUseKey(edge.from.sourceUse));
      const toIdentity = questionToIdentity.get(knowledgeUseKey(edge.to.sourceUse));
      const from = fromIdentity !== undefined ? preparedItems.get(fromIdentity) : undefined;
      const to = toIdentity !== undefined ? preparedItems.get(toIdentity) : undefined;
      if (!from || !to || from.identity === to.identity ||
          conflictingIdentities.has(from.identity) || conflictingIdentities.has(to.identity)) continue;
      const fromGroup = groupsByIdentity.get(from.identity)?.size === 1 ? [...groupsByIdentity.get(from.identity)!][0] : undefined;
      const toGroup = groupsByIdentity.get(to.identity)?.size === 1 ? [...groupsByIdentity.get(to.identity)!][0] : undefined;
      if (fromGroup === undefined || fromGroup !== toGroup) continue;
      const witness = { ...snapshot.ref, type: snapshot.type, accessEpoch: snapshot.accessEpoch, mode: 'following' as const };
      variants.push({ edge, witness, basis: [...localProof.values()].sort(witnessOrder) });
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }
  variants.sort(variantOrder);

  const groupedIdentities = new Set<string>();
  const candidates: CandidateItem[] = [];
  for (const group of groups.values()) {
    for (const item of group.members.values()) {
      if (conflictingIdentities.has(item.identity)) continue;
      groupedIdentities.add(item.identity);
      candidates.push(item);
    }
  }
  for (const item of preparedItems.values()) {
    if (!groupedIdentities.has(item.identity) && !conflictingIdentities.has(item.identity)) candidates.push(item);
  }
  const uniqueCandidates = [...new Map(candidates.map(item => [item.identity, item])).values()];

  const masteryByIdentity = new Map<string, { readonly mastery: ArchetypeFoldingMastery; readonly proof?: readonly BusWitness[] }>();
  if (input.mastery && uniqueCandidates.length) {
    const copiesByIdentity = new Map<string, KnowledgeSourceUse[]>();
    for (const item of uniqueCandidates) copiesByIdentity.set(item.identity,
      [...item.copies.values()].sort((left, right) => compareText(knowledgeUseKey(left), knowledgeUseKey(right))));
    const flat = [...copiesByIdentity.values()].flat()
      .sort((left, right) => compareText(knowledgeUseKey(left), knowledgeUseKey(right)));
    const at = input.mastery.asOf !== undefined || input.mastery.clockWatermark !== undefined
      ? {
          ...(input.mastery.asOf !== undefined ? { asOf: input.mastery.asOf.trim() } : {}),
          ...(input.mastery.clockWatermark !== undefined ? { clockWatermark: input.mastery.clockWatermark } : {}),
        }
      : undefined;
    let masteryReads: readonly ArchetypeFoldingMasteryRead[];
    try {
      masteryReads = await input.mastery.read(scopedBase, flat, at);
    } catch (error) {
      if (!unavailable(access, error)) throw error;
      return undefined;
    }
    const readsByQuestion = new Map<string, ArchetypeFoldingMasteryRead[]>();
    for (const row of masteryReads) {
      if (!masteryValues.has(row.mastery)) return undefined;
      const key = knowledgeUseKey(row.question);
      const rows = readsByQuestion.get(key) ?? [];
      rows.push(row);
      readsByQuestion.set(key, rows);
    }
    if (!flat.every(copy => readsByQuestion.has(knowledgeUseKey(copy)))) return undefined;
    for (const item of uniqueCandidates) {
      const copies = copiesByIdentity.get(item.identity)!;
      const rows = copies.flatMap(copy => readsByQuestion.get(knowledgeUseKey(copy)) ?? [])
        .sort((left, right) => compareText(knowledgeUseKey(left.question), knowledgeUseKey(right.question)) ||
          masteryMergePriority[left.mastery] - masteryMergePriority[right.mastery] ||
          compareText(stableJson((left.proof ?? []) as Json), stableJson((right.proof ?? []) as Json)));
      const merged = mergeMastery(rows.map(row => row.mastery));
      const proofs = [...new Map(rows.flatMap(row => row.proof ?? []).map(witness => [witnessKey(witness), witness])).values()]
        .sort(witnessOrder);
      masteryByIdentity.set(item.identity, { mastery: merged, ...(proofs.length ? { proof: proofs } : {}) });
    }
  }

  function memberOf(item: CandidateItem, memberships: readonly BusWitness[]): ArchetypeFoldingMember {
    const mastery = input.mastery ? masteryByIdentity.get(item.identity)! : { mastery: 'unknown' as const };
    const basis = [...new Map([...(basisByIdentity.get(item.identity) ?? new Map()), ...item.basis]).values()]
      .sort(witnessOrder);
    const copies = [...item.copies.values()].sort((left, right) => compareText(knowledgeUseKey(left), knowledgeUseKey(right)));
    return { question: item.question, anchor: item.anchor, origin: item.origin.kind, mastery: mastery.mastery,
      copies,
      proof: { question: item.questionWitness, memberships: [...memberships].sort(witnessOrder), basis,
        ...('proof' in mastery && mastery.proof ? { mastery: mastery.proof } : {}) },
      practice: item.practice };
  }

  const cards: (ArchetypeFoldingCard | StandaloneArchetypeFoldingCard)[] = [];
  for (const [groupKey, group] of groups) {
    const items = [...group.members.values()].filter(item => !conflictingIdentities.has(item.identity));
    if (!items.length) continue;
    const members = items.map(item => memberOf(item,
      [...(membershipsByIdentity.get(item.identity) ?? new Map()).values()]))
      .sort((left, right) => anchorOrder(left.anchor, right.anchor) ||
        compareText(knowledgeUseKey(left.question), knowledgeUseKey(right.question)));
    const groupVariants = variants.filter(variant => {
      const identity = questionToIdentity.get(knowledgeUseKey(variant.edge.from.sourceUse));
      return identity !== undefined && group.members.has(identity);
    });
    const representative = practiceTarget(members);
    const steadyCount = members.filter(({ mastery }) => mastery === 'steady').length;
    const dueCount = members.filter(({ mastery }) => mastery === 'due').length;
    const weakCount = members.filter(({ mastery }) => mastery === 'weak').length;
    const unknownCount = members.filter(({ mastery }) => mastery === 'unknown').length;
    cards.push({ kind: 'archetype', archetype: group.archetype, title: group.title, representative, members,
      coveredQuestionCount: members.length, steadyCount, dueCount, weakCount, unknownCount,
      variants: groupVariants.map(({ edge, witness, basis }) => {
        const fromIdentity = questionToIdentity.get(knowledgeUseKey(edge.from.sourceUse));
        const toIdentity = questionToIdentity.get(knowledgeUseKey(edge.to.sourceUse));
        return { changed: edge.variant?.changed ?? [],
          from: fromIdentity !== undefined ? preparedItems.get(fromIdentity)!.question : edge.from.sourceUse,
          to: toIdentity !== undefined ? preparedItems.get(toIdentity)!.question : edge.to.sourceUse,
          edge: witness, basis: [...basis].sort(witnessOrder) };
      }),
      variationDimensions: mergeVariantDimensions(groupVariants) });
  }
  for (const item of preparedItems.values()) {
    if (groupedIdentities.has(item.identity) || conflictingIdentities.has(item.identity)) continue;
    cards.push({ kind: 'question', question: memberOf(item, []) });
  }
  cards.sort(cardOrder);
  return { cards, conflicts };
}

export type ArchetypeClusterQuestionInput = {
  readonly id: FactId;
  readonly title: string;
  readonly mastery?: ArchetypeFoldingMastery;
  readonly sourcePaperId?: FactId;
  readonly sourcePaperTitle?: string;
  readonly conceptIds?: readonly FactId[];
  readonly purpose?: readonly string[];
  readonly retracted?: boolean;
};

export type ArchetypeClusterArchetypeInput = {
  readonly id: FactId;
  readonly title: string;
  readonly conceptIds?: readonly FactId[];
  readonly purpose?: readonly string[];
  readonly retracted?: boolean;
};

export type ArchetypeClusterEdgeInput = {
  readonly id?: FactId;
  readonly kind: 'instance_of' | 'canonical_archetype' | 'variant_of' | 'targets_concept';
  readonly fromId: FactId;
  readonly toId: FactId;
  readonly familyId?: string;
  readonly changed?: readonly string[];
  readonly retracted?: boolean;
};

export type ArchetypeClusterMember = {
  readonly id: FactId;
  readonly title: string;
  readonly mastery: ArchetypeFoldingMastery;
  readonly via: 'instance_of' | 'variant_of' | 'shared_concept';
  readonly sourcePaperId?: FactId;
  readonly sourcePaperTitle?: string;
};

export type ArchetypeClusterCard = {
  readonly archetypeId: FactId;
  readonly title: string;
  readonly coveredQuestionCount: number;
  readonly coveredQuestionIds: readonly FactId[];
  readonly coveredQuestions: readonly ArchetypeClusterMember[];
  readonly variationDimensions: readonly string[];
  readonly unmasteredCount: number;
  readonly coverageLabel: string;
};

export type FoldArchetypeClustersInput = {
  readonly questions: readonly ArchetypeClusterQuestionInput[];
  readonly archetypes?: readonly ArchetypeClusterArchetypeInput[];
  readonly edges: readonly ArchetypeClusterEdgeInput[];
  readonly revokedIds?: ReadonlySet<string>;
  readonly requiredPurpose?: string;
  readonly includeSingletons?: boolean;
};

export type ArchetypeClusterProjection = {
  readonly cards: readonly ArchetypeClusterCard[];
  readonly standaloneQuestionIds: readonly FactId[];
};

const clusterViaPriority = { instance_of: 0, variant_of: 1, shared_concept: 2 } as const;

function clusterPurposeAllowed(purpose: readonly string[] | undefined, requiredPurpose: string | undefined) {
  if (!requiredPurpose) return true;
  return purpose !== undefined && purpose.some(entry => {
    const normalized = entry.trim();
    return normalized === requiredPurpose || normalized === 'all';
  });
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  let set = map.get(key);
  if (!set) map.set(key, set = new Set());
  set.add(value);
}

/** Pure data projection that folds school-paper questions into traceable archetype cluster cards. */
export function foldArchetypeClusters(input: FoldArchetypeClustersInput): ArchetypeClusterProjection {
  const requiredPurpose = input.requiredPurpose?.trim() || undefined;
  const revoked = (id: string | undefined) => id !== undefined && input.revokedIds?.has(id) === true;

  const retractedQuestionIds = new Set<FactId>();
  for (const question of input.questions) if (question.retracted === true) retractedQuestionIds.add(question.id);
  const activeQuestions = new Map<FactId, ArchetypeClusterQuestionInput>();
  const excludedQuestionIds = new Set<FactId>();
  for (const question of input.questions) {
    if (retractedQuestionIds.has(question.id) || revoked(question.id) || revoked(question.sourcePaperId) ||
        !clusterPurposeAllowed(question.purpose, requiredPurpose)) {
      excludedQuestionIds.add(question.id);
      continue;
    }
    if (!activeQuestions.has(question.id)) activeQuestions.set(question.id, question);
  }

  const retractedArchetypeIds = new Set<FactId>();
  for (const archetype of input.archetypes ?? []) if (archetype.retracted === true) retractedArchetypeIds.add(archetype.id);
  const activeArchetypes = new Map<FactId, ArchetypeClusterArchetypeInput>();
  const excludedArchetypeIds = new Set<FactId>();
  for (const archetype of input.archetypes ?? []) {
    if (retractedArchetypeIds.has(archetype.id) || revoked(archetype.id) ||
        !clusterPurposeAllowed(archetype.purpose, requiredPurpose)) {
      excludedArchetypeIds.add(archetype.id);
      continue;
    }
    if (!activeArchetypes.has(archetype.id)) activeArchetypes.set(archetype.id, archetype);
  }

  const activeEdges = input.edges.filter(edge =>
    edge.retracted !== true && !revoked(edge.id) && !revoked(edge.fromId) && !revoked(edge.toId) &&
    !excludedQuestionIds.has(edge.fromId) && !excludedQuestionIds.has(edge.toId) &&
    !excludedArchetypeIds.has(edge.fromId) && !excludedArchetypeIds.has(edge.toId));

  type ClusterBucket = {
    readonly archetypeId: FactId;
    title?: string;
    readonly members: Map<FactId, ArchetypeClusterMember['via']>;
    readonly variationDimensions: Set<string>;
  };

  const buckets = new Map<FactId, ClusterBucket>();
  const ensureBucket = (archetypeId: FactId): ClusterBucket => {
    let bucket = buckets.get(archetypeId);
    if (!bucket) {
      const explicitTitle = activeArchetypes.get(archetypeId)?.title ?? activeQuestions.get(archetypeId)?.title;
      bucket = {
        archetypeId,
        ...(explicitTitle !== undefined ? { title: explicitTitle } : {}),
        members: new Map(),
        variationDimensions: new Set(),
      };
      buckets.set(archetypeId, bucket);
    }
    return bucket;
  };
  const addMember = (bucket: ClusterBucket, questionId: FactId, via: ArchetypeClusterMember['via']) => {
    if (!activeQuestions.has(questionId)) return;
    const previous = bucket.members.get(questionId);
    if (previous === undefined || clusterViaPriority[via] < clusterViaPriority[previous]) {
      bucket.members.set(questionId, via);
    }
  };
  const collectDimensions = (bucket: ClusterBucket, changed: readonly string[] | undefined) => {
    for (const raw of changed ?? []) {
      const dimension = raw.trim();
      if (dimension) bucket.variationDimensions.add(dimension);
    }
  };

  for (const archetypeId of activeArchetypes.keys()) ensureBucket(archetypeId);

  // Layer 1: direct instance_of / canonical_archetype edges (question -> archetype).
  const layer1ArchetypesByQuestion = new Map<FactId, Set<FactId>>();
  for (const edge of activeEdges) {
    if (edge.kind !== 'instance_of' && edge.kind !== 'canonical_archetype') continue;
    if (!activeQuestions.has(edge.fromId)) continue;
    const bucket = ensureBucket(edge.toId);
    addMember(bucket, edge.fromId, 'instance_of');
    addSetValue(layer1ArchetypesByQuestion, edge.fromId, edge.toId);
    if (activeQuestions.has(edge.toId)) {
      addMember(bucket, edge.toId, 'instance_of');
      addSetValue(layer1ArchetypesByQuestion, edge.toId, edge.toId);
    }
  }

  // Layer 2: variant_of edges (question <-> question) including transitive familyId grouping.
  const variantEdges = activeEdges.filter(edge => edge.kind === 'variant_of' && edge.fromId !== edge.toId);
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    const current = parent.get(node);
    if (current === undefined) {
      parent.set(node, node);
      return node;
    }
    if (current === node) return node;
    const root = find(current);
    parent.set(node, root);
    return root;
  };
  const unite = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      if (compareText(leftRoot, rightRoot) < 0) parent.set(rightRoot, leftRoot);
      else parent.set(leftRoot, rightRoot);
    }
  };

  const adjacency = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    unite(left, right);
    addSetValue(adjacency, left, right);
    addSetValue(adjacency, right, left);
  };
  for (const edge of variantEdges) {
    const fromKey = `q:${edge.fromId}`;
    const toKey = `q:${edge.toId}`;
    link(fromKey, toKey);
    const family = edge.familyId?.trim();
    if (family) {
      const familyKey = `f:${family}`;
      link(fromKey, familyKey);
      link(toKey, familyKey);
    }
  }

  const componentNodes = new Map<string, Set<string>>();
  for (const node of parent.keys()) addSetValue(componentNodes, find(node), node);
  const componentEdges = new Map<string, ArchetypeClusterEdgeInput[]>();
  for (const edge of variantEdges) {
    const root = find(`q:${edge.fromId}`);
    let edgesForRoot = componentEdges.get(root);
    if (!edgesForRoot) componentEdges.set(root, edgesForRoot = []);
    edgesForRoot.push(edge);
  }

  for (const root of [...componentNodes.keys()].sort(compareText)) {
    const nodes = componentNodes.get(root)!;
    const edgesInComponent = componentEdges.get(root) ?? [];
    const componentQuestions: FactId[] = [];
    const touchedArchetypes = new Set<FactId>();
    for (const node of nodes) {
      if (!node.startsWith('q:')) continue;
      const id = node.slice(2) as FactId;
      if (activeQuestions.has(id)) {
        componentQuestions.push(id);
        for (const archId of layer1ArchetypesByQuestion.get(id) ?? []) touchedArchetypes.add(archId);
      }
      if (activeArchetypes.has(id) || buckets.has(id)) touchedArchetypes.add(id);
    }
    componentQuestions.sort(compareText);
    if (!componentQuestions.length) continue;

    if (touchedArchetypes.size === 1) {
      const archId = [...touchedArchetypes][0]!;
      const bucket = ensureBucket(archId);
      for (const questionId of componentQuestions) addMember(bucket, questionId, 'variant_of');
      for (const edge of edgesInComponent) collectDimensions(bucket, edge.changed);
    } else if (touchedArchetypes.size === 0) {
      if (componentQuestions.length < 2) continue;
      const representativeId = componentQuestions[0]!;
      const bucket = ensureBucket(representativeId);
      bucket.title ??= activeQuestions.get(representativeId)!.title;
      for (const questionId of componentQuestions) addMember(bucket, questionId, 'variant_of');
      for (const edge of edgesInComponent) collectDimensions(bucket, edge.changed);
    } else {
      const distance = new Map<string, number>();
      const nearestArchetypes = new Map<string, Set<FactId>>();
      const queue: string[] = [];
      for (const questionId of componentQuestions) {
        const direct = layer1ArchetypesByQuestion.get(questionId);
        if (!direct || direct.size !== 1) continue;
        const nodeKey = `q:${questionId}`;
        distance.set(nodeKey, 0);
        nearestArchetypes.set(nodeKey, new Set(direct));
        queue.push(nodeKey);
      }
      for (let head = 0; head < queue.length; head++) {
        const current = queue[head]!;
        const currentDist = distance.get(current)!;
        const currentArchetypes = nearestArchetypes.get(current)!;
        for (const neighbor of adjacency.get(current) ?? []) {
          const nextDist = currentDist + 1;
          const prevDist = distance.get(neighbor);
          if (prevDist === undefined) {
            distance.set(neighbor, nextDist);
            nearestArchetypes.set(neighbor, new Set(currentArchetypes));
            queue.push(neighbor);
          } else if (prevDist === nextDist) {
            const targetSet = nearestArchetypes.get(neighbor)!;
            for (const archId of currentArchetypes) targetSet.add(archId);
          }
        }
      }
      for (const questionId of componentQuestions) {
        if (layer1ArchetypesByQuestion.has(questionId)) continue;
        const matched = nearestArchetypes.get(`q:${questionId}`);
        if (matched && matched.size === 1) {
          addMember(ensureBucket([...matched][0]!), questionId, 'variant_of');
        }
      }
      for (const edge of edgesInComponent) {
        for (const bucket of buckets.values()) {
          if (bucket.members.has(edge.fromId) && bucket.members.has(edge.toId)) {
            collectDimensions(bucket, edge.changed);
          }
        }
      }
    }
  }

  // Layer 3: shared targets_concept matching only when uniquely aligned to one existing cluster.
  const conceptsByNode = new Map<FactId, Set<FactId>>();
  for (const question of activeQuestions.values()) {
    for (const conceptId of question.conceptIds ?? []) {
      if (!revoked(conceptId)) addSetValue(conceptsByNode, question.id, conceptId);
    }
  }
  for (const archetype of activeArchetypes.values()) {
    for (const conceptId of archetype.conceptIds ?? []) {
      if (!revoked(conceptId)) addSetValue(conceptsByNode, archetype.id, conceptId);
    }
  }
  for (const edge of activeEdges) {
    if (edge.kind === 'targets_concept') addSetValue(conceptsByNode, edge.fromId, edge.toId);
  }

  const assignedQuestions = new Set<FactId>();
  const clusterConcepts = new Map<FactId, Set<FactId>>();
  for (const bucket of buckets.values()) {
    const concepts = new Set<FactId>();
    for (const conceptId of conceptsByNode.get(bucket.archetypeId) ?? []) concepts.add(conceptId);
    for (const memberId of bucket.members.keys()) {
      assignedQuestions.add(memberId);
      for (const conceptId of conceptsByNode.get(memberId) ?? []) concepts.add(conceptId);
    }
    if (concepts.size > 0) clusterConcepts.set(bucket.archetypeId, concepts);
  }

  for (const questionId of [...activeQuestions.keys()].sort(compareText)) {
    if (assignedQuestions.has(questionId)) continue;
    const questionConcepts = conceptsByNode.get(questionId);
    if (!questionConcepts || questionConcepts.size === 0) continue;
    const matchedArchetypeIds: FactId[] = [];
    for (const [archetypeId, concepts] of clusterConcepts) {
      for (const conceptId of questionConcepts) {
        if (concepts.has(conceptId)) {
          matchedArchetypeIds.push(archetypeId);
          break;
        }
      }
    }
    if (matchedArchetypeIds.length === 1) {
      addMember(buckets.get(matchedArchetypeIds[0]!)!, questionId, 'shared_concept');
    }
  }

  const cards: ArchetypeClusterCard[] = [];
  for (const bucket of buckets.values()) {
    const coveredQuestionIds = [...bucket.members.keys()].sort(compareText);
    const coveredQuestionCount = coveredQuestionIds.length;
    if (coveredQuestionCount === 0) continue;
    if (input.includeSingletons === false && coveredQuestionCount <= 1) continue;
    const coveredQuestions: ArchetypeClusterMember[] = coveredQuestionIds.map(questionId => {
      const question = activeQuestions.get(questionId)!;
      return {
        id: question.id,
        title: question.title,
        mastery: question.mastery ?? 'unknown',
        via: bucket.members.get(questionId)!,
        ...(question.sourcePaperId !== undefined ? { sourcePaperId: question.sourcePaperId } : {}),
        ...(question.sourcePaperTitle !== undefined ? { sourcePaperTitle: question.sourcePaperTitle } : {}),
      };
    });
    const title = activeArchetypes.get(bucket.archetypeId)?.title ??
      activeQuestions.get(bucket.archetypeId)?.title ??
      bucket.title ??
      coveredQuestions[0]!.title;
    const variationDimensions = [...bucket.variationDimensions].sort(compareText);
    const unmasteredCount = coveredQuestions.filter(member => member.mastery !== 'steady').length;
    cards.push({
      archetypeId: bucket.archetypeId,
      title,
      coveredQuestionCount,
      coveredQuestionIds,
      coveredQuestions,
      variationDimensions,
      unmasteredCount,
      coverageLabel: `学透此母题覆盖 ${coveredQuestionCount} 道原卷题`,
    });
  }

  cards.sort((left, right) =>
    right.unmasteredCount - left.unmasteredCount ||
    right.coveredQuestionCount - left.coveredQuestionCount ||
    compareText(left.archetypeId, right.archetypeId));

  const coveredQuestionSet = new Set<FactId>();
  for (const card of cards) for (const id of card.coveredQuestionIds) coveredQuestionSet.add(id);
  const standaloneQuestionIds = [...activeQuestions.keys()]
    .filter(questionId => !coveredQuestionSet.has(questionId))
    .sort(compareText);

  return { cards, standaloneQuestionIds };
}
