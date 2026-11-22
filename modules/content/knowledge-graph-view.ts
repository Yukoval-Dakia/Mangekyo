import {
  FactNotFoundError,
  type BusWitness,
  type FactId,
  type FactSnapshot,
  type ReadContext,
} from '@mangekyo/kernel';
import {
  AssetBasisError,
  assetType,
  isPurposeWidenedContinuation,
  parseAsset,
  textbookPageFrom,
  textbookPageType,
  type Asset,
  type AssetBasis,
} from './asset.ts';
import {
  KnowledgeEdgeBasisError,
  knowledgeEdgeType,
  matchingKnowledgeEdgeEvidence,
  parseKnowledgeEdge,
  readKnowledgeUse,
  verifyKnowledgeEdge,
  workspaceEntryType,
  type KnowledgeEdge,
  type KnowledgeEdgeKind,
  type KnowledgeEndpoint,
} from './knowledge-edge.ts';
import {
  knowledgeEntityKinds,
  normalizeKnowledgeName,
  openKnowledgeEntity,
  type KnowledgeEntityKind,
} from './knowledge-entity.ts';
import type { KnowledgeReadAccess } from './knowledge-reads.ts';

export type KnowledgeGraphViewAccess = KnowledgeReadAccess & {
  /** Warm the bound following-fact cache for this snapshot. Each read still checks purpose and recipient. */
  readonly preloadFollowingEdges?: (ids: readonly FactId[]) => Promise<void>;
  /** Retain recursive dependencies recorded by the host's authorized reader for an exact fact read. */
  readonly dependenciesFor?: (witness: BusWitness) => readonly BusWitness[];
};

export type KnowledgeGraphProposalKind = 'node' | 'edge' | 'merge' | 'split' | (string & {});

export type KnowledgeGraphProposal = {
  readonly id: string;
  readonly kind: KnowledgeGraphProposalKind;
  readonly summary: string;
  readonly reason: string;
  readonly sourceRefs: readonly BusWitness[];
  readonly proposedAt: string;
};

export type KnowledgeGraphViewInput = {
  readonly entityIds: readonly FactId[];
  readonly edgeIds: readonly FactId[];
  readonly proposals?: readonly KnowledgeGraphProposal[];
  /** Optional authoritative update marker (such as changed_tick or ISO timestamp) keyed by FactId. */
  readonly updatedAtById?: Readonly<Record<string, string>>;
  readonly limit?: number;
  readonly subject?: string;
  readonly kinds?: readonly KnowledgeEntityKind[];
};

export type KnowledgeGraphNode = {
  readonly id: FactId;
  readonly kind: KnowledgeEntityKind;
  readonly title: string;
  readonly subject: string | null;
  readonly aliases: readonly string[];
  readonly questionCount: number;
  readonly textbookCount: number;
  readonly noteCount: number;
  readonly updatedAt: string;
  readonly proof: readonly BusWitness[];
};

export type KnowledgeGraphViewEdge = {
  readonly id: FactId;
  readonly from: FactId;
  readonly to: FactId;
  readonly kind: KnowledgeEdgeKind;
  readonly scope: string;
  readonly evidenceRef: BusWitness;
  readonly basis: readonly BusWitness[];
};

export type KnowledgeGraphView = {
  readonly nodes: readonly KnowledgeGraphNode[];
  readonly edges: readonly KnowledgeGraphViewEdge[];
  readonly pendingProposals: readonly KnowledgeGraphProposal[];
  readonly truncated: boolean;
};

const defaultLimit = 256;
const maxLimit = 1024;
const maxEntities = 1024;
const maxEdges = 2048;
const maxProposals = 256;
const maxProposalSourceRefs = 32;
const maxBasisFacts = 128;
const maxPreloadWaves = 16;
const explicitSubjectPrefix = /^(?:subject|discipline):(.+)$/iu;

type KnowledgeAsset = Extract<Asset, { readonly kind: KnowledgeEntityKind }>;
type CachedFact = {
  readonly fact: FactSnapshot;
  readonly witness: BusWitness;
  readonly proofs: readonly BusWitness[];
};
type Reader = ReturnType<typeof createGraphReader>;
type ScopedFactReader = {
  fact: ReadContext['fact'];
};
type DisciplineMeta = {
  readonly title: string;
  readonly proof: Map<string, BusWitness>;
};
type CanonicalGroup = {
  readonly id: FactId;
  readonly kind: KnowledgeEntityKind;
  readonly title: string;
  readonly canonicalRev: FactSnapshot['ref']['rev'];
  readonly canonicalAliases: Set<string>;
  readonly mergedAliases: Set<string>;
  readonly canonicalDirectDisciplines: Set<string>;
  readonly canonicalTagSubjects: Set<string>;
  readonly canonicalTransitiveDisciplines: Set<string>;
  readonly mergedDirectDisciplines: Set<string>;
  readonly mergedTagSubjects: Set<string>;
  readonly mergedTransitiveDisciplines: Set<string>;
  readonly edgeScopeSubjects: Set<string>;
  readonly proof: Map<string, BusWitness>;
  readonly backlinkProof: Map<string, BusWitness>;
  readonly subjectProof: Map<string, BusWitness>;
  readonly questionRefs: Set<string>;
  readonly textbookRefs: Set<string>;
  readonly noteRefs: Set<string>;
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function purposeAllows(purposes: readonly string[], required: string) {
  return purposes.includes('all') || purposes.includes(required);
}

function unavailable(access: KnowledgeReadAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

function normalizeWitness(witness: BusWitness): BusWitness {
  return {
    learner: witness.learner,
    id: witness.id,
    rev: witness.rev,
    type: witness.type,
    accessEpoch: witness.accessEpoch,
    mode: witness.mode,
  };
}

function witnessOf(fact: FactSnapshot, mode: 'pinned' | 'following'): BusWitness {
  return {
    learner: fact.ref.learner,
    id: fact.ref.id,
    rev: fact.ref.rev,
    type: fact.type,
    accessEpoch: fact.accessEpoch,
    mode,
  };
}

function witnessKey(witness: BusWitness) {
  return `${witness.learner}:${witness.id}:${witness.rev}:${witness.accessEpoch}:${witness.type}:${witness.mode}`;
}

function compareWitness(left: BusWitness, right: BusWitness) {
  return compareText(left.id, right.id) ||
    left.rev - right.rev ||
    compareText(left.accessEpoch, right.accessEpoch) ||
    compareText(left.type, right.type) ||
    compareText(left.mode, right.mode) ||
    compareText(left.learner, right.learner);
}

function witnessSet() {
  return new Map<string, BusWitness>();
}

function addWitnesses(target: Map<string, BusWitness>, witnesses: readonly BusWitness[]) {
  for (const raw of witnesses) {
    const normalized = normalizeWitness(raw);
    target.set(witnessKey(normalized), normalized);
  }
}

function mergeWitnessSets(target: Map<string, BusWitness>, ...sources: readonly (Map<string, BusWitness> | undefined)[]) {
  for (const source of sources) {
    if (!source) continue;
    for (const [entryKey, witness] of source) target.set(entryKey, witness);
  }
}

function witnessesOf(...sets: readonly (Map<string, BusWitness> | undefined)[]): readonly BusWitness[] {
  const merged = new Map<string, BusWitness>();
  mergeWitnessSets(merged, ...sets);
  return [...merged.values()].sort(compareWitness);
}

function uniqueSorted<Value extends string>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)].sort(compareText);
}

function isKnowledgeEntityKind(kind: string): kind is KnowledgeEntityKind {
  return (knowledgeEntityKinds as readonly string[]).includes(kind);
}

function isKnowledgeAsset(asset: Asset): asset is KnowledgeAsset {
  return asset.kind === 'concept' || asset.kind === 'method' || asset.kind === 'archetype';
}

function extractExplicitSubject(raw: string): string | undefined {
  const match = explicitSubjectPrefix.exec(raw.trim());
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

function extractTagSubjects(tags: readonly string[] | undefined): readonly string[] {
  if (!tags?.length) return [];
  const found: string[] = [];
  for (const tag of tags) {
    const extracted = extractExplicitSubject(tag);
    if (extracted) found.push(extracted);
  }
  return uniqueSorted(found);
}

function pickUnambiguousSubject(tiers: readonly ReadonlySet<string>[]): string | null {
  for (const tier of tiers) {
    if (tier.size === 1) return [...tier][0]!;
    if (tier.size > 1) return null;
  }
  return null;
}

function createGraphReader(access: KnowledgeGraphViewAccess, purpose: string) {
  const preloaded = new Set<FactId>();
  const followingCache = new Map<FactId, Promise<CachedFact>>();
  const pinnedCache = new Map<string, Promise<CachedFact>>();

  function wrapFact(
    fact: FactSnapshot,
    id: FactId,
    mode: 'pinned' | 'following',
    expectedRev?: FactSnapshot['ref']['rev'],
    requiredPurpose?: string,
  ): CachedFact {
    if (fact.ref.learner !== access.learner || fact.ref.id !== id) {
      throw new AssetBasisError('读取到的事实与请求学习者或标识不符。');
    }
    if (expectedRev !== undefined && fact.ref.rev !== expectedRev) {
      throw new AssetBasisError('读取到的事实版本与请求不符。');
    }
    if (!purposeAllows(fact.purpose, purpose) ||
        (requiredPurpose !== undefined && !purposeAllows(fact.purpose, requiredPurpose))) {
      throw new AssetBasisError('事实用途不满足当前视图授权要求。');
    }
    const witness = witnessOf(fact, mode);
    const deps = (access.dependenciesFor?.(witness) ?? []).map(normalizeWitness);
    return { fact, witness, proofs: [witness, ...deps] };
  }

  function fetchFollowing(id: FactId): Promise<CachedFact> {
    let pending = followingCache.get(id);
    if (!pending) {
      pending = access.read.fact(id, { mode: 'following' }).then(fact => wrapFact(fact, id, 'following'));
      followingCache.set(id, pending);
    }
    return pending;
  }

  return {
    isPreloaded(id: FactId) {
      return preloaded.has(id);
    },
    async preload(ids: readonly FactId[]) {
      if (!access.preloadFollowingEdges) return;
      const missing = uniqueSorted(ids).filter(id => !preloaded.has(id));
      if (!missing.length) return;
      await access.preloadFollowingEdges(missing);
      for (const id of missing) preloaded.add(id);
    },
    async fact(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<CachedFact> {
      if (options.mode === 'following') return fetchFollowing(id);
      const requiredPurpose = options.requirePurpose ?? purpose;
      const cacheKey = JSON.stringify([id, options.rev, requiredPurpose]);
      let pending = pinnedCache.get(cacheKey);
      if (!pending) {
        pending = (async () => {
          if (requiredPurpose === purpose && (followingCache.has(id) || preloaded.has(id))) {
            try {
              const current = await fetchFollowing(id);
              if (current.fact.ref.rev === options.rev) {
                return wrapFact(current.fact, id, 'pinned', options.rev, requiredPurpose);
              }
            } catch (error) {
              if (!unavailable(access, error) || error instanceof FactNotFoundError) throw error;
            }
          }
          const pinned = await access.read.fact(id, {
            mode: 'pinned',
            rev: options.rev,
            requirePurpose: requiredPurpose,
          });
          return wrapFact(pinned, id, 'pinned', options.rev, requiredPurpose);
        })();
        pinnedCache.set(cacheKey, pending);
      }
      return pending;
    },
  };
}

function reading(read: Reader, proof: Map<string, BusWitness>): ScopedFactReader {
  return {
    async fact<Value = FactSnapshot['value']>(
      id: FactId,
      options: Parameters<ReadContext['fact']>[1],
    ): Promise<FactSnapshot<Value>> {
      const opened = await read.fact(id, options);
      addWitnesses(proof, opened.proofs);
      return opened.fact as FactSnapshot<Value>;
    },
  };
}

function extractBasisEntries(fact: FactSnapshot): readonly AssetBasis[] {
  if (fact.type === assetType) {
    try {
      return parseAsset(fact.value).basis ?? [];
    } catch (error) {
      throw new AssetBasisError('内容资产格式无效。', { cause: error });
    }
  }
  if (fact.type === textbookPageType) {
    try {
      return textbookPageFrom(fact).basis ?? [];
    } catch (error) {
      throw new AssetBasisError('教材页格式无效。', { cause: error });
    }
  }
  return [];
}

async function verifyTransitiveBasis(
  scoped: ScopedFactReader,
  root: FactSnapshot,
): Promise<{ readonly directDisciplines: readonly string[]; readonly transitiveDisciplines: readonly string[] }> {
  const directDisciplines = new Set<string>();
  const transitiveDisciplines = new Set<string>();
  const visited = new Set<string>();
  const pending: { readonly entry: AssetBasis; readonly depth: number }[] =
    extractBasisEntries(root).map(entry => ({ entry, depth: 1 }));

  while (pending.length) {
    const { entry, depth } = pending.pop()!;
    const visitKey = `${entry.id}:${entry.rev}`;
    if (visited.has(visitKey)) continue;
    if (visited.size >= maxBasisFacts) throw new AssetBasisError('资产依据链超过上限。');
    visited.add(visitKey);

    const pinned = await scoped.fact(entry.id, { mode: 'pinned', rev: entry.rev });
    const opened = pinned.accessEpoch === entry.epoch ? pinned
      : await isPurposeWidenedContinuation(scoped, pinned, entry.epoch);
    if (!opened || opened.type !== entry.type) {
      throw new AssetBasisError('教材或资产依据已变更。');
    }
    if (opened.type === assetType) {
      let parsed: Asset;
      try {
        parsed = parseAsset(opened.value);
      } catch (error) {
        throw new AssetBasisError('内容资产依据格式无效。', { cause: error });
      }
      if (parsed.kind === 'discipline' && parsed.title.trim()) {
        if (depth === 1) directDisciplines.add(parsed.title.trim());
        else transitiveDisciplines.add(parsed.title.trim());
      }
    }
    for (const nested of extractBasisEntries(opened)) {
      pending.push({ entry: nested, depth: depth + 1 });
    }
  }
  return {
    directDisciplines: uniqueSorted([...directDisciplines]),
    transitiveDisciplines: uniqueSorted([...transitiveDisciplines]),
  };
}

async function preloadGraphClosure(
  access: KnowledgeGraphViewAccess,
  read: Reader,
  seedIds: readonly FactId[],
) {
  if (!access.preloadFollowingEdges) return;
  const inspected = new Set<FactId>();
  let frontier = uniqueSorted(seedIds);
  await read.preload(frontier);

  for (let wave = 0; wave < maxPreloadWaves && frontier.length > 0; wave += 1) {
    const nextIds = new Set<FactId>();
    for (const id of frontier) {
      if (inspected.has(id)) continue;
      inspected.add(id);
      let opened: CachedFact;
      try {
        opened = await read.fact(id, { mode: 'following' });
      } catch (error) {
        if (!unavailable(access, error)) throw error;
        continue;
      }
      if (opened.fact.type === assetType) {
        let asset: Asset;
        try {
          asset = parseAsset(opened.fact.value);
        } catch {
          continue;
        }
        if (isKnowledgeAsset(asset) && asset.merged_into !== null && !inspected.has(asset.merged_into)) {
          nextIds.add(asset.merged_into);
        }
        for (const entry of asset.basis ?? []) {
          if (!inspected.has(entry.id)) nextIds.add(entry.id);
        }
      } else if (opened.fact.type === textbookPageType) {
        try {
          for (const entry of textbookPageFrom(opened.fact).basis ?? []) {
            if (!inspected.has(entry.id)) nextIds.add(entry.id);
          }
        } catch {
          continue;
        }
      } else if (opened.fact.type === knowledgeEdgeType) {
        let edge: KnowledgeEdge;
        try {
          edge = parseKnowledgeEdge(opened.fact.value);
        } catch {
          continue;
        }
        for (const sourceUse of edge.sourceUses) {
          if (!inspected.has(sourceUse.id)) nextIds.add(sourceUse.id);
        }
        if (edge.verification && !inspected.has(edge.verification.id)) {
          nextIds.add(edge.verification.id);
        }
      }
    }
    const batch = [...nextIds].filter(id => !read.isPreloaded(id));
    if (!batch.length) break;
    await read.preload(batch);
    frontier = batch;
  }
}

function safeParseAsset(value: unknown): Asset | undefined {
  try {
    return parseAsset(value);
  } catch {
    return undefined;
  }
}

async function verifyProposal(
  access: KnowledgeGraphViewAccess,
  read: Reader,
  purpose: string,
  proposal: KnowledgeGraphProposal,
): Promise<KnowledgeGraphProposal | undefined> {
  const id = proposal.id.trim();
  const kind = proposal.kind.trim();
  const summary = proposal.summary.trim();
  const reason = proposal.reason.trim();
  const proposedAt = proposal.proposedAt.trim();
  if (!id || !kind || !summary || !reason || !proposedAt) return undefined;
  if (!proposal.sourceRefs.length || proposal.sourceRefs.length > maxProposalSourceRefs) return undefined;

  const verifiedRefs = witnessSet();
  for (const ref of proposal.sourceRefs) {
    if (ref.learner !== access.learner || (ref.mode !== 'pinned' && ref.mode !== 'following')) {
      return undefined;
    }
    try {
      const proof = witnessSet();
      const scoped = reading(read, proof);
      const first = ref.mode === 'pinned'
        ? await scoped.fact(ref.id, { mode: 'pinned', rev: ref.rev, requirePurpose: purpose })
        : await scoped.fact(ref.id, { mode: 'following' });
      // A recorded witness survives a pure monotone purpose widening; the chain
      // check re-reads the recorded rev and follows each hop to current.
      const exact = first.ref.rev === ref.rev && first.accessEpoch === ref.accessEpoch;
      const widened = !exact
        ? await isPurposeWidenedContinuation(scoped,
            first.ref.rev === ref.rev ? first
              : await scoped.fact(ref.id, { mode: 'pinned', rev: ref.rev, requirePurpose: purpose }),
            ref.accessEpoch)
        : undefined;
      const opened = exact ? first : widened;
      if (!opened || opened.ref.learner !== access.learner ||
          opened.ref.id !== ref.id || opened.type !== ref.type) {
        return undefined;
      }
      if (opened.type === assetType || opened.type === textbookPageType) {
        await verifyTransitiveBasis(scoped, opened);
        if (opened.type === assetType) {
          const asset = safeParseAsset(opened.value);
          if (!asset) return undefined;
          if (isKnowledgeAsset(asset) && asset.merged_into !== null) {
            const redirected = await openKnowledgeEntity(scoped, opened.ref.id);
            await verifyTransitiveBasis(scoped, redirected.snapshot);
          }
        }
      } else if (opened.type === knowledgeEdgeType) {
        let edge: KnowledgeEdge;
        try {
          edge = parseKnowledgeEdge(opened.value);
        } catch {
          return undefined;
        }
        const basisFacts = await verifyKnowledgeEdge({ learner: access.learner, read: scoped }, edge);
        for (const basisFact of basisFacts) await verifyTransitiveBasis(scoped, basisFact);
        if (edge.verification) {
          const { verification, ...claim } = edge;
          const proofFact = await readKnowledgeUse({ learner: access.learner, read: scoped }, verification);
          let matched;
          try {
            matched = matchingKnowledgeEdgeEvidence(proofFact, claim);
          } catch {
            return undefined;
          }
          if (!matched) return undefined;
        }
      }
      const verified = witnessOf(opened, ref.mode);
      verifiedRefs.set(witnessKey(verified), verified);
    } catch (error) {
      if (!unavailable(access, error)) throw error;
      return undefined;
    }
  }

  return {
    id,
    kind,
    summary,
    reason,
    sourceRefs: witnessesOf(verifiedRefs),
    proposedAt,
  };
}

function backlinkKey(endpoint: KnowledgeEndpoint) {
  return `${endpoint.sourceUse.id}:${endpoint.blockId ?? ''}`;
}

function resolveScopeSubject(
  scope: string,
  disciplinesByKey: ReadonlyMap<string, DisciplineMeta>,
): { readonly subject: string; readonly proof?: Map<string, BusWitness> } | undefined {
  const explicit = extractExplicitSubject(scope);
  if (explicit) return { subject: explicit };
  const matched = disciplinesByKey.get(scope.trim());
  if (matched) return { subject: matched.title, proof: matched.proof };
  return undefined;
}

/** Pass an authorized, snapshot-bound reader and the complete entity/edge/proposal candidate sets.
 * Entities fold through merged_into redirects; edges project to canonical nodes.
 * Unreadable items are removed individually; operational errors propagate.
 * Output order is deterministic and independent of input order. */
export async function readKnowledgeGraphView(
  access: KnowledgeGraphViewAccess,
  input: KnowledgeGraphViewInput,
): Promise<KnowledgeGraphView | undefined> {
  const purpose = access.purpose.trim();
  const recipient = access.recipient.trim();
  if (!purpose || !recipient ||
      input.entityIds.length > maxEntities || input.edgeIds.length > maxEdges ||
      (input.proposals?.length ?? 0) > maxProposals) return undefined;

  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    return undefined;
  }
  const limit = Math.min(input.limit ?? defaultLimit, maxLimit);

  let subjectFilter: string | undefined;
  if (input.subject !== undefined) {
    const trimmed = input.subject.trim();
    if (!trimmed) return undefined;
    subjectFilter = trimmed;
  }
  const kindFilter = input.kinds === undefined ? undefined : new Set(input.kinds);
  const read = createGraphReader(access, purpose);

  const entityIds = uniqueSorted(input.entityIds);
  const edgeIds = uniqueSorted(input.edgeIds);
  const proposalSourceIds: FactId[] = [];
  for (const proposal of input.proposals ?? []) {
    for (const ref of proposal.sourceRefs) {
      if (ref.learner === access.learner) proposalSourceIds.push(ref.id);
    }
  }

  await preloadGraphClosure(access, read, [...entityIds, ...edgeIds, ...proposalSourceIds]);

  const disciplinesByKey = new Map<string, DisciplineMeta>();
  const canonicalGroups = new Map<FactId, CanonicalGroup>();

  function getOrCreateGroup(
    canonicalFact: FactSnapshot,
    canonicalAsset: KnowledgeAsset,
    directDisciplines: readonly string[],
    transitiveDisciplines: readonly string[],
  ): CanonicalGroup {
    const existing = canonicalGroups.get(canonicalFact.ref.id);
    if (existing) return existing;
    const created: CanonicalGroup = {
      id: canonicalFact.ref.id,
      kind: canonicalAsset.kind,
      title: canonicalAsset.title,
      canonicalRev: canonicalFact.ref.rev,
      canonicalAliases: new Set(canonicalAsset.aliases),
      mergedAliases: new Set(),
      canonicalDirectDisciplines: new Set(directDisciplines),
      canonicalTagSubjects: new Set(extractTagSubjects(canonicalAsset.tags)),
      canonicalTransitiveDisciplines: new Set(transitiveDisciplines),
      mergedDirectDisciplines: new Set(),
      mergedTagSubjects: new Set(),
      mergedTransitiveDisciplines: new Set(),
      edgeScopeSubjects: new Set(),
      proof: witnessSet(),
      backlinkProof: witnessSet(),
      subjectProof: witnessSet(),
      questionRefs: new Set(),
      textbookRefs: new Set(),
      noteRefs: new Set(),
    };
    canonicalGroups.set(canonicalFact.ref.id, created);
    return created;
  }

  for (const id of entityIds) {
    try {
      const proof = witnessSet();
      const scoped = reading(read, proof);
      const initial = await scoped.fact(id, { mode: 'following' });
      if (initial.type !== assetType) continue;
      const initialAsset = safeParseAsset(initial.value);
      if (!initialAsset) continue;

      if (initialAsset.kind === 'discipline') {
        await verifyTransitiveBasis(scoped, initial);
        const title = initialAsset.title.trim();
        if (title) {
          const meta: DisciplineMeta = { title, proof };
          disciplinesByKey.set(title, meta);
          const learningScope = initialAsset.discipline_context?.learningScope.trim();
          if (learningScope && !disciplinesByKey.has(learningScope)) {
            disciplinesByKey.set(learningScope, meta);
          }
        }
        continue;
      }
      if (!isKnowledgeAsset(initialAsset)) continue;

      type ChainStep = {
        readonly fact: FactSnapshot;
        readonly asset: KnowledgeAsset;
        readonly directDisciplines: readonly string[];
        readonly transitiveDisciplines: readonly string[];
      };
      const chain: ChainStep[] = [];
      const visited = new Set<FactId>();
      const expectedKind = initialAsset.kind;
      let cursorFact = initial;
      let cursorAsset: KnowledgeAsset = initialAsset;

      for (;;) {
        if (cursorFact.ref.learner !== access.learner || cursorAsset.kind !== expectedKind) {
          throw new AssetBasisError('规范实体重定向类型或学习者不符。');
        }
        const { directDisciplines, transitiveDisciplines } = await verifyTransitiveBasis(scoped, cursorFact);
        chain.push({ fact: cursorFact, asset: cursorAsset, directDisciplines, transitiveDisciplines });
        if (cursorAsset.merged_into === null) break;
        if (visited.has(cursorFact.ref.id)) throw new AssetBasisError('规范实体重定向成环。');
        visited.add(cursorFact.ref.id);

        const nextFact = await scoped.fact(cursorAsset.merged_into, { mode: 'following' });
        if (nextFact.type !== assetType) throw new AssetBasisError('规范实体类型不符。');
        const nextAsset = safeParseAsset(nextFact.value);
        if (!nextAsset || !isKnowledgeAsset(nextAsset)) throw new AssetBasisError('规范实体类型不符。');
        cursorFact = nextFact;
        cursorAsset = nextAsset;
      }

      const canonical = chain[chain.length - 1]!;
      const group = getOrCreateGroup(
        canonical.fact,
        canonical.asset,
        canonical.directDisciplines,
        canonical.transitiveDisciplines,
      );
      mergeWitnessSets(group.proof, proof);

      for (const sourceStep of chain.slice(0, -1)) {
        group.mergedAliases.add(sourceStep.asset.title);
        for (const alias of sourceStep.asset.aliases) group.mergedAliases.add(alias);
        for (const discipline of sourceStep.directDisciplines) group.mergedDirectDisciplines.add(discipline);
        for (const discipline of sourceStep.transitiveDisciplines) group.mergedTransitiveDisciplines.add(discipline);
        for (const tagSubject of extractTagSubjects(sourceStep.asset.tags)) group.mergedTagSubjects.add(tagSubject);
      }
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }

  const edges: KnowledgeGraphViewEdge[] = [];
  const directQuestionTargets = new Map<FactId, Set<FactId>>();
  const variantQuestionBacklinks: {
    readonly variant: KnowledgeEndpoint;
    readonly baseId: FactId;
    readonly proof: Map<string, BusWitness>;
  }[] = [];
  for (const id of edgeIds) {
    try {
      const proof = witnessSet();
      const scoped = reading(read, proof);
      const snapshot = await scoped.fact(id, { mode: 'following' });
      if (snapshot.type !== knowledgeEdgeType) continue;

      let edge: KnowledgeEdge;
      try {
        edge = parseKnowledgeEdge(snapshot.value);
      } catch {
        continue;
      }

      const basisFacts = await verifyKnowledgeEdge({ learner: access.learner, read: scoped }, edge);
      for (const fact of basisFacts) {
        await verifyTransitiveBasis(scoped, fact);
      }

      let verificationWitness: BusWitness | undefined;
      if (edge.verification) {
        const { verification, ...claim } = edge;
        const proofFact = await readKnowledgeUse({ learner: access.learner, read: scoped }, verification);
        let matched;
        try {
          matched = matchingKnowledgeEdgeEvidence(proofFact, claim);
        } catch {
          continue;
        }
        if (!matched) continue;
        verificationWitness = witnessOf(proofFact, 'pinned');
      }

      const project = async (endpoint: KnowledgeEndpoint) => {
        if (!isKnowledgeEntityKind(endpoint.kind)) return endpoint;
        const fact = basisFacts.find(candidate =>
          candidate.ref.id === endpoint.sourceUse.id && candidate.ref.rev === endpoint.sourceUse.rev) ??
          basisFacts.find(candidate =>
            candidate.ref.id === endpoint.sourceUse.id && candidate.ref.rev > endpoint.sourceUse.rev);
        if (!fact || fact.type !== assetType) throw new KnowledgeEdgeBasisError('图谱端点类型不符。');
        const opened = await openKnowledgeEntity(scoped, fact.ref.id);
        if (opened.entity.kind !== endpoint.kind || opened.snapshot.ref.learner !== access.learner ||
            (endpoint.blockId !== undefined &&
             (opened.snapshot.ref.id !== fact.ref.id || opened.snapshot.ref.rev !== fact.ref.rev))) {
          throw new KnowledgeEdgeBasisError('图谱端点重定向后类型或锚点不再有效。');
        }
        await verifyTransitiveBasis(scoped, opened.snapshot);
        return {
          ...endpoint,
          sourceUse: {
            id: opened.snapshot.ref.id,
            rev: opened.snapshot.ref.rev,
            accessEpoch: opened.snapshot.accessEpoch,
          },
        };
      };

      const from = await project(edge.from);
      const to = await project(edge.to);
      const fromEntityId = isKnowledgeEntityKind(from.kind) ? from.sourceUse.id : undefined;
      const toEntityId = isKnowledgeEntityKind(to.kind) ? to.sourceUse.id : undefined;

      const scopeSubject = resolveScopeSubject(edge.scope, disciplinesByKey);
      if (scopeSubject) {
        for (const touchedId of [fromEntityId, toEntityId]) {
          if (!touchedId) continue;
          const touchedGroup = canonicalGroups.get(touchedId);
          if (!touchedGroup) continue;
          touchedGroup.edgeScopeSubjects.add(scopeSubject.subject);
          mergeWitnessSets(touchedGroup.subjectProof, scopeSubject.proof);
        }
      }

      if (fromEntityId !== undefined && toEntityId !== undefined && fromEntityId !== toEntityId) {
        const edgeWitness = witnessOf(snapshot, 'following');
        edges.push({
          id,
          from: fromEntityId,
          to: toEntityId,
          kind: edge.kind,
          scope: edge.scope,
          evidenceRef: verificationWitness ?? edgeWitness,
          basis: witnessesOf(proof),
        });
      }

      const recordBacklink = (
        targetId: FactId,
        bucket: 'questionRefs' | 'textbookRefs' | 'noteRefs',
        sourceEndpoint: KnowledgeEndpoint,
      ) => {
        const targetGroup = canonicalGroups.get(targetId);
        if (!targetGroup) return;
        targetGroup[bucket].add(backlinkKey(sourceEndpoint));
        mergeWitnessSets(targetGroup.backlinkProof, proof);
      };

      if ((edge.kind === 'targets_concept' || edge.kind === 'instance_of') &&
          from.kind === 'question' && toEntityId !== undefined) {
        const fromFact = basisFacts.find(candidate =>
          candidate.ref.id === edge.from.sourceUse.id && candidate.ref.rev === edge.from.sourceUse.rev);
        if (fromFact?.type === workspaceEntryType && !await access.reopenLegacyQuestion?.(edge.from.sourceUse)) {
          continue;
        }
        recordBacklink(toEntityId, 'questionRefs', edge.from);
        if (edge.from.blockId === undefined) {
          let targets = directQuestionTargets.get(edge.from.sourceUse.id);
          if (!targets) {
            targets = new Set<FactId>();
            directQuestionTargets.set(edge.from.sourceUse.id, targets);
          }
          targets.add(toEntityId);
        }
      } else if (
        edge.kind === 'variant_of' &&
        from.kind === 'question' &&
        to.kind === 'question' &&
        edge.from.blockId === undefined &&
        edge.to.blockId === undefined &&
        edge.from.sourceUse.id !== edge.to.sourceUse.id
      ) {
        const fromFact = basisFacts.find(candidate =>
          candidate.ref.id === edge.from.sourceUse.id && candidate.ref.rev === edge.from.sourceUse.rev);
        const toFact = basisFacts.find(candidate =>
          candidate.ref.id === edge.to.sourceUse.id && candidate.ref.rev === edge.to.sourceUse.rev);
        if ((fromFact?.type === workspaceEntryType && !await access.reopenLegacyQuestion?.(edge.from.sourceUse)) ||
            (toFact?.type === workspaceEntryType && !await access.reopenLegacyQuestion?.(edge.to.sourceUse))) {
          continue;
        }
        variantQuestionBacklinks.push({ variant: edge.from, baseId: edge.to.sourceUse.id, proof });
      } else if (edge.kind === 'maps_to_chapter' && fromEntityId !== undefined && to.kind === 'chapter') {
        recordBacklink(fromEntityId, 'textbookRefs', edge.to);
      } else if (edge.kind === 'explains') {
        if (toEntityId !== undefined && from.kind === 'chapter') {
          recordBacklink(toEntityId, 'textbookRefs', edge.from);
        } else if (fromEntityId !== undefined && to.kind === 'chapter') {
          recordBacklink(fromEntityId, 'textbookRefs', edge.to);
        } else if (toEntityId !== undefined && from.kind === 'note') {
          recordBacklink(toEntityId, 'noteRefs', edge.from);
        } else if (fromEntityId !== undefined && to.kind === 'note') {
          recordBacklink(fromEntityId, 'noteRefs', edge.to);
        }
      }
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }

  for (const { variant, baseId, proof } of variantQuestionBacklinks) {
    const targets = directQuestionTargets.get(baseId);
    if (!targets) continue;
    for (const targetId of targets) {
      const targetGroup = canonicalGroups.get(targetId);
      if (!targetGroup) continue;
      const key = backlinkKey(variant);
      if (targetGroup.questionRefs.has(key)) continue;
      targetGroup.questionRefs.add(key);
      mergeWitnessSets(targetGroup.backlinkProof, proof);
    }
  }

  const nodes: KnowledgeGraphNode[] = [];
  for (const group of [...canonicalGroups.values()].sort((left, right) => compareText(left.id, right.id))) {
    if (kindFilter && !kindFilter.has(group.kind)) continue;
    const subject = pickUnambiguousSubject([
      group.canonicalDirectDisciplines,
      group.canonicalTagSubjects,
      group.canonicalTransitiveDisciplines,
      group.mergedDirectDisciplines,
      group.mergedTagSubjects,
      group.mergedTransitiveDisciplines,
      group.edgeScopeSubjects,
    ]);
    if (subjectFilter !== undefined && subject !== subjectFilter) continue;

    const normalizedTitle = normalizeKnowledgeName(group.title);
    const aliases = uniqueSorted(
      [...group.canonicalAliases, ...group.mergedAliases].filter(
        alias => normalizeKnowledgeName(alias) !== normalizedTitle,
      ),
    );
    const hostUpdatedAt = input.updatedAtById?.[group.id]?.trim();
    const updatedAt = hostUpdatedAt && hostUpdatedAt.length > 0 ? hostUpdatedAt : `rev:${group.canonicalRev}`;

    nodes.push({
      id: group.id,
      kind: group.kind,
      title: group.title,
      subject,
      aliases,
      questionCount: group.questionRefs.size,
      textbookCount: group.textbookRefs.size,
      noteCount: group.noteRefs.size,
      updatedAt,
      proof: witnessesOf(group.proof, group.backlinkProof, group.subjectProof),
    });
  }

  const visibleNodes = nodes.slice(0, limit);
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id));
  const matchingEdges = edges
    .filter(edge => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to))
    .sort((left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.to, right.to) ||
      compareText(left.kind, right.kind) ||
      compareText(left.id, right.id));
  const visibleEdges = matchingEdges.slice(0, limit);

  const sortedProposals = [...(input.proposals ?? [])].sort((left, right) =>
    compareText(left.id.trim(), right.id.trim()) ||
    compareText(left.proposedAt.trim(), right.proposedAt.trim()) ||
    compareText(left.kind.trim(), right.kind.trim()) ||
    compareText(left.summary.trim(), right.summary.trim()) ||
    compareText(left.reason.trim(), right.reason.trim()));
  const proposals: KnowledgeGraphProposal[] = [];
  const seenProposalIds = new Set<string>();
  for (const candidate of sortedProposals) {
    const verified = await verifyProposal(access, read, purpose, candidate);
    if (!verified || seenProposalIds.has(verified.id)) continue;
    seenProposalIds.add(verified.id);
    proposals.push(verified);
  }
  const visibleProposals = proposals.slice(0, limit);

  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    pendingProposals: visibleProposals,
    truncated:
      nodes.length > visibleNodes.length ||
      matchingEdges.length > visibleEdges.length ||
      proposals.length > visibleProposals.length,
  };
}
