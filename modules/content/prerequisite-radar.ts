import { FactNotFoundError, type BusWitness, type FactId, type FactSnapshot } from '@mangekyo/kernel';
import { AssetBasisError } from './asset.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey, openKnowledgeWalkEdge,
  type KnowledgeEdge, type KnowledgeEndpoint, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { openKnowledgeQuestion } from './knowledge-reads.ts';
import { record } from './parse.ts';
import {
  openCurrentTextbookBlock, proofReader, readTextbookBlockConcepts, readTextbookPulseQuestion,
  type TextbookPulseBlock, type TextbookPulseEdgeSet, type TextbookPulseQuestionAccess,
} from './textbook-mastery-pulse.ts';

type BlockWitness = BusWitness & { readonly blockId: string };
type Proof = Map<string, BusWitness>;

export type PrerequisiteRadarAccess = TextbookPulseQuestionAccess & {
  /** Bound snapshotFactReaders.preloadFollowing. Candidates include current concept IDs. */
  readonly preloadFollowingEdges: (ids: readonly FactId[]) => Promise<void>;
  /** Bind Capture's current-block reader to this recipient and snapshot. Open the original
   * edge pin through it and return the selection and any other Capture witnesses it used. */
  readonly openNotionBlock?: (pin: TextbookPulseBlock) => Promise<{
    readonly text: string;
    readonly basis: readonly [BusWitness, ...BusWitness[]];
  } | undefined>;
};

export type PrerequisiteRadarInput = {
  readonly root: { readonly conceptIds: readonly FactId[] } & (
    | { readonly kind: 'question'; readonly source: KnowledgeSourceUse }
    | { readonly kind: 'textbook-block'; readonly source: TextbookPulseBlock }
  );
  readonly rootEdges: TextbookPulseEdgeSet;
  readonly prerequisiteEdges: TextbookPulseEdgeSet;
  readonly summaryEdges: TextbookPulseEdgeSet;
  readonly quickCheck?: {
    readonly complete: boolean;
    readonly targetEdges: TextbookPulseEdgeSet;
    readonly variantEdgeIds: readonly FactId[];
    readonly archetypeEdgeIds: readonly FactId[];
  };
};

type Summary = {
  readonly kind: 'textbook-block' | 'notion-block';
  readonly block: BlockWitness;
  readonly text: string;
  readonly edge: BusWitness;
  readonly basis: readonly BusWitness[];
};

export type PrerequisiteRadarRow = {
  readonly root: BusWitness;
  readonly prerequisite: BusWitness;
  readonly edge: BusWitness;
  readonly title: string;
  readonly basis: readonly BusWitness[];
  readonly summary?: Summary;
  readonly quickCheck?: { readonly question: BusWitness; readonly basis: readonly BusWitness[] };
};

function witness(fact: FactSnapshot, mode: BusWitness['mode'] = 'following'): BusWitness {
  return { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode };
}

function addProof(proof: Proof, witnesses: readonly BusWitness[]) {
  for (const row of witnesses) proof.set(`${knowledgeUseKey(row)}:${row.type}:${row.mode}`, row);
}

const wholeConcept = (endpoint: KnowledgeEndpoint) => endpoint.kind === 'concept' && endpoint.blockId === undefined;
const bounded = (set: TextbookPulseEdgeSet) => set.complete && set.edgeIds.length <= 128;
const sortedIds = (ids: readonly FactId[]) => [...new Set(ids)].sort();

function excerpt(text: string) {
  const line = text.trim().split(/\r?\n/u, 1)[0]!.trim();
  const first = line.match(/^.*?(?:[。！？!?]|\.(?=\s|$))/u)?.[0] ?? line;
  const chars = [...first];
  return chars.length > 160 ? chars.slice(0, 159).join('') + '…' : first;
}

/** Read inside one authorized snapshot. The host enumerates complete relation candidates
 * for this exact root and binds all reads to the real learner, purpose and recipient.
 * Include edges still pinned to pre-merge concepts that follow to the current endpoints.
 * Re-enumerate and rerun before display or issue. Keep the result and witnesses server-side.
 * Count weakness across all returned relations; absence of summary or quickCheck grants
 * no remediation. The learner domain can supply a separately authorized past-stable item. */
export async function readPrerequisiteRadar(access: PrerequisiteRadarAccess, input: PrerequisiteRadarInput):
Promise<readonly PrerequisiteRadarRow[] | undefined> {
  const { root, rootEdges, prerequisiteEdges, summaryEdges } = input;
  if (!access.purpose.trim() || !access.recipient.trim() || !bounded(rootEdges) ||
      !bounded(prerequisiteEdges) || !bounded(summaryEdges) || root.conceptIds.length > 128) return;
  const quick = input.quickCheck;
  const pool = quick?.complete && bounded(quick.targetEdges) && quick.variantEdgeIds.length <= 128 &&
    quick.archetypeEdgeIds.length <= 128 ? quick : undefined;
  const candidates = sortedIds([...rootEdges.edgeIds, ...prerequisiteEdges.edgeIds, ...summaryEdges.edgeIds,
    ...(pool ? [...pool.targetEdges.edgeIds, ...pool.variantEdgeIds, ...pool.archetypeEdgeIds] : []), ...root.conceptIds]);
  const readFor = proofReader(access);
  const scoped = (proof: Proof): PrerequisiteRadarAccess => ({
    ...access, read: { ...access.read, ...readFor(proof) },
  });
  async function available<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof AssetBasisError ||
          error instanceof KnowledgeEdgeBasisError || access.isUnavailable(error))) throw error;
      return undefined;
    }
  }
  function openEdge(scope: PrerequisiteRadarAccess, id: FactId, acceptEdge: (edge: KnowledgeEdge) => boolean) {
    return openKnowledgeWalkEdge(scope, id, { mode: 'following', acceptEdge, classifyMalformed: true });
  }
  async function currentConcept(scope: PrerequisiteRadarAccess, id: FactId, expected?: KnowledgeSourceUse) {
    const fact = await scope.read.fact(id, { mode: 'following' });
    if (fact.ref.learner !== access.learner || fact.ref.id !== id || knowledgeEndpointKind(fact) !== 'concept' ||
        (expected && knowledgeUseKey(witness(fact)) !== knowledgeUseKey(expected))) return;
    return fact;
  }

  async function rootProofs() {
    const links = new Map<FactId, readonly BusWitness[]>();
    if (root.kind === 'textbook-block') {
      // All candidates were prefetched through the same bound reader.
      const { preloadFollowingEdges: _preloaded, ...base } = scoped(new Map());
      await readTextbookBlockConcepts(base, { block: root.source, edges: rootEdges }, proof => {
        for (const path of proof.concepts) {
          if (!links.has(path.conceptId)) links.set(path.conceptId, [...proof.basis, ...path.basis]);
        }
      });
      return links;
    }
    const basis: Proof = new Map();
    const question = await openKnowledgeQuestion(scoped(basis), root.source);
    if (!question) return;
    for (const id of sortedIds(rootEdges.edgeIds)) {
      const branch = new Map(basis);
      const opened = await available(() => openEdge(scoped(branch), id, ({ kind, from, to }) =>
        kind === 'targets_concept' && from.kind === 'question' && from.blockId === undefined && wholeConcept(to) &&
        knowledgeUseKey(from.sourceUse) === knowledgeUseKey(root.source)));
      const concept = opened?.projected.to.sourceUse.id;
      if (concept && !links.has(concept)) links.set(concept, [...branch.values()]);
    }
    return links;
  }

  async function summaryFor(concept: KnowledgeSourceUse): Promise<Summary | undefined> {
    const isBlock = (endpoint: KnowledgeEndpoint) => endpoint.blockId !== undefined &&
      (endpoint.kind === 'chapter' || endpoint.kind === 'note');
    for (const id of sortedIds(summaryEdges.edgeIds)) {
      const proof: Proof = new Map();
      const scope = scoped(proof);
      const summary = await available(async () => {
        const opened = await openEdge(scope, id, ({ kind, from, to }) =>
          (kind === 'explains' && ((isBlock(from) && wholeConcept(to)) || (wholeConcept(from) && to.kind === 'chapter' && isBlock(to)))) ||
          (kind === 'maps_to_chapter' && wholeConcept(from) && to.kind === 'chapter' && isBlock(to)));
        if (!opened) return;
        const { from, to } = opened.projected;
        const [linked, endpoint] = wholeConcept(from) ? [from, to] : [to, from];
        if (knowledgeUseKey(linked.sourceUse) !== knowledgeUseKey(concept)) return;
        if (!endpoint.blockId) return;
        const pin = { ...endpoint.sourceUse, blockId: endpoint.blockId };
        if (endpoint.kind === 'chapter') {
          const block = await openCurrentTextbookBlock(scope, pin);
          if (block?.body.kind !== 'text') return;
          return { kind: 'textbook-block' as const, block: { ...witness(block.current), blockId: pin.blockId },
            text: excerpt(block.body.text), edge: witness(opened.fact), basis: [...proof.values()] };
        }
        const current = await scope.read.fact(pin.id, { mode: 'following' });
        if (current.type !== 'capture.source' || current.ref.learner !== access.learner || current.ref.id !== pin.id ||
            current.accessEpoch !== pin.accessEpoch || current.ref.rev < pin.rev) return;
        const block = await scope.openNotionBlock?.(pin);
        if (!block?.basis.length || block.basis.some(ref => ref.learner !== access.learner)) return;
        addProof(proof, block.basis);
        return { kind: 'notion-block' as const, block: { ...witness(current), blockId: pin.blockId },
          text: excerpt(block.text), edge: witness(opened.fact), basis: [...proof.values()] };
      });
      if (summary?.text) return summary;
    }
    return undefined;
  }

  async function quickCheckFor(conceptId: FactId): Promise<PrerequisiteRadarRow['quickCheck']> {
    if (!pool) return;
    const proof: Proof = new Map();
    const question = await readTextbookPulseQuestion(scoped(proof), { ...pool, conceptId,
      ...(root.kind === 'question' ? { excludeQuestionId: root.source.id } : {}) }, basis => addProof(proof, basis));
    if (!question) return;
    const opened = [...proof.values()].find(ref => ref.id === question.id && ref.rev === question.rev && ref.mode === 'following');
    if (opened) return { question: opened, basis: [...proof.values()] };
    return undefined;
  }

  return available(async () => {
    if (candidates.length) await access.preloadFollowingEdges(candidates);
    const roots = await rootProofs();
    const requested = sortedIds(root.conceptIds);
    if (!roots || roots.size !== requested.length || requested.some(id => !roots.has(id))) return;
    const rows: PrerequisiteRadarRow[] = [];
    const remediation = new Map<FactId, Pick<PrerequisiteRadarRow, 'summary' | 'quickCheck'>>();
    for (const id of sortedIds(prerequisiteEdges.edgeIds)) {
      const row = await available(async () => {
        const proof: Proof = new Map();
        const scope = scoped(proof);
        const opened = await openEdge(scope, id, ({ kind, from, to }) =>
          kind === 'prereq_of' && wholeConcept(from) && wholeConcept(to));
        if (!opened) return;
        const { from, to } = opened.projected;
        const rootBasis = roots.get(to.sourceUse.id);
        if (!rootBasis || from.sourceUse.id === to.sourceUse.id) return;
        addProof(proof, rootBasis);
        const rootFact = await currentConcept(scope, to.sourceUse.id, to.sourceUse);
        const prerequisite = await currentConcept(scope, from.sourceUse.id, from.sourceUse);
        if (!rootFact || !prerequisite) return;
        const title = record(prerequisite.value).title;
        if (typeof title !== 'string' || !title.trim()) return;
        return { root: witness(rootFact), prerequisite: witness(prerequisite), edge: witness(opened.fact),
          title: title.trim(), basis: [...proof.values()] };
      });
      if (!row) continue;
      let material = remediation.get(row.prerequisite.id);
      if (!material) {
        const summary = await summaryFor(row.prerequisite);
        const quickCheck = summary && await available(() => quickCheckFor(row.prerequisite.id));
        material = { ...(summary ? { summary } : {}), ...(quickCheck ? { quickCheck } : {}) };
        remediation.set(row.prerequisite.id, material);
      }
      rows.push({ ...row, ...material });
    }
    return rows;
  });
}
