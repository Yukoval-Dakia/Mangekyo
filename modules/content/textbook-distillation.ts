import {
  commandId, FactNotFoundError,
  type BusWitness, type FactId, type FactSnapshot,
} from '@mangekyo/kernel';
import { AssetBasisError, assetType, parseAsset, type AssetReadContext } from './asset.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEndpointKind, openKnowledgeEdgeRevision, readKnowledgeUse,
  type KnowledgeEdge, type KnowledgeEndpoint,
} from './knowledge-edge.ts';
import { contentStableId } from './knowledge-entity.ts';
import { applyTextbookRevision, parseSavePage, type TextbookRevision } from './textbook-edits.ts';
import {
  checkTextbookBasis, openTextbookReference, parseTextbookReference, textbookPageFrom, textbookPageType,
  verifyTextbookBodyReference, type TextbookBlockBody, type TextbookReference,
} from './textbook-page.ts';

export type TextbookDistillationReference = {
  readonly ref: TextbookReference;
  readonly witness: BusWitness;
};

export type TextbookDistillationAccess = AssetReadContext & {
  /**
   * The host binds a storage reader to the learner, actual recipient, and one authorized snapshot.
   * Reads must authorize transitive provenance and source selection, also for graph endpoints.
   * Reopen the exact discussion block and its verified reference manifest from persisted evidence.
   * Never construct the discussion from client-supplied text or a model's list of claimed references.
   */
  readonly openDiscussion: (turn: TextbookDistillationReference) => Promise<{
    readonly text: string;
    readonly refs: readonly TextbookReference[];
    readonly witnesses: readonly BusWitness[];
    readonly complete: boolean;
  } | undefined>;
  /** Recognize host authorization denials while allowing operational failures to propagate. */
  readonly isUnavailable: (error: unknown) => boolean;
};

export type TextbookDistillationChoice = {
  readonly page: BusWitness;
  readonly title: string;
};

export type TextbookDistillationInput = {
  readonly speaker: 'learner' | 'companion';
  readonly turn: TextbookDistillationReference;
  /** Enumerate current candidates for this storage scope in the same snapshot as the reads. */
  readonly candidates: { readonly edgeIds: readonly FactId[]; readonly complete: boolean };
  readonly selection?: Pick<BusWitness, 'id' | 'rev' | 'accessEpoch'>;
};

type Body = TextbookBlockBody;
type Patch = { readonly op: 'insert_after'; readonly target: string; readonly block_id: string; readonly content: Body }
  | { readonly op: 'insert_block'; readonly target: string; readonly parent_id: null; readonly before_id: null; readonly content: Body };

export type TextbookDistillationPreview =
  | { readonly status: 'missing_witness' | 'source_unavailable' | 'incomplete_candidates' | 'no_match' |
      'selection_stale' | 'block_conflict' | 'basis_limit' }
  | { readonly status: 'choice_required'; readonly choices: readonly TextbookDistillationChoice[] }
  | { readonly status: 'already_distilled'; readonly target: TextbookDistillationChoice; readonly blockIds: readonly string[] }
  | {
      readonly status: 'ready';
      readonly target: TextbookDistillationChoice;
      readonly backlinks: readonly TextbookDistillationReference[];
      readonly blockIds: readonly string[];
      readonly savePage: { readonly ref: FactId; readonly expected_rev: BusWitness['rev']; readonly patch: readonly Patch[] };
      readonly revision: TextbookRevision;
      readonly confirmationId: ReturnType<typeof commandId>;
    };

const edgeLimit = 128;
const refLimit = 8;
const basisLimit = 128;
const chapterRelations = new Set(['maps_to_chapter', 'explains', 'addresses_pitfall', 'references']);
const bridgeRelations = new Set(['targets_concept', 'instance_of', 'explains', 'addresses_pitfall', 'references']);
const bridges = new Set(['concept', 'method', 'archetype']);

const versionKey = ({ id, rev }: Pick<BusWitness, 'id' | 'rev'>) => JSON.stringify([id, rev]);
const refKey = ({ fact, anchor }: TextbookReference) => JSON.stringify([fact.id, fact.rev,
  anchor.kind, anchor.kind === 'block' ? anchor.blockId : anchor.kind === 'path' ? anchor.path : null]);
const endpointKey = ({ sourceUse, blockId }: KnowledgeEndpoint) =>
  JSON.stringify([versionKey(sourceUse), blockId ?? null]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function authorizedStorage(access: TextbookDistillationAccess): AssetReadContext {
  const reads = new Map<string, Promise<FactSnapshot>>();
  return {
    learner: access.learner,
    read: {
      fact(id, options) {
        const key = JSON.stringify([id, options.mode, options.mode === 'pinned' ? options.rev : null]);
        let read = reads.get(key);
        if (!read) {
          read = access.read.fact(id, options.mode === 'pinned' ? { ...options, requirePurpose: 'storage' } : options)
            .then(snapshot => {
              if (snapshot.ref.learner !== access.learner ||
                  !snapshot.purpose.some(purpose => purpose === 'storage' || purpose === 'all')) {
                throw new AssetBasisError('来源未授权持久存储。');
              }
              return snapshot;
            });
          reads.set(key, read);
        }
        return read;
      },
    },
  };
}

function unavailable(access: TextbookDistillationAccess, error: unknown) {
  return error instanceof FactNotFoundError || error instanceof KnowledgeEdgeBasisError ||
    error instanceof AssetBasisError || access.isUnavailable(error);
}

function matches(ref: TextbookReference, witness: BusWitness) {
  return ref.fact.learner === witness.learner && ref.fact.id === witness.id &&
    ref.fact.rev === witness.rev && ref.type === witness.type;
}

async function reopen(ctx: AssetReadContext, { ref, witness }: TextbookDistillationReference) {
  if (ref.fact.learner !== ctx.learner || !matches(ref, witness)) throw new AssetBasisError('讨论引用没有匹配的见证。');
  const fact = await readKnowledgeUse(ctx, witness);
  if (fact.type !== ref.type) throw new AssetBasisError('讨论引用类型已经变化。');
  await openTextbookReference(ctx.read, ref);
  if (fact.type === assetType) await checkTextbookBasis(ctx.read, parseAsset(fact.value).basis ?? []);
  if (fact.type === textbookPageType) await checkTextbookBasis(ctx.read, textbookPageFrom(fact).basis ?? []);
  return fact;
}

function pinned(snapshot: FactSnapshot): BusWitness {
  return { ...snapshot.ref, type: snapshot.type, accessEpoch: snapshot.accessEpoch, mode: 'pinned' };
}

async function readGraph(access: TextbookDistillationAccess, ctx: AssetReadContext, ids: readonly FactId[]) {
  const current = [];
  for (const id of [...new Set(ids)].sort(compare)) {
    try {
      current.push(await openKnowledgeEdgeRevision(ctx, id, { mode: 'following' }));
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }
  return current;
}

type Graph = Awaited<ReturnType<typeof readGraph>>;
type Support = {
  readonly root: string;
  readonly page: FactId;
  readonly blockId?: string;
  readonly distance: 0 | 1 | 2;
  readonly edges: readonly BusWitness[];
};

function chapterSupports(graph: Graph, roots: readonly { ref: TextbookReference; fact: FactSnapshot }[]): Support[] {
  const adjacency = new Map<string, { end: KnowledgeEndpoint; kind: KnowledgeEdge['kind']; edge: BusWitness }[]>();
  for (const { snapshot, edge } of graph) {
    for (const [start, end] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      const key = endpointKey(start);
      const neighbors = adjacency.get(key) ?? [];
      neighbors.push({ end, kind: edge.kind, edge: pinned(snapshot) });
      adjacency.set(key, neighbors);
    }
  }
  const supports: Support[] = [];
  for (const { ref, fact } of roots) {
    const blockId = ref.anchor.kind === 'block' ? ref.anchor.blockId : undefined;
    const root = refKey(ref);
    if (fact.type === textbookPageType) {
      supports.push({ root, page: fact.ref.id, ...(blockId ? { blockId } : {}), distance: 0, edges: [] });
      continue;
    }
    const whole = adjacency.get(JSON.stringify([versionKey(fact.ref), null])) ?? [];
    const exact = blockId ? adjacency.get(JSON.stringify([versionKey(fact.ref), blockId])) ?? [] : [];
    for (const first of [...exact, ...whole]) {
      const add = (end: KnowledgeEndpoint, distance: 1 | 2, edges: readonly BusWitness[]) =>
        supports.push({ root, page: end.sourceUse.id, ...(end.blockId ? { blockId: end.blockId } : {}), distance, edges });
      if (first.end.kind === 'chapter' && chapterRelations.has(first.kind)) {
        add(first.end, 1, [first.edge]);
      } else if (bridges.has(first.end.kind) && bridgeRelations.has(first.kind)) {
        for (const second of adjacency.get(endpointKey(first.end)) ?? []) {
          if (second.end.kind === 'chapter' && chapterRelations.has(second.kind)) {
            add(second.end, 2, [first.edge, second.edge]);
          }
        }
      }
    }
  }
  return supports;
}

function rank(supports: readonly Support[]) {
  const nearest = new Map<string, Support['distance']>();
  for (const { root, distance } of supports) {
    const prior = nearest.get(root);
    if (prior === undefined || distance < prior) nearest.set(root, distance);
  }
  const score: [number, number, number] = [0, 0, 0];
  for (const distance of nearest.values()) score[distance]++;
  return score;
}

function compareScore(left: ReturnType<typeof rank>, right: ReturnType<typeof rank>) {
  return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
}

async function pageChoices(access: TextbookDistillationAccess, ctx: AssetReadContext, supports: readonly Support[]) {
  const grouped = new Map<FactId, Support[]>();
  for (const support of supports) {
    const group = grouped.get(support.page) ?? [];
    group.push(support);
    grouped.set(support.page, group);
  }
  const pages = [];
  for (const [id, support] of grouped) {
    try {
      const snapshot = await ctx.read.fact(id, { mode: 'following' });
      if (snapshot.type !== textbookPageType) continue;
      const page = textbookPageFrom(snapshot);
      if (page.archived) continue;
      await checkTextbookBasis(ctx.read, page.basis ?? []);
      const current = support.filter(item => item.blockId === undefined || page.blocks.some(block => block.id === item.blockId));
      if (!current.length) continue;
      const choice = { page: pinned(snapshot), title: page.title };
      pages.push({ choice, page, support: current, score: rank(current) });
    } catch (error) {
      if (!unavailable(access, error)) throw error;
    }
  }
  return pages.sort((a, b) => compareScore(a.score, b.score) || compare(a.choice.page.id, b.choice.page.id));
}

function insertionAnchor(page: ReturnType<typeof textbookPageFrom>, support: readonly Support[]) {
  const blocks = page.blocks.flatMap(block => {
    const hits = support.filter(item => item.blockId === block.id);
    return hits.length ? [{ block, score: rank(hits) }] : [];
  });
  blocks.sort((a, b) => compareScore(a.score, b.score));
  return blocks[0]?.block ?? page.blocks.findLast(block => block.parentId === null);
}

/**
 * A preview performs no writes. Confirm under the learner lock by replaying an existing
 * confirmation ID or rebuilding this preview and matching the ID before applying the
 * entire revision through the storage-scoped textbook diff decision. Pass ready's
 * confirmationId and revision to the repreview callback, and keep blockIds as one undo unit.
 */
export async function previewTextbookDistillation(
  access: TextbookDistillationAccess, input: TextbookDistillationInput,
): Promise<TextbookDistillationPreview> {
  // Teaching feedback lives in a separate derivation. The current Ref contract
  // pins the learner answer stored on the studyTurn fact.
  if (input.speaker !== 'learner') return { status: 'source_unavailable' };
  const { candidates, selection } = input;
  const turn = { ...input.turn, ref: parseTextbookReference(input.turn.ref) };
  const { anchor } = turn.ref;
  if (turn.ref.type !== 'activity.studyTurn' || anchor.kind !== 'path' ||
      anchor.path.length !== 1 || anchor.path[0] !== 'answer') return { status: 'source_unavailable' };
  if (!turn.witness || !matches(turn.ref, turn.witness)) return { status: 'missing_witness' };
  const ctx = authorizedStorage(access);
  let answer: string;
  const roots = [];
  const evidence = new Map<string, BusWitness>();
  try {
    const { value } = await reopen(ctx, turn);
    const original = value && typeof value === 'object' && 'answer' in value ? value.answer : null;
    if (typeof original !== 'string' || !original.trim() || !original.isWellFormed() || original.includes('\u0000')) {
      return { status: 'source_unavailable' };
    }
    answer = original;
    evidence.set(versionKey(turn.witness), turn.witness);
    const discussion = await access.openDiscussion(turn);
    if (!discussion?.complete || !discussion.refs.length || discussion.refs.length > refLimit) {
      return { status: 'missing_witness' };
    }
    if (discussion.text !== answer) return { status: 'source_unavailable' };
    if (discussion.witnesses.length + 1 > basisLimit) return { status: 'basis_limit' };
    for (const witness of discussion.witnesses) {
      if (witness.learner !== ctx.learner) return { status: 'missing_witness' };
      const fact = await readKnowledgeUse(ctx, witness);
      if (fact.type !== witness.type) return { status: 'source_unavailable' };
      evidence.set(versionKey(witness), witness);
    }
    const refs = discussion.refs.map(parseTextbookReference);
    for (const ref of [...new Map(refs.map(ref => [refKey(ref), ref])).values()]
      .sort((a, b) => compare(refKey(a), refKey(b)))) {
      const witness = evidence.get(versionKey(ref.fact));
      if (!witness || !matches(ref, witness)) return { status: 'missing_witness' };
      const fact = await reopen(ctx, { ref, witness });
      roots.push({ ref, witness: pinned(fact), fact });
    }
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return { status: 'source_unavailable' };
  }

  if (!candidates.complete || candidates.edgeIds.length > edgeLimit) return { status: 'incomplete_candidates' };
  const graph = await readGraph(access, ctx, candidates.edgeIds);
  const pages = await pageChoices(access, ctx, chapterSupports(graph, roots));
  const best = pages[0];
  if (!best) return { status: selection ? 'selection_stale' : 'no_match' };
  const top = pages.filter(page => !compareScore(page.score, best.score));
  const selected = selection ? top.find(({ choice: { page } }) =>
    page.id === selection.id && page.rev === selection.rev && page.accessEpoch === selection.accessEpoch) : best;
  if (!selected) return { status: 'selection_stale' };
  if (!selection && top.length > 1) return { status: 'choice_required', choices: top.map(item => item.choice) };

  const { choice: target, page, support } = selected;
  const backlinks = [{ ref: turn.ref, witness: { ...turn.witness, mode: 'pinned' as const } },
    ...roots.filter(({ fact }) => knowledgeEndpointKind(fact) === 'question')
    .map(({ ref, witness }) => ({ ref, witness }))];
  const blockId = await contentStableId('textbook-distillation', ctx.learner, refKey(turn.ref));
  const bodies: readonly Body[] = [
    { kind: 'text', text: answer },
    ...backlinks.map(({ ref }, index) => ({
      kind: 'reference' as const, role: index ? 'question' as const : 'citation' as const, target: ref,
    })),
  ];
  const blockIds = [blockId, ...await Promise.all(backlinks.map(({ ref }) =>
    contentStableId('textbook-distillation-backlink', blockId, refKey(ref))))];
  const occupied = blockIds.map(id => page.blocks.find(block => block.id === id));
  if (occupied.some(Boolean) || blockIds.some(id => page.retiredBlockIds?.includes(id) ||
      page.movedBlocks?.some(move => move.blockId === id))) {
    return occupied.every((block, index) => block && JSON.stringify(block.body) === JSON.stringify(bodies[index]))
      ? { status: 'already_distilled', target, blockIds } : { status: 'block_conflict' };
  }
  const anchor = insertionAnchor(page, support);
  const patch: Patch[] = bodies.map((content, index) => anchor
    ? { op: 'insert_after', target: anchor.id, block_id: blockIds[index]!, content }
    : { op: 'insert_block', target: blockIds[index]!, parent_id: null, before_id: null, content });
  // Repeated insert_after at the same existing anchor applies in reverse display order.
  if (anchor) patch.reverse();
  const savePage = { ref: target.page.id, expected_rev: target.page.rev, patch };
  const parsed = parseSavePage(savePage);
  if (parsed.kind !== 'patch') throw new Error('教材沉淀必须产生局部修订。');
  const basis = [...evidence.values()].sort((a, b) => compare(versionKey(a), versionKey(b)))
    .map(({ id, rev, accessEpoch, type }) => ({ id, rev, epoch: accessEpoch, type }));
  if (new Set([...(page.basis ?? []), ...basis].map(versionKey)).size > basisLimit) return { status: 'basis_limit' };
  const revision: TextbookRevision = {
    id: target.page.id, expectedRev: target.page.rev, clientEditSeq: 0, edits: parsed.edits, basis,
  };
  try {
    if (anchor) await verifyTextbookBodyReference(ctx, anchor.body);
    // Validate the atomic bundle using the same edit and provenance rules as a textbook write.
    await applyTextbookRevision(ctx, page, revision, true);
  } catch (error) {
    if (!unavailable(access, error)) throw error;
    return { status: 'source_unavailable' };
  }
  const edgeProof = [...new Map(support.flatMap(item => item.edges).map(edge => [versionKey(edge), edge])).values()]
    .sort((a, b) => compare(versionKey(a), versionKey(b)));
  const confirmationId = commandId(await contentStableId('textbook-distillation-confirm', ctx.learner,
    target.page.accessEpoch, JSON.stringify(revision), JSON.stringify(edgeProof)));
  return { status: 'ready', target, backlinks, blockIds, savePage, revision, confirmationId };
}
