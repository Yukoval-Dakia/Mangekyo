import { evolveGraphCommand, splitConceptHierarchyEdgeId } from '@mangekyo/module-content/graph-evolution';
import { createKnowledgeEdgeCommand, openKnowledgeEdgeRevision, walkKnowledgeEdges } from '@mangekyo/module-content/knowledge-edge';
import { openKnowledgeEntity, openKnowledgeName } from '@mangekyo/module-content/knowledge-entity';
import { gather, openQuestionMetaDraft, questionKey, questionMetaDeriver, questionMetaEffectResult, questionMetaType,
  readQuestionHintLevel, settle } from '@mangekyo/module-content/question-meta';
import { proposeQuestionMetaCommand, saveQuestionCommand } from '../question-writes.ts';
import graph from './graph-evolution.json' with { type: 'json' };

export default async function exerciseContent(fixture, decideProposal) {
  const { db, learner, load, send, sendCompanion, stableId, assert, read, current, content, hooks } = fixture;
  const { openTextbookBlock } = await load('modules/content/textbook-page.ts');
  const { openTextbookConflict } = await load('modules/content/textbook-conflict.ts');
  const { previewTextbookRevision, selectTextbookEdits } = await load('modules/content/textbook-edits.ts');
  const idFor = name => stableId('textbook-acceptance', name);
  const [id, source, child] = ['page', 'fragment', 'child'].map(idFor);
  const body = text => ({ kind: 'text', text });
  const block = (id, text, parentId = null) => ({ id, parentId, body: body(text) });
  const rewrite = (blockId, text) => ({ kind: 'rewrite', blockId, body: body(text) });
  const create = (id, blocks) => send('content.createTextbookPage', {
    id, clientEditSeq: 0, purpose: ['storage', 'teaching'], page: { title: '教材', blocks },
  });

  const formula = { id: 'formula', parentId: null, body: { kind: 'formula', latex: 's/t' } };
  const note = block('note', '时间比时间；全程。');
  await create(id, [formula, note, block('intro', '目标块')]);
  const { wrote: [original] } = await create(source, [block('intro', '来源块'), block('proof', '子块', 'intro')]);
  await send('content.mergeTextbookPages', {
    target: { id, expectedRev: 1 }, sources: [{ id: source, expectedRev: 1 }],
  });
  const openBlock = (blockId, mode, purpose) => read(context => openTextbookBlock(context, original, blockId, mode), purpose);
  const moved = await openBlock('intro', 'following');
  assert.equal(moved.ref.id, id);
  assert.notEqual(moved.block.id, 'intro');
  assert.deepEqual(moved.block.body, body('来源块'));
  const split = { source: { id, expectedRev: 2 }, title: '子页', blockIds: [moved.block.id] };
  await assert.rejects(send('content.splitTextbookPage', { ...split, newId: source }), /Fact already exists/);
  await send('content.splitTextbookPage', { ...split, newId: child });
  const proof = await openBlock('proof', 'following');
  assert.equal(proof.ref.id, child);
  assert.deepEqual(proof.block, block('proof', '子块', moved.block.id));
  assert.deepEqual((await openBlock('intro')).block, block('intro', '来源块'));
  await send('content.archiveTextbookPage', { id: child, expectedRev: 1 });
  await assert.rejects(send('content.reviseTextbookPage', {
    id: child, expectedRev: 2, clientEditSeq: 1, edits: [rewrite('proof', '归档后编辑')],
  }), /教材已归档/);

  const devices = ['甲设备', '乙设备'].map(text => ({ text, draftId: idFor(text) }));
  const save = ({ text, draftId }, edit = {}, request = text, purpose = 'storage') => send('content.saveTextbookDraft', {
    id, draftId, base_rev: 3, clientEditSeq: 1, edits: [rewrite('intro', text)], ...edit,
  }, { commandId: idFor(request), purpose });
  await assert.rejects(save(devices[0], {}, 'teaching-first', 'teaching'), /requires purpose storage/);
  const saves = await Promise.all(devices.map(device => save(device)));
  const winner = saves.findIndex(receipt => receipt.wrote[0].id === id);
  assert.notEqual(winner, -1);
  const savedIntro = block('intro', devices[winner].text);
  const loser = devices[1 - winner];
  const { draftId, text } = loser;
  assert.equal(saves[1 - winner].wrote[0].id, draftId);

  const { openTextbook } = await load('runtime/studio/textbook.ts');
  const textbook = openTextbook(db, content, hooks);
  const rewritten = { ...formula, body: { kind: 'formula', latex: '\\Delta s/\\Delta t' } };
  const rewriteFormula = { kind: 'rewrite', blockId: formula.id, body: rewritten.body };
  const example = block('example', '新例子');
  const insert = { kind: 'insert_after', blockId: example.id, afterId: note.id, body: example.body };
  const revision = {
    id, expectedRev: 4, clientEditSeq: 2,
    edits: [
      rewrite('missing', '失效提议'),
      rewriteFormula,
      { kind: 'replace_anchor', blockId: note.id, anchor: '时间', replacement: '路程' },
      insert,
      { kind: 'delete_block', blockId: 'intro' },
    ],
  };
  const proposal = await sendCompanion('content.reviseTextbookPage', revision, 'teaching');
  assert.equal(proposal.state, 'proposed');
  assert.equal((await current(id)).ref.rev, 4);
  const preview = await read(context => previewTextbookRevision({ learner, read: context }, revision));
  assert.deepEqual(preview.items.map(item => item.state), ['invalid', 'ready', 'invalid', 'ready', 'ready']);
  const [, formulaDiff, anchorDiff, insertDiff, deleteDiff] = preview.items;
  assert.deepEqual(formulaDiff.before, { block: formula, siblingIndex: 0 });
  assert.equal(anchorDiff.reason, '教材文本锚点必须恰好匹配一处。');
  assert.equal(insertDiff.before, null);
  assert.deepEqual(insertDiff.after, { block: example, siblingIndex: 2 });
  assert.deepEqual(deleteDiff.before, { block: savedIntro, siblingIndex: 2 });
  assert.equal(deleteDiff.after, null);
  assert.deepEqual(selectTextbookEdits(preview, ['formula']), { ...revision, edits: [rewriteFormula] });
  assert.deepEqual(selectTextbookEdits(preview, ['example']), { ...revision, edits: [insert] });
  const decide = blockIds => textbook.proposal({ learner, id }, proposal.commandId, { blockIds });
  await assert.rejects(decide(['missing']), /请选择有效/);
  const accepted = await decide(['formula', 'example']);
  assert.equal(accepted.status, 'applied');
  assert.equal(accepted.result.rev, 5);
  assert.deepEqual((await current(id)).value.blocks, [rewritten, note, example, savedIntro]);

  const undo = (blockId, expectedRev) => send('content.undoTextbookWrite', {
    id, expectedRev, appliedRev: 5, priorRev: 4, blockIds: [blockId],
  });
  await undo('formula', 5);
  assert.deepEqual((await current(id)).value.blocks, [formula, note, example, savedIntro]);
  await assert.rejects(undo('formula', 6), /教材块自采纳后已变更/);
  await undo('example', 6);
  assert.deepEqual((await current(id)).value.blocks, [formula, note, savedIntro]);
  const nextDraft = { clientEditSeq: 2, edits: [rewrite('intro', text + '续写'), rewrite('note', '续写笔记')] };
  await assert.rejects(save(loser, nextDraft, 'teaching-continued', 'teaching'), /requires purpose storage/);
  await assert.rejects(read(context => openTextbookConflict({ learner, read: context }, draftId), 'teaching'),
    /does not allow read purpose teaching/);
  const updated = await save(loser, nextDraft, 'newer-save');
  assert.deepEqual(updated.wrote, [{ learner, id: draftId, rev: 2 }]);
  assert.deepEqual(await save(loser, nextDraft, 'newer-save'), updated);
  assert.deepEqual(await save(devices[winner]), saves[winner]);
  assert.deepEqual(await save(loser), saves[1 - winner]);
  await assert.rejects(save(loser, nextDraft), /different command identity/);
  await assert.rejects(save(loser, {}, 'delayed-save'), /草稿编辑序号已过时/);
  await assert.rejects(save(loser, { ...nextDraft, base_rev: 7 }, 'wrong-base'), /草稿所属页或基版本不符/);
  const copies = await read(context => openTextbookConflict({ learner, read: context }, draftId));
  assert.equal(copies.base.rev, 3);
  assert.equal(copies.saved.ref.rev, 4);
  assert.deepEqual(copies.saved.page.blocks, [formula, note, savedIntro]);
  assert.equal(copies.ref.rev, 2);
  assert.equal(copies.draft.clientEditSeq, 2);
  assert.deepEqual(copies.draft.page.blocks, [formula, block('note', '续写笔记'), block('intro', text + '续写')]);
  await send('content.setTextbookTeaching', { id, expectedRev: 7, enabled: false });
  await assert.rejects(openBlock('proof', 'following', 'teaching'), /does not allow read purpose teaching/);

  const disciplineId = idFor('discipline');
  const discipline_context = {
    learningScope: '使用充足材料修复不同弦乐弓',
    mastery: '给出能复核的材料、工序与验收条件',
    assessment: ['比较修复前后的稳定性'],
    boundaries: ['音色偏好不可客观评分'],
  };
  await send('content.saveDisciplineContext', { id: disciplineId, title: '弦乐弓修复', discipline_context });
  const discipline = await current(disciplineId);
  assert.equal(discipline.type, 'content.asset');
  assert.equal(discipline.value.kind, 'discipline');
  assert.deepEqual(discipline.value.discipline_context, discipline_context);

  await exerciseGraphEvolution(fixture, decideProposal);
}

async function exerciseGraphEvolution({ db, learner, send, sendCompanion, stableId, assert, snapshot, read, content, load, publish }, decideProposal) {
  const question = graph.question.id;
  const targetBasis = stableId('graph-merge-target-basis');
  const parent = graph.split.id;
  const child = graph.split.children[1].id;
  const edgeId = graph.edge.id;
  const decide = (type, proposalId, accept = true) => decideProposal({
    learner, purpose: 'storage', type, id: stableId('graph-evolution-decision', proposalId), proposalId,
    selection: accept ? 'accept' : 'reject',
  }, async (_, input) => accept ? input : null);
  const name = term => read(async context => (await openKnowledgeName(context, 'concept', term))?.snapshot.ref);
  const openEdge = mode => read(read => openKnowledgeEdgeRevision({ learner, read }, edgeId,
    mode === 'pinned' ? { mode, rev: 1 } : { mode }));
  const questionWithSolution = { ...graph.question.asset, blocks: [...graph.question.asset.blocks,
    { id: 'private-solution', parentId: null, body: { kind: 'text', text: '仅供解答。' } }] };
  await send(saveQuestionCommand, { ...graph.question, asset: questionWithSolution });
  await send(saveQuestionCommand, { ...graph.question, id: targetBasis });
  for (const concept of graph.concepts) {
    await send('content.createKnowledgeEntity', concept.id === graph.merge.into ? {
      ...concept, resolution: { ...concept.resolution, sourceUses: [{ id: targetBasis, rev: 1, accessEpoch: '0' }] },
    } : concept);
  }
  await send(createKnowledgeEdgeCommand, graph.edge);

  const rejected = await sendCompanion(evolveGraphCommand, graph.split);
  assert.equal(rejected.state, 'proposed');
  assert.deepEqual(rejected.wrote, []);
  assert.equal((await decide(evolveGraphCommand, rejected.commandId, false)).state, 'rejected');
  assert.equal(await name('时间加权均速'), undefined);

  const wrongPurpose = await sendCompanion(evolveGraphCommand, { ...graph.split, purpose: 'storage' });
  await assert.rejects(decide(evolveGraphCommand, wrongPurpose.commandId), /用途/);
  assert.equal(await name('等时均速'), undefined);

  const accept = await sendCompanion(evolveGraphCommand, graph.split);
  const competing = await sendCompanion(evolveGraphCommand, graph.split);
  assert.equal((await openEdge('following')).edge.to.sourceUse.id, parent);
  const results = await Promise.allSettled([accept, competing].map(receipt =>
    decide(evolveGraphCommand, receipt.commandId)));
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual(await name('时间加权均速'), { learner, id: child, rev: 1 });
  assert.deepEqual(await name('均速'), { learner, id: parent, rev: 1 });
  assert.equal((await openEdge('pinned')).edge.to.sourceUse.id, parent);
  assert.equal((await openEdge('following')).edge.to.sourceUse.id, child);

  const conflictingChildren = graph.split.children.map((entry, index) => ({
    ...entry, id: index === 0 ? '01KFS4AAA00000000000000007' : '01KFS4AAA00000000000000008',
    entity: { ...entry.entity, canonicalName: index === 0 ? '等时段概念' : '变时段概念',
      aliases: index === 0 ? ['等时段'] : ['时间加权均速'] },
  }));
  const collision = await sendCompanion(evolveGraphCommand, {
    ...graph.split, children: conflictingChildren, reattachments: [],
  });
  await assert.rejects(decide(evolveGraphCommand, collision.commandId), /已有同名实体/);
  assert.equal(await name('等时段'), undefined);

  const hierarchies = await Promise.all(graph.split.children.map(item => splitConceptHierarchyEdgeId(item.id, parent)));
  const hierarchy = hierarchies[1];
  const openHierarchy = (mode, purpose) => read(read => openKnowledgeEdgeRevision({ learner, read }, hierarchy,
    mode === 'pinned' ? { mode, rev: 1 } : { mode }), purpose);
  for (const [index, id] of hierarchies.entries()) {
    const { edge } = await read(read => openKnowledgeEdgeRevision({ learner, read }, id, { mode: 'following' }));
    assert.deepEqual([edge.from.sourceUse.id, edge.to.sourceUse.id], [graph.split.children[index].id, parent]);
  }
  const evolved = await read(async read => walkKnowledgeEdges({ learner, read }, {
    root: (await openKnowledgeEdgeRevision({ learner, read }, edgeId, { mode: 'following' })).edge.from,
    edgeIds: [edgeId, hierarchy], mode: 'following', hops: 2, direction: 'outbound',
  }), 'teaching');
  assert.deepEqual(evolved.paths.map(step => step.endpoint.sourceUse.id), [child, parent]);

  const absorbedEdge = stableId('graph-edge-between-merge-pair');
  const left = graph.edge.edge.to;
  const right = { ...left, sourceUse: { ...left.sourceUse, id: graph.merge.into } };
  await send(createKnowledgeEdgeCommand, { ...graph.edge, id: absorbedEdge,
    edge: { ...graph.edge.edge, kind: 'related_to', from: left, to: right, sourceUses: [left.sourceUse, right.sourceUse] } });
  const merge = await sendCompanion(evolveGraphCommand, graph.merge);
  assert.equal(merge.state, 'proposed');
  assert.deepEqual(merge.wrote, []);
  assert.equal((await name('均速'))?.id, parent);
  await decide(evolveGraphCommand, merge.commandId);
  assert.equal((await name('均速'))?.id, graph.merge.into);
  const followed = await openHierarchy('following', 'teaching');
  assert.equal(followed.edge.to.sourceUse.id, graph.merge.into);
  assert.equal(followed.snapshot.value.to.sourceUse.id, parent);
  assert.equal((await openHierarchy('pinned')).edge.to.sourceUse.id, parent);
  await assert.rejects(read(read => openKnowledgeEdgeRevision({ learner, read }, absorbedEdge, { mode: 'following' })),
    /两端已合并/);
  const oldEdge = await read(read => openKnowledgeEdgeRevision({ learner, read }, absorbedEdge, { mode: 'pinned', rev: 1 }));
  assert.deepEqual([oldEdge.edge.from, oldEdge.edge.to], [left, right]);
  const childrenOfMerged = await read(read => walkKnowledgeEdges({ learner, read }, {
    root: { kind: 'concept', sourceUse: { id: parent, rev: 1, accessEpoch: '0' } },
    edgeIds: hierarchies, mode: 'following', hops: 1, direction: 'inbound',
  }), 'teaching');
  assert.equal(childrenOfMerged.root.sourceUse.id, graph.merge.into);
  assert.deepEqual(childrenOfMerged.paths.map(({ endpoint, via }) => [endpoint.sourceUse.id, via.id]),
    graph.split.children.map(({ id }, index) => [id, hierarchies[index]]));
  const staleMerge = await sendCompanion(evolveGraphCommand, graph.merge);
  await assert.rejects(decide(evolveGraphCommand, staleMerge.commandId), /当前的规范实体修订/);
  const reverseMerge = await sendCompanion(evolveGraphCommand, {
    ...graph.merge, id: graph.merge.into, into: parent, targetRev: 2,
  });
  await assert.rejects(decide(evolveGraphCommand, reverseMerge.commandId), /当前的规范实体修订/);
  const prior = await read(context => openKnowledgeEntity(context, parent, 1));
  assert.deepEqual(prior.snapshot.ref, { learner, id: parent, rev: 1 });
  assert.equal(prior.entity.merged_into, null);
  assert.equal((await openEdge('pinned')).edge.to.sourceUse.id, parent);
  // A legacy cycle must fail closed even if all individual revisions are readable.
  const fixtureRedirect = into => db.query(
    "UPDATE fact_revs SET data=jsonb_set(data,'{merged_into}',$3::jsonb) WHERE learner_id=$1 AND fact_id=$2 AND rev=1",
    [learner, graph.merge.into, JSON.stringify(into)]);
  await fixtureRedirect(parent);
  await assert.rejects(openHierarchy('following', 'teaching'), /重定向成环/);
  assert.equal((await openHierarchy('pinned', 'teaching')).edge.to.sourceUse.id, parent);
  await fixtureRedirect(null);
  await send('content.setQuestionTeaching', { id: targetBasis, expectedRev: 1, allowed: false });
  await assert.rejects(openHierarchy('following', 'teaching'), /does not allow read purpose teaching/);
  assert.equal((await openHierarchy('pinned', 'teaching')).edge.to.sourceUse.id, parent);
  console.log(JSON.stringify({ graphEvolutionAcceptance: { following: graph.merge.into, pinned: parent,
    splitEdges: hierarchies, staleMerge: 'denied', reverseMerge: 'denied', legacyCycle: 'denied', targetProvenanceRevoked: 'denied' } }));

  assert.equal(content.slots.get(questionMetaType)?.policy, 'lazy');
  const { createAuthorizedFactReader, FactReadDeniedError } = await load('kernel/src/commands/reads.ts');
  const { readCurrentSlotOutcome } = await load('kernel/src/derivations/revalidate.ts');
  const anchor = blockId => JSON.stringify({ v: 1, fact: { id: question, rev: 1, type: 'content.asset' }, anchor: { kind: 'block', blockId } });
  const hint_ladder = { l1: '留意分段用时。', l2: '先写出每段的路程表达式。', l3: '设两段速度为 v₁、v₂，总路程为 v₁×1+v₂×2。用总路程除以总时间 3，得到 (v₁+2v₂)/3。', source_ref: anchor('prompt') };
  const withLadder = { ...graph.questionMeta, append_metadata: { ...graph.questionMeta.append_metadata, hint_ladder } };
  const frozen = { learner, id: question, rev: 1, accessEpoch: '0' };
  const hint = (level, expectedDerivationId, { recipient = learner, permits = true, ref = frozen, reveal, authorizeSolution } = {}) => snapshot(tx =>
    readQuestionHintLevel({ learner, recipient, purpose: 'teaching', isUnavailable: error => error instanceof FactReadDeniedError,
      authorizeSolution,
      read: { ...createAuthorizedFactReader(tx, 'teaching', () => permits && recipient === learner),
        slot: slot => readCurrentSlotOutcome(tx, slot, questionMetaDeriver, 'teaching') },
    }, { question: ref, level, reveal, expectedDerivationId }));
  hint_ladder.worked_example = '例如，先把第一段路程写成 v₁×1。';
  const proposeMeta = (input = withLadder) => sendCompanion(proposeQuestionMetaCommand, input);
  const proposeHintOnly = changes => proposeMeta({ ...withLadder, append_metadata: { hint_ladder: { ...hint_ladder, ...changes } } });
  await assert.rejects(proposeHintOnly({ l1: '字'.repeat(26) }), /25 字/);
  const proposed = await proposeMeta();
  for (const blockId of ['NONEXISTENT-AUDIT-BLOCK', 'private-solution']) {
    const bad = await proposeHintOnly({ source_ref: anchor(blockId) });
    await assert.rejects(decide(proposeQuestionMetaCommand, bad.commandId), /固定公开锚点/);
  }
  assert.equal(await hint(1), undefined);
  const alternative = { ...graph.questionMeta.append_metadata.solutions[0], explanation: '改成另一种说法。' };
  const otherMetadata = { ...graph.questionMeta, append_metadata: { solutions: [alternative] } };
  const stale = await proposeMeta(otherMetadata);
  assert.deepEqual(proposed.wrote, []);
  await decide(proposeQuestionMetaCommand, proposed.commandId);
  await assert.rejects(decide(proposeQuestionMetaCommand, stale.commandId), /Fact revision conflict/);
  const { expectedMetaRev: _, ...legacy } = otherMetadata;
  await assert.rejects(send(proposeQuestionMetaCommand, legacy), /Fact revision conflict/);
  const draft = await read(context => openQuestionMetaDraft(context, { learner, id: question, rev: 1 }));
  assert.equal(draft.snapshot.ref.rev, 2);
  assert.equal(draft.draft.sticky, true);
  assert.equal(await hint(1), undefined);
  const { outcome, sealed: { id: derivationId } } = await publish(questionMetaType, questionKey(frozen), questionMetaDeriver, {
    plan: ctx => gather(ctx, frozen), settle,
    invoke: ({ input }, invocation) => questionMetaEffectResult(invocation, {
      solutions: [{ ...alternative, source_ref: input.gardening.sources[0].ref }],
      hint_ladder: { ...hint_ladder, l1: '由园艺提出。', source_ref: input.gardening.sources[0].ref },
    }),
  });
  const started = performance.now();
  const opened = await Promise.all([hint(1), hint(2), hint(3, derivationId, { reveal: 'solution', authorizeSolution(scope) {
    assert.deepEqual(scope, { question: frozen, purpose: 'teaching', recipient: learner });
    return true;
  } })]);
  const elapsedMs = performance.now() - started;
  const witness = { question: frozen, overlay: { slot: { learner, type: questionMetaType, key: questionKey(frozen) }, derivationId },
    purpose: 'teaching', recipient: learner };
  assert.deepEqual(opened, [1, 2, 3].map(level => ({ level, text: hint_ladder[`l${level}`],
    step: { kind: ['hint_l1', 'hint_l2', 'solution'][level - 1], order: level }, witness })));
  const worked = await hint(3, derivationId, { reveal: 'worked-example', authorizeSolution: assert.fail });
  assert.deepEqual(worked, { level: 3, text: hint_ladder.worked_example, step: { kind: 'worked-example', order: 3 }, witness });
  assert.equal(await hint(3, derivationId, { authorizeSolution: assert.fail }), undefined);
  assert.equal(await hint(3, derivationId, { reveal: 'solution' }), undefined);
  assert.equal(await hint(3, derivationId, { reveal: 'solution', authorizeSolution: async () => false }), undefined);
  assert.equal(await hint(2, derivationId, { reveal: 'solution', authorizeSolution: assert.fail }), undefined);
  console.log(JSON.stringify({ hintRevealAcceptance: { worked, solution: opened[2], implicit: 'denied', missingPermit: 'denied', refusedPermit: 'denied' } }));
  assert.deepEqual(await hint(1, derivationId), opened[0]);
  assert.equal(await hint(1, stableId('stale-hint-overlay')), undefined);
  assert.equal(await hint(1, derivationId, { recipient: 'other-recipient' }), undefined);
  assert.equal(await hint(1, derivationId, { permits: false }), undefined);
  assert.equal(await hint(1, undefined, { ref: { ...frozen, rev: 2 } }), undefined);
  assert.equal(await hint(1, undefined, { ref: { ...frozen, accessEpoch: '1' } }), undefined);
  const solutionEvidence = ({ explanation, verification }) => ({ explanation, verification });
  assert.equal(outcome.value.sticky, true);
  assert.equal(outcome.value.hint_ladder.l1, hint_ladder.l1);
  assert.equal(outcome.value.proposals.hint_ladder.verification, 'unverified');
  assert.deepEqual(outcome.value.solutions.map(solutionEvidence), [
    { explanation: '用总路程除以总用时。', verification: 'learner-reviewed' },
  ]);
  assert.deepEqual(outcome.value.proposals.solutions.map(solutionEvidence), [
    { explanation: '改成另一种说法。', verification: 'unverified' },
  ]);
  const savedQuestion = await read(context => context.fact(question, { mode: 'pinned', rev: 1 }));
  assert.equal(savedQuestion.ref.rev, 1);
  assert.deepEqual(savedQuestion.value, questionWithSolution);
  // Simulate an already-published pre-fix draft and matching overlay.
  const legacyAnchor = anchor('NONEXISTENT-AUDIT-BLOCK');
  await db.query("UPDATE fact_revs SET data=jsonb_set(data,'{append_metadata,hint_ladder,source_ref}',to_jsonb($4::text)) WHERE learner_id=$1 AND fact_id=$2 AND rev=$3",
    [learner, draft.snapshot.ref.id, draft.snapshot.ref.rev, legacyAnchor]);
  await db.query("UPDATE derivations SET value=jsonb_set(value,'{value,hint_ladder,source_ref}',to_jsonb($3::text)) WHERE learner_id=$1 AND id=$2",
    [learner, derivationId, legacyAnchor]);
  await assert.rejects(read(context => openQuestionMetaDraft(context, frozen)), /固定公开锚点/);
  assert.equal(await hint(1, derivationId), undefined);
  const repair = await proposeMeta({ ...withLadder, expectedMetaRev: draft.snapshot.ref.rev });
  await decide(proposeQuestionMetaCommand, repair.commandId);
  const repaired = await read(context => openQuestionMetaDraft(context, frozen));
  assert.equal(repaired.draft.append_metadata.hint_ladder.source_ref, hint_ladder.source_ref);
  assert.equal(await hint(1, derivationId), undefined);
  console.log(JSON.stringify({ hintAnchorAcceptance: { command: ['missing denied', 'private denied'], legacy: 'denied', repairedDraftRev: repaired.snapshot.ref.rev } }));

  const sourceId = stableId('hint-source-revisions');
  await send(saveQuestionCommand, { ...graph.question, id: sourceId });
  const sourceUse = rev => ({ id: sourceId, rev, type: 'content.asset', epoch: '0' });
  const confirmMeta = async (expectedMetaRev, append_metadata, basis) => {
    const proposal = await proposeMeta({ ...withLadder, expectedMetaRev, append_metadata, basis });
    return decide(proposeQuestionMetaCommand, proposal.commandId);
  };
  const refOf = ({ id, rev, type }) => ({ v: 1, fact: { id, rev, type }, anchor: { kind: 'block', blockId: 'prompt' } });
  const before = (await confirmMeta(repaired.snapshot.ref.rev, { hint_ladder: { ...hint_ladder, source_ref: sourceId } }, [sourceUse(1)])).wrote[0];
  const open = () => read(context => openQuestionMetaDraft(context, frozen));
  assert.deepEqual(JSON.parse((await open()).draft.append_metadata.hint_ladder.source_ref), refOf(sourceUse(1)));
  await db.query("UPDATE fact_revs SET data=jsonb_set(data,'{append_metadata,hint_ladder,source_ref}',to_jsonb($4::text)) WHERE learner_id=$1 AND fact_id=$2 AND rev=$3",
    [learner, before.id, before.rev, sourceId]);
  await send('content.correctQuestion', { id: sourceId, expectedRev: 1, patch: {
    prompt: { block_id: 'prompt', anchor: '平均速度', replacement: '全程用时' },
  } });
  const appendedSolution = { solutions: [{ ...alternative, method: '新一版解法', source_ref: sourceId }] };
  await confirmMeta(before.rev, appendedSolution, [sourceUse(2)]);
  const currentHint = (await open()).draft;
  assert.deepEqual(currentHint.basis.filter(use => use.id === sourceId), [sourceUse(1), sourceUse(2)]);
  assert.deepEqual(JSON.parse(currentHint.append_metadata.hint_ladder.source_ref), refOf(sourceUse(1)));
  const historical = await read(context => context.fact(before.id, { mode: 'pinned', rev: before.rev }));
  assert.equal(historical.value.append_metadata.hint_ladder.source_ref, sourceId);

  await send('content.setQuestionTeaching', { id: question, expectedRev: 1, allowed: false });
  assert.equal(await hint(1, derivationId), undefined);
  console.log(JSON.stringify({ questionHintAcceptance: { opened, elapsedMs, afterRevocation: null, coldRevision: savedQuestion.ref.rev } }));
  await assert.rejects(openEdge('pinned'), /访问代次/);
  await assert.rejects(openEdge('following'), /访问代次/);
  await assert.rejects(openHierarchy('following', 'teaching'), /does not allow read purpose teaching/);
}
