import { fileURLToPath } from 'node:url';
import { commandId, derivationId, factId, learnerId, type CommandContext, type Json, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { evolveGraphCommand, splitConceptHierarchyEdgeId } from '@mangekyo/module-content/graph-evolution';
import { createKnowledgeEdgeCommand, openKnowledgeEdgeRevision, walkKnowledgeEdges } from '@mangekyo/module-content/knowledge-edge';
import { contentStableId, openKnowledgeEntity, openKnowledgeName } from '@mangekyo/module-content/knowledge-entity';
import { gather, openQuestionMetaDraft, questionMetaEffectResult, questionMetaType, settle } from '@mangekyo/module-content/question-meta';
import { proposeQuestionMetaCommand, saveQuestionCommand } from '../question-writes.ts';
import fixture from './graph-evolution.json' with { type: 'json' };

const learner = learnerId('01KFS4AAA00000000000000000');
const question = factId(fixture.question.id);
const parent = factId(fixture.split.id);
const child = factId(fixture.split.children[1]!.id);
const edgeId = factId(fixture.edge.id);
const rev1 = 1 as Revision;
const postgres = process.env.MANGEKYO_CONTENT_GRAPH_PG === '1';

it('confirms graph evolution atomically and reopens current and historical relationships', () =>
  withLearnerDatabase(learner, async db => {
    const content = await loadModuleDirectory(fileURLToPath(new URL('..', import.meta.url)));
    const handler = createCommandHandler(db, { modules: [content], hooks: { async onFactsChanged() {} } });
    const scope = { learner, purpose: 'storage' };
    const request = async (type: string, id: string, input: Json, actor: 'learner' | 'companion' = 'learner') =>
      handler({ ...scope, type, id: commandId(await contentStableId('test-command', id)), input, actor });
    const decide = async (type: string, id: string, proposalId: ReturnType<typeof commandId>, accept = true) =>
      handler.decideProposal({ ...scope, type, id: commandId(await contentStableId('test-decision', id)), proposalId,
        selection: accept ? 'accept' : 'reject' }, async (_, input) => accept ? input : null);
    const snapshot = <T>(run: (ctx: CommandContext) => Promise<T>, purpose = 'storage') =>
      db.snapshot({ learner }, tx => run({ learner, read: createCommandReadContext(tx, purpose) }));
    const name = (term: string) => snapshot(({ read }) => openKnowledgeName(read, 'concept', term));
    const openEdge = (mode: 'pinned' | 'following') => snapshot(ctx =>
      openKnowledgeEdgeRevision(ctx, edgeId, mode === 'pinned' ? { mode, rev: rev1 } : { mode }));
    await request(saveQuestionCommand, 'question', fixture.question);
    for (const concept of fixture.concepts) await request('content.createKnowledgeEntity', concept.id, concept);
    await request(createKnowledgeEdgeCommand, 'edge', fixture.edge);

    const rejected = await request(evolveGraphCommand, 'reject', fixture.split, 'companion');
    expect(rejected).toMatchObject({ state: 'proposed', wrote: [] });
    expect(await decide(evolveGraphCommand, 'reject', rejected.commandId, false)).toMatchObject({ state: 'rejected' });
    expect(await name('时间加权均速')).toBeUndefined();

    const wrongPurpose = await request(evolveGraphCommand, 'wrong-purpose', { ...fixture.split, purpose: 'storage' }, 'companion');
    await expect(decide(evolveGraphCommand, 'wrong-purpose', wrongPurpose.commandId)).rejects.toThrow('用途');
    expect(await name('等时均速')).toBeUndefined();

    const accept = await request(evolveGraphCommand, 'split', fixture.split, 'companion');
    const competing = await request(evolveGraphCommand, 'competing', fixture.split, 'companion');
    expect((await openEdge('following')).edge.to.sourceUse.id).toBe(parent);
    const results = await Promise.allSettled([accept, competing].map(receipt =>
      decide(evolveGraphCommand, receipt.commandId, receipt.commandId)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await name('时间加权均速')).toMatchObject({ snapshot: { ref: { id: child, rev: 1 } } });
    expect(await name('均速')).toMatchObject({ snapshot: { ref: { id: parent, rev: 1 } } });
    expect((await openEdge('pinned')).edge.to.sourceUse.id).toBe(parent);
    expect((await openEdge('following')).edge.to.sourceUse.id).toBe(child);

    const conflictingChildren = fixture.split.children.map((entry, index) => ({
      ...entry, id: index === 0 ? '01KFS4AAA00000000000000007' : '01KFS4AAA00000000000000008',
      entity: { ...entry.entity, canonicalName: index === 0 ? '等时段概念' : '变时段概念',
        aliases: index === 0 ? ['等时段'] : ['时间加权均速'] },
    }));
    const collision = await request(evolveGraphCommand, 'alias-collision', {
      ...fixture.split, children: conflictingChildren, reattachments: [],
    }, 'companion');
    await expect(decide(evolveGraphCommand, 'alias-collision', collision.commandId)).rejects.toThrow('已有同名实体');
    expect(await name('等时段')).toBeUndefined();

    const hierarchy = await splitConceptHierarchyEdgeId(child, parent);
    const evolved = await snapshot(async ctx => walkKnowledgeEdges(ctx, {
      root: (await openKnowledgeEdgeRevision(ctx, edgeId, { mode: 'following' })).edge.from,
      edgeIds: [edgeId, hierarchy], mode: 'following', hops: 2, direction: 'outbound',
    }), 'teaching');
    expect(evolved.paths.map(step => step.endpoint.sourceUse.id)).toEqual([child, parent]);

    const merge = await request(evolveGraphCommand, 'merge', fixture.merge, 'companion');
    expect((await name('均速'))?.snapshot.ref.id).toBe(parent);
    await decide(evolveGraphCommand, 'merge', merge.commandId);
    expect(await name('均速')).toMatchObject({ snapshot: { ref: { id: fixture.merge.into } } });
    expect(await snapshot(({ read }) => openKnowledgeEntity(read, parent, rev1))).toMatchObject({
      snapshot: { ref: { id: parent, rev: 1 } }, entity: { merged_into: null },
    });
    expect((await openEdge('pinned')).edge.to.sourceUse.id).toBe(parent);

    expect(content.slots.get(questionMetaType)).toMatchObject({ policy: 'lazy' });
    const proposed = await request(proposeQuestionMetaCommand, 'meta', fixture.questionMeta, 'companion');
    const otherMetadata = { ...fixture.questionMeta, append_metadata: {
      solutions: [{ ...fixture.questionMeta.append_metadata.solutions[0]!, explanation: '改成另一种说法。' }],
    } };
    const stale = await request(proposeQuestionMetaCommand, 'meta-stale', otherMetadata, 'companion');
    expect(proposed.wrote).toEqual([]);
    await decide(proposeQuestionMetaCommand, 'meta', proposed.commandId);
    await expect(decide(proposeQuestionMetaCommand, 'meta-stale', stale.commandId)).rejects.toThrow('Fact revision conflict');
    const { expectedMetaRev: _, ...legacy } = otherMetadata;
    await expect(request(proposeQuestionMetaCommand, 'legacy-conflict', legacy)).rejects.toThrow('Fact revision conflict');
    expect(await snapshot(({ read }) => openQuestionMetaDraft(read, { learner, id: question, rev: rev1 }))).toMatchObject({
      snapshot: { ref: { rev: 2 } }, draft: { sticky: true },
    });
    const plan = await snapshot(ctx => gather({ ...ctx, snapshotTick: '0' as Tick }, { id: question, rev: rev1 }), 'teaching');
    const gardening = plan.data.gardening!;
    const sealed = { id: derivationId('01KFS4AAA00000000000000010'), plan };
    const outcome = settle(sealed, [{
      ownerId: sealed.id, request: plan.effects[0]!, state: 'done',
      result: questionMetaEffectResult('01KFS4AAA00000000000000011', {
        solutions: [{ ...otherMetadata.append_metadata.solutions[0]!, source_ref: gardening.sources[0]!.ref }],
      }),
    }]);
    expect(outcome.value).toMatchObject({
      sticky: true,
      solutions: [{ explanation: '用总路程除以总用时。', verification: 'learner-reviewed' }],
      proposals: { solutions: [{ explanation: '改成另一种说法。', verification: 'unverified' }] },
    });
    expect(await snapshot(({ read }) => read.fact(question, { mode: 'pinned', rev: rev1 }))).toMatchObject({
      ref: { rev: 1 }, value: fixture.question.asset,
    });
    await request('content.setQuestionTeaching', 'revoke', { id: question, expectedRev: 1, allowed: false });
    await expect(openEdge('pinned')).rejects.toThrow('访问代次');
    await expect(openEdge('following')).rejects.toThrow('访问代次');
  }, { postgres }), 45_000);
