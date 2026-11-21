import { FactNotFoundError, type BusWitness, type FactId, type FactRef, type FactSnapshot, type Json,
  type ReadContext, type Tick } from '@mangekyo/kernel';
import {
  AssetBasisError, assetType, checkTextbookBasis, frozenBankQuestionBasis, locateTextbookBlock, parseAsset, textbookPageFrom,
  textbookPageType, verifyAssetBlockReference,
} from './asset.ts';
import { readUnexposedArchetypeVariant, type CorrectionMicroVariantAccess } from './correction-micro-variant.ts';
import {
  canUseDistinguishingVariant, KnowledgeEdgeBasisError, knowledgeEndpointKind, knowledgeUseKey,
  openKnowledgeWalkEdge, openKnowledgeWalkRoot, readKnowledgeUse, type KnowledgeEdge, type KnowledgeEndpoint,
  walkKnowledgeEdges, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import type { KnowledgeReadAccess } from './knowledge-reads.ts';
import { list, record } from './parse.ts';

export type TextbookPulseEdgeSet = { readonly complete: boolean; readonly edgeIds: readonly FactId[] };
export type TextbookPulseBlock = KnowledgeSourceUse & { readonly blockId: string };
type QuestionWitness = FactRef & Pick<FactSnapshot, 'accessEpoch'>;
type PulseProofAccess = {
  /** Retain recursive dependencies collected by the host's authorized reader for this exact read. */
  readonly dependenciesFor?: (witness: BusWitness) => readonly BusWitness[];
};
type BlockAccess = KnowledgeReadAccess & PulseProofAccess;
type TextbookBlockAccess = BlockAccess & {
  /** Warm the bound reader's cache in this transaction. Each fact read still authorizes
   * the individual candidate and reports its own denial, absence or operational error. */
  readonly preloadFollowingEdges?: (ids: readonly FactId[]) => Promise<void>;
};
export type TextbookPulseBlockProof = {
  readonly blockId: string;
  readonly page: BusWitness;
  readonly basis: readonly BusWitness[];
  readonly concepts: readonly { readonly conceptId: FactId; readonly edge: BusWitness; readonly basis: readonly BusWitness[] }[];
};

function proofReader(access: BlockAccess) {
  const cache = new Map<string, Promise<{ fact: FactSnapshot; proofs: readonly BusWitness[] }>>();
  return (witnesses: Map<string, BusWitness>) => ({
    async fact<Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot<Value>> {
      const key = JSON.stringify([id, options.mode, options.mode === 'pinned' ? [options.rev, options.requirePurpose] : null]);
      let pending = cache.get(key);
      if (!pending) {
        pending = access.read.fact(id, options).then(fact => {
          const witness = { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode: options.mode };
          return { fact, proofs: [witness, ...(access.dependenciesFor?.(witness) ?? [])] };
        });
        cache.set(key, pending);
      }
      const { fact, proofs } = await pending;
      for (const proof of proofs) {
        witnesses.set(`${knowledgeUseKey(proof)}:${proof.type}:${proof.mode}`, proof);
      }
      return fact as FactSnapshot<Value>;
    },
  });
}

function unavailable(access: KnowledgeReadAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof AssetBasisError ||
    error instanceof KnowledgeEdgeBasisError || access.isUnavailable(error);
}

function usable(access: KnowledgeReadAccess, edges: TextbookPulseEdgeSet) {
  return access.purpose.trim() && access.recipient.trim() && edges.complete && edges.edgeIds.length <= 128;
}

const useOf = ({ ref: { id, rev }, accessEpoch }: FactSnapshot): KnowledgeSourceUse => ({ id, rev, accessEpoch });

/** Pass current selection and transitive source authorization in `access.read`. Enumerate current
 * `explains` and `maps_to_chapter` edges touching this exact block witness in either direction.
 * Refresh the witness and edge set after a block edit, move or authorization change. */
export async function readTextbookBlockConcepts(access: TextbookBlockAccess, input: {
  readonly block: TextbookPulseBlock;
  readonly edges: TextbookPulseEdgeSet;
}, onProof?: (proof: TextbookPulseBlockProof) => void) {
  const { block, edges } = input;
  if (!usable(access, edges)) return;
  try {
    const scopedRead = proofReader(access);
    const blockProof = new Map<string, BusWitness>();
    const read = scopedRead(blockProof);
    const current = await read.fact(block.id, { mode: 'following' });
    if (current.ref.learner !== access.learner || knowledgeUseKey(useOf(current)) !== knowledgeUseKey(block)) return;
    const page = current.type === textbookPageType ? textbookPageFrom(current)
      : current.type === assetType ? parseAsset(current.value) : undefined;
    if (!page || knowledgeEndpointKind(current) !== 'chapter' || ('archived' in page && page.archived)) return;
    const location = locateTextbookBlock(page.blocks, block.blockId);
    if (!location) return;
    await checkTextbookBasis(read, page.basis ?? []);
    await verifyAssetBlockReference({ ...access, read }, location.block.body);
    const edgeIds = [...new Set(edges.edgeIds)].sort();
    if (edgeIds.length > 1) await access.preloadFollowingEdges?.(edgeIds);
    const root = { kind: 'chapter', sourceUse: block, blockId: block.blockId } as const;
    function touchesBlock(chapter: KnowledgeEndpoint, concept: KnowledgeEndpoint) {
      return chapter.kind === 'chapter' && chapter.blockId === block.blockId &&
        knowledgeUseKey(chapter.sourceUse) === knowledgeUseKey(block) &&
        concept.kind === 'concept' && concept.blockId === undefined;
    }
    const acceptEdge = ({ kind, from, to }: KnowledgeEdge) => (kind === 'explains' || kind === 'maps_to_chapter') &&
      (touchesBlock(from, to) || touchesBlock(to, from));
    const links: TextbookPulseBlockProof['concepts'][number][] = [];
    let rootProof: Map<string, BusWitness> | undefined;
    let incomplete = false;
    for (const id of edgeIds) {
      const proof = new Map<string, BusWitness>();
      const read = scopedRead(proof);
      try {
        await read.fact(id, { mode: 'following' });
      } catch (error) {
        if (!unavailable(access, error)) throw error;
        continue;
      }
      if (!rootProof) {
        rootProof = new Map();
        await openKnowledgeWalkRoot({ ...access, read: scopedRead(rootProof) }, root, 'following');
      }
      for (const [key, witness] of rootProof) proof.set(key, witness);
      try {
        const opened = await openKnowledgeWalkEdge({ ...access, read }, id,
          { mode: 'following', acceptEdge, classifyMalformed: true });
        if (!opened) continue;
        const { fact, projected: { from, to } } = opened;
        const concept = from.kind === 'concept' ? from : to;
        const edge = { ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode: 'following' as const };
        links.push({ conceptId: concept.sourceUse.id, edge, basis: [...proof.values()] });
      } catch (error) {
        if (!unavailable(access, error)) throw error;
        incomplete = true;
      }
    }
    if (incomplete && !links.length) return;
    const pageWitness = { ...current.ref, type: current.type, accessEpoch: current.accessEpoch, mode: 'following' as const };
    onProof?.({ blockId: block.blockId, page: pageWitness, basis: [...blockProof.values()], concepts: links });
    return { block: { ...useOf(current), blockId: block.blockId },
      conceptIds: [...new Set(links.map(({ conceptId }) => conceptId))].sort() };
  } catch (error) {
    if (!unavailable(access, error)) throw error;
  }
  return undefined;
}

type ConceptQuestions = { readonly conceptId: FactId; readonly targetEdges: TextbookPulseEdgeSet };

async function conceptQuestions(access: KnowledgeReadAccess, { conceptId, targetEdges }: ConceptQuestions) {
  if (!usable(access, targetEdges)) return;
  const concept = await access.read.fact(conceptId, { mode: 'following' });
  if (concept.ref.learner !== access.learner || concept.ref.id !== conceptId || knowledgeEndpointKind(concept) !== 'concept') return;
  const { paths, root } = await walkKnowledgeEdges(access, {
    root: { kind: 'concept', sourceUse: useOf(concept) }, edgeIds: targetEdges.edgeIds,
    mode: 'following', hops: 1, direction: 'inbound',
    acceptEdge: ({ kind, from, to }) => kind === 'targets_concept' && from.blockId === undefined && to.blockId === undefined,
  });
  if (root.sourceUse.id !== conceptId) return;
  return paths.map(({ endpoint }) => endpoint.sourceUse);
}

export type TextbookPulseObservation = {
  readonly conceptIds: readonly FactId[];
  /** Exact sourceQuestionRef and sourceAccessEpoch of the frozen, graded item. */
  readonly question: KnowledgeSourceUse;
  readonly itemId: string;
  readonly submissionAccessEpoch: Tick;
  readonly observation: {
    readonly submission: Pick<FactRef, 'id' | 'rev'>;
    readonly admittedAt: Tick;
    readonly submittedAt: string;
    readonly result: 'correct' | 'incorrect' | 'unknown';
    readonly exposure: { readonly kind: 'independent' | 'exposed' | 'unknown' };
  };
  readonly process: { readonly helpLevel: string };
  /** Reopened Activity backtrace of this exact question: two independent correct sittings,
   * including the prospective delayed follow-up. Use workbookBacktrace's complete basis. */
  readonly priorStable?: { readonly conceptIds: readonly FactId[]; readonly basis: readonly [BusWitness, ...BusWitness[]] };
};

type TrackPulseFacts = (facts: readonly BusWitness[]) => void;

function frozenItem(submission: FactSnapshot, itemId: string) {
  if (submission.type !== 'activity.workbookAttempt' && submission.type !== 'activity.retentionPosttestSubmission') return;
  const paper = record(record(submission.value).paper);
  return list(paper.questions).map(record).find(item => item.id === itemId);
}

async function reopenStability(access: BlockAccess, conceptId: FactId, question: KnowledgeSourceUse,
  submission: FactSnapshot, proof: TextbookPulseObservation['priorStable']) {
  if (!proof?.conceptIds.includes(conceptId) || !proof.basis.some(ref => ref.id === conceptId) ||
      !proof.basis.some(ref => knowledgeUseKey(ref) === knowledgeUseKey(question)) ||
      !proof.basis.some(ref => knowledgeUseKey(ref) === knowledgeUseKey(useOf(submission))) ||
      !proof.basis.some(ref => ref.type === 'activity.retentionPosttest')) return false;
  const sittings = new Set(proof.basis.filter(ref => ref.type === 'activity.workbookAttempt' ||
    ref.type === 'activity.retentionPosttestSubmission').map(ref => ref.id));
  if (sittings.size < 2) return false;
  for (const witness of proof.basis) {
    const fact = await access.read.fact(witness.id, witness.mode === 'pinned' ? { mode: 'pinned', rev: witness.rev } : { mode: 'following' });
    if (witness.learner !== access.learner || fact.ref.learner !== witness.learner || fact.type !== witness.type ||
        knowledgeUseKey(useOf(fact)) !== knowledgeUseKey(witness)) return false;
  }
  return true;
}

/** Feed authorized Activity observations and their exact frozen item witnesses. The caller
 * obtains complete concept-scoped evidence at `asOf` and supplies the recency policy cutoff.
 * Incomplete, revoked and unverified observations yield no historical reference. */
export async function readTextbookPulseHistory(access: BlockAccess, input: ConceptQuestions & {
  readonly asOf: string;
  readonly recentErrorSince: string;
  readonly activity: { readonly complete: boolean; readonly observations: readonly TextbookPulseObservation[] };
}, onProof?: TrackPulseFacts) {
  const asOf = Date.parse(input.asOf);
  const since = Date.parse(input.recentErrorSince);
  if (!input.activity.complete || input.activity.observations.length > 128 ||
      !Number.isFinite(asOf) || !Number.isFinite(since) || since > asOf) return;
  const proof = new Map<string, BusWitness>();
  const scoped = { ...access, read: proofReader(access)(proof) };
  try {
    const questions = await conceptQuestions(scoped, input);
    if (!questions?.length) return;
    const linked = new Set(questions.map(knowledgeUseKey));
    const evidence = input.activity.observations.flatMap(row => {
      const time = Date.parse(row.observation.submittedAt);
      if (!row.conceptIds.includes(input.conceptId) || !linked.has(knowledgeUseKey(row.question)) ||
          !Number.isFinite(time) || time > asOf) return [];
      return [{ row, time, tick: BigInt(row.observation.admittedAt) }];
    }).sort((a, b) => b.time - a.time || (a.tick < b.tick ? 1 : a.tick > b.tick ? -1 : 0));
    const latest = new Set<FactId>();
    let stable: KnowledgeSourceUse | undefined;
    for (const { row: { itemId, question, submissionAccessEpoch, observation, process, priorStable }, time } of evidence) {
      if (latest.has(question.id)) continue;
      const recentError = observation.result === 'incorrect' && time >= since;
      const independentCorrect = observation.result === 'correct' && observation.exposure.kind === 'independent' &&
        process.helpLevel === 'independent';
      const submission = await readKnowledgeUse(scoped, { ...observation.submission, accessEpoch: submissionAccessEpoch });
      const item = frozenItem(submission, itemId);
      if (!item?.sourceQuestionRef || record(submission.value).submittedAt !== observation.submittedAt) continue;
      const ref = record(item.sourceQuestionRef);
      if (ref.id !== question.id || ref.rev !== question.rev) continue;
      if (item.kind === 'bank') {
        if (item.sourceAccessEpoch !== question.accessEpoch) continue;
        await checkTextbookBasis(scoped.read, frozenBankQuestionBasis(item));
      }
      latest.add(question.id);
      if (!recentError && (!independentCorrect || stable)) continue;
      const fact = await readKnowledgeUse(scoped, question);
      if (knowledgeEndpointKind(fact) !== 'question') continue;
      if (fact.type === assetType) await checkTextbookBasis(scoped.read, parseAsset(fact.value).basis ?? []);
      else if (!await scoped.reopenLegacyQuestion?.(question)) continue;
      if (recentError) {
        // Legacy workbook items lack an epoch pin, so they cannot license an error link.
        if (item.kind !== 'bank') continue;
        onProof?.([...proof.values()]);
        return { kind: 'recent-error' as const, question: useOf(fact) };
      }
      if (await reopenStability(scoped, input.conceptId, question, submission, priorStable)) stable = useOf(fact);
    }
    if (stable) {
      onProof?.([...proof.values()]);
      return { kind: 'past-stable' as const, question: stable };
    }
  } catch (error) {
    if (!unavailable(access, error)) throw error;
  }
  return undefined;
}

export type TextbookPulseQuestionAccess = CorrectionMicroVariantAccess & PulseProofAccess & {
  /** Reopen the authoritative fixed question/item estimate under this same scope and snapshot.
   * Return undefined for absent, stale or unlicensed estimates; an assigned budget is not evidence. */
  readonly readDuration: (question: QuestionWitness) => Promise<{ readonly question: QuestionWitness; readonly upperMs: number } | undefined>;
};

/** Candidate enumeration must cover all relevant variant and archetype mappings of the
 * concept's source questions. The Activity exposure reader must cover the actual learner across
 * revisions and ways of seeing the question. Re-run this selection in the issuing snapshot.
 * `onProof` captures facts. Slot, duration and exposure readers also track their own evidence. */
export async function readTextbookPulseQuestion(access: TextbookPulseQuestionAccess, input: ConceptQuestions & {
  readonly source?: QuestionWitness;
  readonly complete: boolean;
  readonly variantEdgeIds: readonly FactId[];
  readonly archetypeEdgeIds: readonly FactId[];
}, onProof?: TrackPulseFacts) {
  if (!input.complete || input.variantEdgeIds.length > 128 || input.archetypeEdgeIds.length > 128 ||
      (input.source && input.source.learner !== access.learner)) return;
  const proof = new Map<string, BusWitness>();
  const read = { ...access.read, ...proofReader(access)(proof) };
  const scoped = { ...access, read, releaseUses: ['practice', ...access.releaseUses] };
  try {
    const linked = await conceptQuestions(scoped, input);
    const roots = linked?.filter(question => !input.source || knowledgeUseKey(question) === knowledgeUseKey(input.source));
    if (!roots || roots.length > 8) return;
    for (const question of roots.sort((a, b) => knowledgeUseKey(a).localeCompare(knowledgeUseKey(b)))) {
      const source = { learner: access.learner, ...question };
      const candidate = await readUnexposedArchetypeVariant(scoped,
        { ...input, source }, edge => {
          const relation = edge.variant?.relation;
          if (relation === 'numbers_only' || relation === 'single_condition') {
            return canUseDistinguishingVariant(edge, source.id, 'solution_seen', relation);
          }
          return (relation === 'same_source' || relation === 'translation' || relation === 'representation_transfer') &&
            edge.variant?.spoilsNext === 'none';
        }, async witness => {
          const duration = await access.readDuration(witness);
          return Boolean(duration && duration.question.learner === access.learner &&
            knowledgeUseKey(duration.question) === knowledgeUseKey(witness) && Number.isSafeInteger(duration.upperMs) &&
            duration.upperMs > 0 && duration.upperMs <= 120_000);
        });
      if (candidate) {
        onProof?.([...proof.values()]);
        return candidate;
      }
    }
  } catch (error) {
    if (!unavailable(access, error)) throw error;
  }
  return undefined;
}
