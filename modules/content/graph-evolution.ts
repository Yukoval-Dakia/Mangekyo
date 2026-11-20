import type { CommandContext, FactSnapshot, FactWrite, ReadContext } from '@mangekyo/kernel';
import {
  createKnowledgeEntity, mergeKnowledgeEntity, parseCreateKnowledgeEntity, parseMergeKnowledgeEntity,
} from './knowledge-entity-writes.ts';
import { contentStableId, normalizeKnowledgeName, openKnowledgeEntity } from './knowledge-entity.ts';
import {
  KnowledgeEdgeBasisError, knowledgeEdgeType, knowledgeUseKey, openKnowledgeEdgeRevision,
  parseKnowledgeEdge, readKnowledgeUse, sourceUse, type KnowledgeSourceUse,
} from './knowledge-edge.ts';
import { fields, list, pageId, record, revision, text } from './parse.ts';

export const evolveGraphCommand = 'content.evolveGraph';
export const splitConceptHierarchyEdgeId = (child: string, parent: string) =>
  contentStableId(knowledgeEdgeType, 'part_of', child, parent);

function parseReattachment(input: unknown) {
  const value = record(input);
  fields(value, 'edge', 'childId', 'evidence');
  const evidence = list(value.evidence).map(sourceUse);
  if (!evidence.length || evidence.length > 16) throw new Error('每条重挂关系需要 1–16 项细分依据。');
  return { edge: sourceUse(value.edge), childId: pageId(value.childId), evidence };
}

export function parseGraphEvolution(input: unknown) {
  const value = record(input);
  const { action, ...change } = value;
  if (action === 'merge') return { action, ...parseMergeKnowledgeEntity(change) } as const;
  if (action !== 'split') throw new Error('请选择合并或拆分知识实体。');

  fields(change, 'id', 'expectedRev', 'purpose', 'children', 'reattachments', 'reason');
  const id = pageId(change.id);
  const purpose = change.purpose ?? 'storage';
  if (purpose !== 'storage' && purpose !== 'teaching') throw new Error('图谱演化用途无效。');
  const reason = text(change.reason, '拆分依据').trim();
  if (reason.length > 1000) throw new Error('拆分依据过长。');
  const children = list(change.children).map(input => {
    const child = record(input);
    fields(child, 'id', 'entity', 'resolution');
    return parseCreateKnowledgeEntity({ ...child, purpose });
  });
  const childIds = new Set(children.map(child => child.id));
  if (children.length < 2 || children.length > 16 || childIds.has(id) || childIds.size !== children.length ||
      children.some(child => child.entity.kind !== children[0]?.entity.kind)) {
    throw new Error('拆分需要 2–16 个同类的新实体身份。');
  }
  const names = children.flatMap(({ entity }) => [entity.canonicalName, ...entity.aliases].map(normalizeKnowledgeName));
  if (new Set(names).size !== names.length) throw new Error('子概念之间的规范名称和别名不能重复。');

  const reattachments = list(change.reattachments ?? []).map(parseReattachment);
  if (reattachments.length > 32 || new Set(reattachments.map(item => item.edge.id)).size !== reattachments.length ||
      reattachments.some(item => !childIds.has(item.childId))) {
    throw new Error('每条关系仅能重挂到一个本次拆出的子概念。');
  }
  return { action, id, expectedRev: revision(change.expectedRev), purpose, children, reattachments, reason } as const;
}

export type GraphEvolution = ReturnType<typeof parseGraphEvolution>;

const witness = (fact: FactSnapshot): KnowledgeSourceUse =>
  ({ id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch });

function uniqueUses(uses: readonly KnowledgeSourceUse[]) {
  return [...new Map(uses.map(use => [knowledgeUseKey(use), use])).values()];
}

function readForPurposes(read: ReadContext, purposes: readonly string[]): ReadContext {
  function verify(fact: FactSnapshot<unknown>) {
    if (purposes.some(purpose => !fact.purpose.includes(purpose) && !fact.purpose.includes('all'))) {
      throw new KnowledgeEdgeBasisError('图谱演化依据没有覆盖关系的用途。');
    }
  }
  return {
    ...read,
    async fact<Value>(id: Parameters<ReadContext['fact']>[0], options: Parameters<ReadContext['fact']>[1]) {
      const fact = await read.fact<Value>(id, options);
      verify(fact);
      if (options.mode === 'pinned') verify(await read.fact(id, { mode: 'following' }));
      return fact;
    },
  };
}

async function splitKnowledgeEntity(ctx: CommandContext, input: Extract<GraphEvolution, { action: 'split' }>) {
  const { id, expectedRev, purpose, children, reattachments, reason } = input;
  const purposes = purpose === 'teaching' ? ['storage', 'teaching'] : ['storage'];
  const access = { ...ctx, read: readForPurposes(ctx.read, purposes) };
  const { snapshot, entity, redirects } = await openKnowledgeEntity(access.read, id);
  if (redirects.length || snapshot.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
  if (children.some(child => child.entity.kind !== entity.kind)) throw new Error('子实体须与原实体同类。');

  const parent = witness(snapshot);
  const writes: FactWrite[] = [];
  for (const child of children) {
    const sources = uniqueUses([parent, ...child.sources]);
    writes.push(...await createKnowledgeEntity(access, { ...child, sources }));
    // New facts in this atomic command start at revision 1 and access epoch 0.
    const childUse = sourceUse({ id: child.id, rev: 1, accessEpoch: '0' });
    writes.push({
      kind: 'create', id: await splitConceptHierarchyEdgeId(child.id, id),
      factType: knowledgeEdgeType, purpose: purposes,
      data: parseKnowledgeEdge({
        kind: 'part_of', from: { kind: entity.kind, sourceUse: childUse }, to: { kind: entity.kind, sourceUse: parent },
        sourceUses: [...sources, childUse], scope: reason,
      }),
    });
  }

  for (const item of reattachments) {
    const current = await ctx.read.fact(item.edge.id, { mode: 'following' });
    if (knowledgeUseKey(witness(current)) !== knowledgeUseKey(item.edge)) {
      throw new Error(`Fact revision conflict: ${item.edge.id}`);
    }
    // The command read exposes rev, but no sticky flag. A birth revision is always non-sticky.
    if (current.ref.rev !== 1) throw new Error('关系已有修订，请保留其标注并单独审查。');
    if (current.purpose.some(purpose => !purposes.includes(purpose))) {
      throw new KnowledgeEdgeBasisError('子概念没有覆盖原关系的用途。');
    }
    const edgeAccess = { ...ctx, read: readForPurposes(ctx.read, current.purpose) };
    const { edge: previous } = await openKnowledgeEdgeRevision(edgeAccess, item.edge.id, { mode: 'following' });
    const assignment = previous.kind === 'targets_concept' || previous.kind === 'instance_of' ||
      (previous.kind === 'related_to' && (previous.from.kind === 'work' || previous.from.kind === 'question'));
    if (!assignment || previous.to.kind !== entity.kind || previous.to.sourceUse.id !== id || previous.to.blockId !== undefined) {
      throw new Error('只可重挂指向原实体的整项题目或作答归属。');
    }
    if (item.evidence.some(use => use.id === id || use.id === item.edge.id)) {
      throw new Error('细分依据需要具体来源。');
    }
    for (const use of item.evidence) await readKnowledgeUse(edgeAccess, use);
    const childUse = sourceUse({ id: item.childId, rev: 1, accessEpoch: '0' });
    const { verification, ...claim } = previous;
    writes.push({
      kind: 'correct', id: current.ref.id, expectedRev: current.ref.rev,
      data: parseKnowledgeEdge({
        ...claim, to: { kind: entity.kind, sourceUse: childUse },
        sourceUses: uniqueUses([...previous.sourceUses, ...(verification ? [verification] : []), ...item.evidence, childUse]),
      }),
    });
  }
  return writes;
}

export async function evolveGraph(ctx: CommandContext, input: GraphEvolution): Promise<readonly FactWrite[]> {
  if (input.action === 'merge') return mergeKnowledgeEntity(ctx, input);
  return splitKnowledgeEntity(ctx, input);
}
