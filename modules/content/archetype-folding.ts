import {
  FactNotFoundError, type BusWitness, type FactId, type FactSnapshot, type Json, type JsonObject,
  type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import { AssetBasisError, assetType, checkTextbookBasis, parseAsset, type AssetReadContext } from './asset.ts';
import { addSetValue, compareText, purposeAllowed, pushMapValue } from './content-guard.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, openKnowledgeEdgeRevision,
  readKnowledgeUse, workspaceEntryType, type KnowledgeEdge, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { openKnowledgeEntity } from './knowledge-entity.ts';

export type ArchetypeFoldingAnchor = JsonObject;
export type ArchetypeFoldingActivityHandle = {
  readonly kind: 'activity'; readonly id: FactId; readonly rev: Revision; readonly [key: string]: Json | undefined;
};
export type ArchetypeFoldingMastery = 'steady' | 'due' | 'weak' | 'unknown';
export type ArchetypeFoldingItem = {
  readonly question: KnowledgeSourceUse; readonly anchor: ArchetypeFoldingAnchor; readonly practice: ArchetypeFoldingActivityHandle;
};
export type ArchetypeFoldingEdgeSet = { readonly complete: boolean; readonly edgeIds: readonly FactId[] };
export type ArchetypeFoldingOrigin = { readonly kind: 'original'; readonly key: string } | { readonly kind: 'non-paper' };
export type ArchetypeFoldingMasteryRead = {
  readonly question: KnowledgeSourceUse; readonly mastery: ArchetypeFoldingMastery; readonly proof?: readonly BusWitness[];
};
export type ArchetypeFoldingMemberProof = {
  readonly question: BusWitness; readonly memberships: readonly BusWitness[];
  readonly basis: readonly BusWitness[]; readonly mastery?: readonly BusWitness[];
};
export type ArchetypeFoldingMember = {
  readonly question: KnowledgeSourceUse; readonly anchor: ArchetypeFoldingAnchor; readonly origin: 'original' | 'non-paper';
  readonly mastery: ArchetypeFoldingMastery; readonly copies: readonly KnowledgeSourceUse[];
  readonly proof: ArchetypeFoldingMemberProof; readonly practice: ArchetypeFoldingActivityHandle;
};
export type ArchetypeFoldingVariant = {
  readonly changed: readonly string[]; readonly from: KnowledgeSourceUse; readonly to: KnowledgeSourceUse;
  readonly edge: BusWitness; readonly basis: readonly BusWitness[];
};
export type ArchetypeFoldingCard = {
  readonly kind: 'archetype'; readonly archetype: KnowledgeSourceUse; readonly title: string;
  readonly representative: ArchetypeFoldingMember; readonly members: readonly ArchetypeFoldingMember[];
  readonly coveredQuestionCount: number; readonly steadyCount: number; readonly dueCount: number;
  readonly weakCount: number; readonly unknownCount: number; readonly variants: readonly ArchetypeFoldingVariant[];
  readonly variationDimensions: readonly { readonly dimension: string; readonly evidence: BusWitness }[];
};
export type StandaloneArchetypeFoldingCard = { readonly kind: 'question'; readonly question: ArchetypeFoldingMember };
export type ArchetypeFoldingConflict = {
  readonly question: KnowledgeSourceUse; readonly groups: readonly KnowledgeSourceUse[]; readonly memberships: readonly BusWitness[];
};
export type ArchetypeFoldingProjection = {
  readonly cards: readonly (ArchetypeFoldingCard | StandaloneArchetypeFoldingCard)[];
  readonly conflicts: readonly ArchetypeFoldingConflict[];
};
export type ArchetypeFoldingAccess = AssetReadContext & {
  readonly purpose: string; readonly recipient: string; readonly isUnavailable: (error: unknown) => boolean;
  readonly reopenLegacyQuestion?: (use: KnowledgeSourceUse) => Promise<boolean>;
  readonly preloadFollowingEdges?: (ids: readonly FactId[]) => Promise<void>;
  readonly dependenciesFor?: (witness: BusWitness) => readonly BusWitness[];
};
export type ArchetypeFoldingClockWatermark = Tick | number;

type CandidateItem = ArchetypeFoldingItem & {
  readonly identity: string; readonly origin: ArchetypeFoldingOrigin; readonly questionWitness: BusWitness;
  readonly basis: Map<string, BusWitness>; readonly copies: Map<string, KnowledgeSourceUse>;
};
type CanonicalGroup = {
  readonly archetype: KnowledgeSourceUse; readonly title: string;
  readonly entityBasis: readonly BusWitness[]; readonly members: Map<string, CandidateItem>;
};
type PreparedVariant = { readonly edge: KnowledgeEdge; readonly witness: BusWitness; readonly basis: readonly BusWitness[] };

const ANCHOR_KEYS = ['date', 'paperId', 'paperRev', 'position', 'itemId', 'questionId', 'kind'] as const;
const masteryPriority = { weak: 0, due: 1, unknown: 2, steady: 3 } as const;
const masteryValues = new Set<ArchetypeFoldingMastery>(['steady', 'due', 'weak', 'unknown']);
const masteryMergePriority = { weak: 0, due: 1, steady: 2, unknown: 3 } as const;

const unavailable = (access: ArchetypeFoldingAccess, error: unknown) =>
  error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
  error instanceof AssetBasisError || access.isUnavailable(error);
const useOf = ({ ref: { id, rev }, accessEpoch }: FactSnapshot): KnowledgeSourceUse => ({ id, rev, accessEpoch });
const witnessOf = (fact: FactSnapshot, mode: 'pinned' | 'following'): BusWitness =>
  ({ ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode });
const witnessKey = (w: BusWitness) => `${knowledgeUseKey(w)}:${w.type}:${w.mode}`;
const witnessOrder = (l: BusWitness, r: BusWitness) => compareText(witnessKey(l), witnessKey(r));
const sortUses = (uses: Iterable<KnowledgeSourceUse>) =>
  [...uses].sort((l, r) => compareText(knowledgeUseKey(l), knowledgeUseKey(r)));
const whole = (edge: KnowledgeEdge) => edge.from.blockId === undefined && edge.to.blockId === undefined;

function stableJson(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as JsonObject;
  return `{${Object.keys(obj).filter(k => obj[k] !== undefined).sort(compareText)
    .map(k => `${JSON.stringify(k)}:${stableJson(obj[k]!)}`).join(',')}}`;
}
function compareUnknown(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (typeof left !== typeof right) return compareText(typeof left, typeof right);
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return compareText(left, right);
  return compareText(stableJson(left as Json), stableJson(right as Json));
}
function compareObjectValues(
  left: Readonly<Record<string, Json | undefined>>, right: Readonly<Record<string, Json | undefined>>,
): number {
  const lks = Object.keys(left).filter(k => left[k] !== undefined).sort(compareText);
  const rks = Object.keys(right).filter(k => right[k] !== undefined).sort(compareText);
  for (let i = 0; i < Math.max(lks.length, rks.length); i++) {
    const order = compareUnknown(lks[i], rks[i]) ||
      (lks[i] !== undefined && rks[i] !== undefined ? compareUnknown(left[lks[i]!], right[rks[i]!]) : 0);
    if (order) return order;
  }
  return 0;
}
function anchorOrder(left: JsonObject, right: JsonObject): number {
  for (const key of ANCHOR_KEYS) { const order = compareUnknown(left[key], right[key]); if (order) return order; }
  return compareObjectValues(left, right);
}
function validInput(input: {
  readonly scope: string; readonly items: readonly ArchetypeFoldingItem[];
  readonly memberships: ArchetypeFoldingEdgeSet; readonly variants: ArchetypeFoldingEdgeSet;
  readonly mastery?: { readonly complete: boolean; readonly asOf?: string; readonly clockWatermark?: ArchetypeFoldingClockWatermark };
}): boolean {
  const scope = input.scope.trim();
  const wm = input.mastery?.clockWatermark;
  const wmOk = wm === undefined || (typeof wm === 'string' && /^(?:0|[1-9][0-9]*)$/.test(wm)) ||
    (typeof wm === 'number' && Number.isSafeInteger(wm) && wm >= 0);
  return Boolean(scope && scope.length <= 1000 && input.items.length > 0 && input.items.length <= 128 &&
    input.memberships.complete && input.variants.complete && (input.mastery?.complete ?? true) && wmOk &&
    (input.mastery?.asOf === undefined || (typeof input.mastery.asOf === 'string' && input.mastery.asOf.trim().length > 0)) &&
    input.memberships.edgeIds.length <= 128 && input.variants.edgeIds.length <= 128 &&
    input.items.every(({ anchor, practice }) => anchor !== null && typeof anchor === 'object' && !Array.isArray(anchor) &&
      practice !== null && typeof practice === 'object' && !Array.isArray(practice) && practice.kind === 'activity' &&
      typeof practice.id === 'string' && practice.id.trim().length > 0 && Number.isSafeInteger(practice.rev) && practice.rev > 0));
}

function createFactReader(
  access: ArchetypeFoldingAccess,
  opts: { readonly serialize?: boolean; readonly witnesses?: Map<string, BusWitness> } = {},
) {
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
        const read = () => access.read.fact(id, pinned).then(fact => {
          if (opts.witnesses) {
            const w = witnessOf(fact, pinned.mode);
            opts.witnesses.set(witnessKey(w), w);
            for (const dep of access.dependenciesFor?.(w) ?? []) opts.witnesses.set(witnessKey(dep), dep);
          }
          return fact;
        });
        pending = opts.serialize ? tail.then(read) : read();
        if (opts.serialize) tail = pending.then(() => {}, () => {});
        cache.set(key, pending);
      }
      return (await pending) as FactSnapshot<Value>;
    },
  };
}

async function prepareItem(
  access: ArchetypeFoldingAccess, item: ArchetypeFoldingItem,
  reopenOrigin: (access: ArchetypeFoldingAccess, question: KnowledgeSourceUse, anchor: ArchetypeFoldingAnchor) =>
    Promise<ArchetypeFoldingOrigin | undefined>,
): Promise<CandidateItem | undefined> {
  const itemProof = new Map<string, BusWitness>();
  const scoped: ArchetypeFoldingAccess = { ...access, read: createFactReader(access, { witnesses: itemProof }) };
  try {
    const fact = await readKnowledgeUse(scoped, item.question, scoped.purpose);
    if (fact.ref.learner !== scoped.learner || knowledgeEndpointKind(fact) !== 'question') return undefined;
    if (fact.type === assetType) await checkTextbookBasis(scoped.read, parseAsset(fact.value).basis ?? []);
    else if (fact.type !== workspaceEntryType || !(await scoped.reopenLegacyQuestion?.(item.question))) return undefined;
    const origin = await reopenOrigin(scoped, item.question, item.anchor);
    if (!origin || (origin.kind === 'original' && !origin.key.trim())) return undefined;
    const normalized = origin.kind === 'original' ? { kind: 'original' as const, key: origin.key.trim() } : origin;
    return {
      ...item, origin: normalized, questionWitness: witnessOf(fact, 'pinned'), basis: itemProof,
      identity: normalized.kind === 'original' ? `original:${normalized.key}` : `question:${knowledgeUseKey(item.question)}`,
      copies: new Map([[knowledgeUseKey(item.question), item.question]]),
    };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return undefined;
  }
}

const memberOrder = (l: CandidateItem, r: CandidateItem) =>
  compareText(l.identity, r.identity) || compareText(knowledgeUseKey(l.question), knowledgeUseKey(r.question)) ||
  anchorOrder(l.anchor, r.anchor) || compareObjectValues(l.practice, r.practice);
const chooseMember = (items: readonly CandidateItem[]) => [...items].sort(memberOrder)[0]!;
const variantOrder = (l: PreparedVariant, r: PreparedVariant) => compareText(
  stableJson([l.witness.id, l.witness.rev, ...(l.edge.variant?.changed ?? [])]),
  stableJson([r.witness.id, r.witness.rev, ...(r.edge.variant?.changed ?? [])]),
);
const cardOrder = (
  l: ArchetypeFoldingCard | StandaloneArchetypeFoldingCard, r: ArchetypeFoldingCard | StandaloneArchetypeFoldingCard,
) => compareText(
  `${l.kind === 'archetype' ? l.title : 'question'}\0${knowledgeUseKey((l.kind === 'archetype' ? l.representative : l.question).question)}`,
  `${r.kind === 'archetype' ? r.title : 'question'}\0${knowledgeUseKey((r.kind === 'archetype' ? r.representative : r.question).question)}`,
);
const practiceTarget = (members: readonly ArchetypeFoldingMember[]) => [...members].sort((l, r) =>
  masteryPriority[l.mastery] - masteryPriority[r.mastery] ||
  compareText(knowledgeUseKey(l.question), knowledgeUseKey(r.question)) ||
  anchorOrder(l.anchor, r.anchor) || compareObjectValues(l.practice, r.practice))[0]!;

function mergeVariantDimensions(variants: readonly PreparedVariant[]) {
  const dims = new Map<string, BusWitness>();
  for (const v of variants) {
    for (const d of v.edge.variant?.changed ?? []) { const k = d.trim(); if (k && !dims.has(k)) dims.set(k, v.witness); }
  }
  return [...dims].map(([dimension, evidence]) => ({ dimension, evidence }));
}

function getOrCreateMap<K, MK, MV>(outer: Map<K, Map<MK, MV>>, key: K): Map<MK, MV> {
  let inner = outer.get(key);
  if (!inner) outer.set(key, inner = new Map());
  return inner;
}

/** Read a deterministic material-library folding projection in one host-bound snapshot. */
export async function readArchetypeFolding(
  access: ArchetypeFoldingAccess,
  input: {
    readonly scope: string; readonly items: readonly ArchetypeFoldingItem[];
    readonly memberships: ArchetypeFoldingEdgeSet; readonly variants: ArchetypeFoldingEdgeSet;
    readonly mastery?: {
      readonly complete: boolean; readonly asOf?: string; readonly clockWatermark?: ArchetypeFoldingClockWatermark;
      readonly read: (access: ArchetypeFoldingAccess, questions: readonly KnowledgeSourceUse[],
        at?: { readonly asOf?: string; readonly clockWatermark?: ArchetypeFoldingClockWatermark }) =>
        Promise<readonly ArchetypeFoldingMasteryRead[]>;
    };
  },
  reopenOrigin: (access: ArchetypeFoldingAccess, question: KnowledgeSourceUse, anchor: ArchetypeFoldingAnchor) =>
    Promise<ArchetypeFoldingOrigin | undefined>,
): Promise<ArchetypeFoldingProjection | undefined> {
  if (!access.purpose.trim() || !access.recipient.trim() || !validInput(input)) return undefined;
  const scope = input.scope.trim();
  const scopedBase: ArchetypeFoldingAccess = { ...access, read: createFactReader(access, { serialize: true }) };
  const membershipEdgeIds = [...new Set(input.memberships.edgeIds)].sort(compareText);
  const variantEdgeIds = [...new Set(input.variants.edgeIds)].sort(compareText);
  const allEdgeIds = [...new Set([...membershipEdgeIds, ...variantEdgeIds])].sort(compareText);
  if (allEdgeIds.length) await access.preloadFollowingEdges?.(allEdgeIds);

  const candidatesByQuestion = new Map<string, CandidateItem[]>();
  for (let i = 0; i < input.items.length; i += 16) {
    const prepared = await Promise.all(input.items.slice(i, i + 16).map(item => prepareItem(scopedBase, item, reopenOrigin)));
    for (const item of prepared) if (item) pushMapValue(candidatesByQuestion, knowledgeUseKey(item.question), item);
  }
  if (!candidatesByQuestion.size) return { cards: [], conflicts: [] };

  const preparedByIdentity = new Map<string, CandidateItem[]>();
  for (const items of candidatesByQuestion.values()) {
    const rep = chooseMember(items);
    const basis = new Map(rep.basis);
    for (const item of items) if (item.identity === rep.identity) for (const [k, w] of item.basis) basis.set(k, w);
    pushMapValue(preparedByIdentity, rep.identity, { ...rep, basis });
  }
  const preparedItems = new Map<string, CandidateItem>();
  const questionToIdentity = new Map<string, string>();
  for (const [identity, items] of preparedByIdentity) {
    const canonical = chooseMember(items);
    const basis = new Map(canonical.basis);
    const copies = new Map(canonical.copies);
    for (const item of items) {
      for (const [k, copy] of item.copies) if (!copies.has(k)) copies.set(k, copy);
      for (const [k, w] of item.basis) basis.set(k, w);
    }
    preparedItems.set(identity, { ...canonical, basis, copies });
    for (const copy of copies.values()) questionToIdentity.set(knowledgeUseKey(copy), identity);
  }

  const openEdge = (id: FactId, localProof: Map<string, BusWitness>) =>
    openKnowledgeEdgeRevision({ ...scopedBase, read: createFactReader(scopedBase, { witnesses: localProof }) }, id, { mode: 'following' });

  const groups = new Map<string, CanonicalGroup>();
  const membershipsByIdentity = new Map<string, Map<string, BusWitness>>();
  const basisByIdentity = new Map<string, Map<string, BusWitness>>();
  for (const id of membershipEdgeIds) {
    try {
      const localProof = new Map<string, BusWitness>();
      const opened = await openEdge(id, localProof);
      if (opened.edge.kind !== 'instance_of' || opened.edge.scope !== scope || !whole(opened.edge) ||
          opened.edge.from.kind !== 'question' || opened.edge.to.kind !== 'archetype') continue;
      const identity = questionToIdentity.get(knowledgeUseKey(opened.edge.from.sourceUse));
      const item = identity !== undefined ? preparedItems.get(identity) : undefined;
      if (!item) continue;
      const canonical = opened.edge.to.sourceUse;
      const groupKey = knowledgeUseKey(canonical);
      let group = groups.get(groupKey);
      if (!group) {
        const entityProof = new Map<string, BusWitness>();
        const entity = await openKnowledgeEntity(createFactReader(scopedBase, { witnesses: entityProof }), canonical.id, canonical.rev);
        group = {
          archetype: useOf(entity.snapshot), title: entity.entity.canonicalName,
          entityBasis: [...entityProof.values()], members: new Map(),
        };
        groups.set(groupKey, group);
      }
      const existing = group.members.get(item.identity);
      if (!existing || memberOrder(item, existing) < 0) group.members.set(item.identity, item);
      const member = group.members.get(item.identity)!;
      const witness = witnessOf(opened.snapshot, 'following');
      getOrCreateMap(membershipsByIdentity, member.identity).set(witnessKey(witness), witness);
      const basis = getOrCreateMap(basisByIdentity, member.identity);
      for (const [k, v] of localProof) basis.set(k, v);
      for (const v of group.entityBasis) basis.set(witnessKey(v), v);
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }

  const groupsByIdentity = new Map<string, Set<string>>();
  for (const [gk, group] of groups) for (const identity of group.members.keys()) addSetValue(groupsByIdentity, identity, gk);
  const conflictingIdentities = new Set<string>();
  const conflicts = [...groupsByIdentity].flatMap(([identity, gks]) => {
    if (gks.size <= 1) return [];
    conflictingIdentities.add(identity);
    return {
      question: preparedItems.get(identity)!.question,
      groups: [...gks].sort(compareText).map(gk => groups.get(gk)!.archetype),
      memberships: [...(membershipsByIdentity.get(identity)?.values() ?? [])].sort(witnessOrder),
    };
  }).sort((l, r) => compareText(knowledgeUseKey(l.question), knowledgeUseKey(r.question)));

  const variants: PreparedVariant[] = [];
  for (const id of variantEdgeIds) {
    try {
      const localProof = new Map<string, BusWitness>();
      const { edge, snapshot } = await openEdge(id, localProof);
      if (edge.kind !== 'variant_of' || edge.scope !== scope || !edge.variant || !whole(edge)) continue;
      const fromId = questionToIdentity.get(knowledgeUseKey(edge.from.sourceUse));
      const toId = questionToIdentity.get(knowledgeUseKey(edge.to.sourceUse));
      if (!fromId || !toId || fromId === toId || conflictingIdentities.has(fromId) || conflictingIdentities.has(toId)) continue;
      const fg = groupsByIdentity.get(fromId);
      const tg = groupsByIdentity.get(toId);
      const fromGroup = fg?.size === 1 ? [...fg][0] : undefined;
      if (fromGroup === undefined || tg?.size !== 1 || [...tg][0] !== fromGroup) continue;
      variants.push({ edge, witness: witnessOf(snapshot, 'following'), basis: [...localProof.values()].sort(witnessOrder) });
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }
  variants.sort(variantOrder);

  const groupedIdentities = new Set<string>();
  const candidateMap = new Map<string, CandidateItem>();
  for (const group of groups.values()) {
    for (const item of group.members.values()) {
      if (!conflictingIdentities.has(item.identity)) { groupedIdentities.add(item.identity); candidateMap.set(item.identity, item); }
    }
  }
  for (const item of preparedItems.values()) {
    if (!groupedIdentities.has(item.identity) && !conflictingIdentities.has(item.identity)) candidateMap.set(item.identity, item);
  }
  const uniqueCandidates = [...candidateMap.values()];

  const masteryByIdentity = new Map<string, { readonly mastery: ArchetypeFoldingMastery; readonly proof?: readonly BusWitness[] }>();
  if (input.mastery && uniqueCandidates.length) {
    const copiesByIdentity = new Map(uniqueCandidates.map(item => [item.identity, sortUses(item.copies.values())] as const));
    const flat = sortUses([...copiesByIdentity.values()].flat());
    const at = input.mastery.asOf !== undefined || input.mastery.clockWatermark !== undefined
      ? {
          ...(input.mastery.asOf !== undefined ? { asOf: input.mastery.asOf.trim() } : {}),
          ...(input.mastery.clockWatermark !== undefined ? { clockWatermark: input.mastery.clockWatermark } : {}),
        } : undefined;
    let masteryReads: readonly ArchetypeFoldingMasteryRead[];
    try { masteryReads = await input.mastery.read(scopedBase, flat, at); }
    catch (error) { if (!unavailable(access, error)) throw error; return undefined; }
    const readsByQuestion = new Map<string, ArchetypeFoldingMasteryRead[]>();
    for (const row of masteryReads) {
      if (!masteryValues.has(row.mastery)) return undefined;
      pushMapValue(readsByQuestion, knowledgeUseKey(row.question), row);
    }
    if (!flat.every(copy => readsByQuestion.has(knowledgeUseKey(copy)))) return undefined;
    for (const item of uniqueCandidates) {
      const rows = copiesByIdentity.get(item.identity)!.flatMap(c => readsByQuestion.get(knowledgeUseKey(c)) ?? [])
        .sort((l, r) => compareText(knowledgeUseKey(l.question), knowledgeUseKey(r.question)) ||
          masteryMergePriority[l.mastery] - masteryMergePriority[r.mastery] ||
          compareText(stableJson((l.proof ?? []) as Json), stableJson((r.proof ?? []) as Json)));
      const merged = [...rows.map(r => r.mastery)].sort((l, r) => masteryMergePriority[l] - masteryMergePriority[r])[0] ?? 'unknown';
      const proofs = [...new Map(rows.flatMap(r => r.proof ?? []).map(w => [witnessKey(w), w])).values()].sort(witnessOrder);
      masteryByIdentity.set(item.identity, { mastery: merged, ...(proofs.length ? { proof: proofs } : {}) });
    }
  }

  const memberOf = (item: CandidateItem, memberships: readonly BusWitness[]): ArchetypeFoldingMember => {
    const mastery = input.mastery ? masteryByIdentity.get(item.identity)! : { mastery: 'unknown' as const };
    const basis = [...new Map([...(basisByIdentity.get(item.identity) ?? new Map()), ...item.basis]).values()].sort(witnessOrder);
    return {
      question: item.question, anchor: item.anchor, origin: item.origin.kind, mastery: mastery.mastery,
      copies: sortUses(item.copies.values()), practice: item.practice,
      proof: {
        question: item.questionWitness, memberships: [...memberships].sort(witnessOrder), basis,
        ...('proof' in mastery && mastery.proof ? { mastery: mastery.proof } : {}),
      },
    };
  };

  const cards: (ArchetypeFoldingCard | StandaloneArchetypeFoldingCard)[] = [];
  for (const group of groups.values()) {
    const items = [...group.members.values()].filter(item => !conflictingIdentities.has(item.identity));
    if (!items.length) continue;
    const members = items.map(item => memberOf(item, [...(membershipsByIdentity.get(item.identity)?.values() ?? [])]))
      .sort((l, r) => anchorOrder(l.anchor, r.anchor) || compareText(knowledgeUseKey(l.question), knowledgeUseKey(r.question)));
    const groupVariants = variants.filter(v => {
      const id = questionToIdentity.get(knowledgeUseKey(v.edge.from.sourceUse));
      return id !== undefined && group.members.has(id);
    });
    const counts = { steady: 0, due: 0, weak: 0, unknown: 0 };
    for (const m of members) counts[m.mastery] += 1;
    cards.push({
      kind: 'archetype', archetype: group.archetype, title: group.title, representative: practiceTarget(members),
      members, coveredQuestionCount: members.length,
      steadyCount: counts.steady, dueCount: counts.due, weakCount: counts.weak, unknownCount: counts.unknown,
      variants: groupVariants.map(({ edge, witness, basis }) => {
        const fid = questionToIdentity.get(knowledgeUseKey(edge.from.sourceUse));
        const tid = questionToIdentity.get(knowledgeUseKey(edge.to.sourceUse));
        return {
          changed: edge.variant?.changed ?? [], edge: witness, basis: [...basis].sort(witnessOrder),
          from: fid !== undefined ? preparedItems.get(fid)!.question : edge.from.sourceUse,
          to: tid !== undefined ? preparedItems.get(tid)!.question : edge.to.sourceUse,
        };
      }),
      variationDimensions: mergeVariantDimensions(groupVariants),
    });
  }
  for (const item of preparedItems.values()) {
    if (!groupedIdentities.has(item.identity) && !conflictingIdentities.has(item.identity)) {
      cards.push({ kind: 'question', question: memberOf(item, []) });
    }
  }
  return { cards: cards.sort(cardOrder), conflicts };
}

export type ArchetypeClusterQuestionInput = {
  readonly id: FactId; readonly title: string; readonly mastery?: ArchetypeFoldingMastery;
  readonly sourcePaperId?: FactId; readonly sourcePaperTitle?: string; readonly conceptIds?: readonly FactId[];
  readonly purpose?: readonly string[]; readonly retracted?: boolean;
};
export type ArchetypeClusterArchetypeInput = {
  readonly id: FactId; readonly title: string; readonly conceptIds?: readonly FactId[];
  readonly purpose?: readonly string[]; readonly retracted?: boolean;
};
export type ArchetypeClusterEdgeInput = {
  readonly id?: FactId; readonly kind: 'instance_of' | 'canonical_archetype' | 'variant_of' | 'targets_concept';
  readonly fromId: FactId; readonly toId: FactId; readonly familyId?: string;
  readonly changed?: readonly string[]; readonly retracted?: boolean;
};
export type ArchetypeClusterMember = {
  readonly id: FactId; readonly title: string; readonly mastery: ArchetypeFoldingMastery;
  readonly via: 'instance_of' | 'variant_of' | 'shared_concept';
  readonly sourcePaperId?: FactId; readonly sourcePaperTitle?: string;
};
export type ArchetypeClusterCard = {
  readonly archetypeId: FactId; readonly title: string; readonly coveredQuestionCount: number;
  readonly coveredQuestionIds: readonly FactId[]; readonly coveredQuestions: readonly ArchetypeClusterMember[];
  readonly variationDimensions: readonly string[]; readonly unmasteredCount: number; readonly coverageLabel: string;
};
export type FoldArchetypeClustersInput = {
  readonly questions: readonly ArchetypeClusterQuestionInput[];
  readonly archetypes?: readonly ArchetypeClusterArchetypeInput[];
  readonly edges: readonly ArchetypeClusterEdgeInput[];
  readonly revokedIds?: ReadonlySet<string>; readonly requiredPurpose?: string; readonly includeSingletons?: boolean;
};
export type ArchetypeClusterProjection = {
  readonly cards: readonly ArchetypeClusterCard[]; readonly standaloneQuestionIds: readonly FactId[];
};

const clusterViaPriority = { instance_of: 0, variant_of: 1, shared_concept: 2 } as const;

function filterLatestActive<T extends { readonly id: FactId; readonly purpose?: readonly string[]; readonly retracted?: boolean }>(
  items: readonly T[] | undefined, requiredPurpose: string | undefined, extraExcluded: (item: T) => boolean,
) {
  const retractedIds = new Set<FactId>();
  const latest = new Map<FactId, T>();
  for (const item of items ?? []) { if (item.retracted === true) retractedIds.add(item.id); latest.set(item.id, item); }
  const active = new Map<FactId, T>();
  const excluded = new Set<FactId>();
  for (const item of latest.values()) {
    if (retractedIds.has(item.id) || extraExcluded(item) || !purposeAllowed(item.purpose, requiredPurpose)) excluded.add(item.id);
    else active.set(item.id, item);
  }
  return { active, excluded };
}

/** Pure data projection that folds school-paper questions into traceable archetype cluster cards. */
export function foldArchetypeClusters(input: FoldArchetypeClustersInput): ArchetypeClusterProjection {
  const requiredPurpose = input.requiredPurpose?.trim() || undefined;
  const revoked = (id: string | undefined) => id !== undefined && input.revokedIds?.has(id) === true;
  const { active: activeQuestions, excluded: excludedQuestionIds } = filterLatestActive(
    input.questions, requiredPurpose, q => revoked(q.id) || revoked(q.sourcePaperId),
  );
  const { active: activeArchetypes, excluded: excludedArchetypeIds } = filterLatestActive(
    input.archetypes, requiredPurpose, a => revoked(a.id),
  );
  const retractedEdgeIds = new Set<FactId>();
  for (const edge of input.edges) if (edge.id !== undefined && edge.retracted === true) retractedEdgeIds.add(edge.id);

  const activeEdges = input.edges.filter(edge =>
    edge.retracted !== true && (edge.id === undefined || !retractedEdgeIds.has(edge.id)) &&
    !revoked(edge.id) && !revoked(edge.fromId) && !revoked(edge.toId) &&
    !excludedQuestionIds.has(edge.fromId) && !excludedQuestionIds.has(edge.toId) &&
    !excludedArchetypeIds.has(edge.fromId) && !excludedArchetypeIds.has(edge.toId));

  type ClusterBucket = {
    readonly archetypeId: FactId; title?: string;
    readonly members: Map<FactId, ArchetypeClusterMember['via']>; readonly variationDimensions: Set<string>;
  };
  const buckets = new Map<FactId, ClusterBucket>();
  const ensureBucket = (archetypeId: FactId): ClusterBucket => {
    let bucket = buckets.get(archetypeId);
    if (!bucket) {
      const title = activeArchetypes.get(archetypeId)?.title ?? activeQuestions.get(archetypeId)?.title;
      bucket = { archetypeId, members: new Map(), variationDimensions: new Set(), ...(title !== undefined ? { title } : {}) };
      buckets.set(archetypeId, bucket);
    }
    return bucket;
  };
  const addMember = (bucket: ClusterBucket, questionId: FactId, via: ArchetypeClusterMember['via']) => {
    if (!activeQuestions.has(questionId)) return;
    const prev = bucket.members.get(questionId);
    if (prev === undefined || clusterViaPriority[via] < clusterViaPriority[prev]) bucket.members.set(questionId, via);
  };
  const collectDims = (bucket: ClusterBucket, changed: readonly string[] | undefined) => {
    for (const raw of changed ?? []) { const dim = raw.trim(); if (dim) bucket.variationDimensions.add(dim); }
  };
  for (const archetypeId of activeArchetypes.keys()) ensureBucket(archetypeId);

  const layer1ByQuestion = new Map<FactId, Set<FactId>>();
  for (const edge of activeEdges) {
    if ((edge.kind !== 'instance_of' && edge.kind !== 'canonical_archetype') || !activeQuestions.has(edge.fromId)) continue;
    const bucket = ensureBucket(edge.toId);
    addMember(bucket, edge.fromId, 'instance_of');
    addSetValue(layer1ByQuestion, edge.fromId, edge.toId);
    if (activeQuestions.has(edge.toId)) { addMember(bucket, edge.toId, 'instance_of'); addSetValue(layer1ByQuestion, edge.toId, edge.toId); }
  }

  const variantEdges = activeEdges.filter(edge => edge.kind === 'variant_of' && edge.fromId !== edge.toId);
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    const cur = parent.get(node);
    if (cur === undefined) { parent.set(node, node); return node; }
    if (cur === node) return node;
    const root = find(cur);
    parent.set(node, root);
    return root;
  };
  const adjacency = new Map<string, Set<string>>();
  const link = (left: string, right: string) => {
    const lr = find(left);
    const rr = find(right);
    if (lr !== rr) parent.set(compareText(lr, rr) < 0 ? rr : lr, compareText(lr, rr) < 0 ? lr : rr);
    addSetValue(adjacency, left, right);
    addSetValue(adjacency, right, left);
  };
  for (const edge of variantEdges) {
    const fk = `q:${edge.fromId}`;
    const tk = `q:${edge.toId}`;
    link(fk, tk);
    const family = edge.familyId?.trim();
    if (family) { link(fk, `f:${family}`); link(tk, `f:${family}`); }
  }
  const componentNodes = new Map<string, Set<string>>();
  for (const node of parent.keys()) addSetValue(componentNodes, find(node), node);
  const componentEdges = new Map<string, ArchetypeClusterEdgeInput[]>();
  for (const edge of variantEdges) pushMapValue(componentEdges, find(`q:${edge.fromId}`), edge);
  for (const root of [...componentNodes.keys()].sort(compareText)) {
    const nodes = componentNodes.get(root)!;
    const edgesInComp = componentEdges.get(root) ?? [];
    const compQuestions: FactId[] = [];
    const touched = new Set<FactId>();
    for (const node of nodes) {
      if (!node.startsWith('q:')) continue;
      const id = node.slice(2) as FactId;
      if (activeQuestions.has(id)) {
        compQuestions.push(id);
        for (const archId of layer1ByQuestion.get(id) ?? []) touched.add(archId);
      }
      if (activeArchetypes.has(id) || buckets.has(id)) touched.add(id);
    }
    compQuestions.sort(compareText);
    if (!compQuestions.length) continue;
    if (touched.size <= 1) {
      if (touched.size === 0 && compQuestions.length < 2) continue;
      const archId = touched.size === 1 ? [...touched][0]! : compQuestions[0]!;
      const bucket = ensureBucket(archId);
      if (touched.size === 0) bucket.title ??= activeQuestions.get(archId)!.title;
      for (const qId of compQuestions) addMember(bucket, qId, 'variant_of');
      for (const edge of edgesInComp) collectDims(bucket, edge.changed);
    } else {
      const distance = new Map<string, number>();
      const nearest = new Map<string, Set<FactId>>();
      const queue: string[] = [];
      const seed = (nodeKey: string, archIds: Iterable<FactId>) => {
        if (distance.has(nodeKey)) return;
        distance.set(nodeKey, 0);
        nearest.set(nodeKey, new Set(archIds));
        queue.push(nodeKey);
      };
      for (const qId of compQuestions) { const d = layer1ByQuestion.get(qId); if (d?.size === 1) seed(`q:${qId}`, d); }
      for (const node of [...nodes].sort(compareText)) {
        if (!node.startsWith('q:')) continue;
        const id = node.slice(2) as FactId;
        if (!layer1ByQuestion.has(id) && (activeArchetypes.has(id) || buckets.has(id))) seed(node, [id]);
      }
      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head]!;
        const nextDist = distance.get(cur)! + 1;
        const curArchs = nearest.get(cur)!;
        for (const nb of adjacency.get(cur) ?? []) {
          const prevDist = distance.get(nb);
          if (prevDist === undefined) { distance.set(nb, nextDist); nearest.set(nb, new Set(curArchs)); queue.push(nb); }
          else if (prevDist === nextDist) for (const archId of curArchs) nearest.get(nb)!.add(archId);
        }
      }
      for (const qId of compQuestions) {
        if (layer1ByQuestion.has(qId)) continue;
        const matched = nearest.get(`q:${qId}`);
        if (matched?.size === 1) addMember(ensureBucket([...matched][0]!), qId, 'variant_of');
      }
      for (const edge of edgesInComp) {
        for (const bucket of buckets.values()) {
          if ((bucket.members.has(edge.fromId) || edge.fromId === bucket.archetypeId) &&
              (bucket.members.has(edge.toId) || edge.toId === bucket.archetypeId)) collectDims(bucket, edge.changed);
        }
      }
    }
  }
  const conceptsByNode = new Map<FactId, Set<FactId>>();
  for (const node of [...activeQuestions.values(), ...activeArchetypes.values()]) {
    for (const cId of node.conceptIds ?? []) if (!revoked(cId)) addSetValue(conceptsByNode, node.id, cId);
  }
  for (const edge of activeEdges) if (edge.kind === 'targets_concept') addSetValue(conceptsByNode, edge.fromId, edge.toId);
  const assigned = new Set<FactId>();
  const clusterConcepts = new Map<FactId, Set<FactId>>();
  for (const bucket of buckets.values()) {
    const concepts = new Set<FactId>(conceptsByNode.get(bucket.archetypeId) ?? []);
    for (const memberId of bucket.members.keys()) {
      assigned.add(memberId);
      for (const cId of conceptsByNode.get(memberId) ?? []) concepts.add(cId);
    }
    if (concepts.size) clusterConcepts.set(bucket.archetypeId, concepts);
  }
  for (const qId of [...activeQuestions.keys()].sort(compareText)) {
    if (assigned.has(qId)) continue;
    const qConcepts = conceptsByNode.get(qId);
    if (!qConcepts?.size) continue;
    const matched = [...clusterConcepts].filter(([, cs]) => [...qConcepts].some(c => cs.has(c))).map(([id]) => id);
    if (matched.length === 1) addMember(buckets.get(matched[0]!)!, qId, 'shared_concept');
  }
  const cards: ArchetypeClusterCard[] = [];
  for (const bucket of buckets.values()) {
    const coveredQuestionIds = [...bucket.members.keys()].sort(compareText);
    const coveredQuestionCount = coveredQuestionIds.length;
    if (!coveredQuestionCount || (input.includeSingletons === false && coveredQuestionCount <= 1)) continue;
    const coveredQuestions: ArchetypeClusterMember[] = coveredQuestionIds.map(qId => {
      const q = activeQuestions.get(qId)!;
      return {
        id: q.id, title: q.title, mastery: q.mastery ?? 'unknown', via: bucket.members.get(qId)!,
        ...(q.sourcePaperId !== undefined ? { sourcePaperId: q.sourcePaperId } : {}),
        ...(q.sourcePaperTitle !== undefined ? { sourcePaperTitle: q.sourcePaperTitle } : {}),
      };
    });
    const title = activeArchetypes.get(bucket.archetypeId)?.title ?? activeQuestions.get(bucket.archetypeId)?.title ??
      bucket.title ?? coveredQuestions[0]!.title;
    cards.push({
      archetypeId: bucket.archetypeId, title, coveredQuestionCount, coveredQuestionIds, coveredQuestions,
      variationDimensions: [...bucket.variationDimensions].sort(compareText),
      unmasteredCount: coveredQuestions.filter(m => m.mastery !== 'steady').length,
      coverageLabel: `学透此母题覆盖 ${coveredQuestionCount} 道原卷题`,
    });
  }
  cards.sort((l, r) =>
    r.unmasteredCount - l.unmasteredCount || r.coveredQuestionCount - l.coveredQuestionCount ||
    compareText(l.archetypeId, r.archetypeId));
  const coveredSet = new Set<FactId>(cards.flatMap(c => c.coveredQuestionIds));
  return { cards, standaloneQuestionIds: [...activeQuestions.keys()].filter(id => !coveredSet.has(id)).sort(compareText) };
}
