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
  const sourceId = stableId('hint-source-revisions');
  const { id: parent, into: target } = graph.merge;
  const [firstChild, secondChild] = graph.split.children;
  const decide = (type, proposalId, accept = true) => decideProposal({
    learner, purpose: 'storage', type, id: stableId('graph-evolution-decision', proposalId), proposalId,
    selection: accept ? 'accept' : 'reject',
  }, async (_, input) => accept ? input : null);
  const proposeGraph = input => sendCompanion(evolveGraphCommand, input);
  const decideGraph = (receipt, accept) => decide(evolveGraphCommand, receipt.commandId, accept);
  const name = term => read(async context => (await openKnowledgeName(context, 'concept', term))?.snapshot.ref);
  const follow = { mode: 'following' };
  const pin = { mode: 'pinned', rev: 1 };
  const openEdge = (id, options, purpose) => read(read => openKnowledgeEdgeRevision({ learner, read }, id, options), purpose);
  const questionWithSolution = { ...graph.question.asset, blocks: [...graph.question.asset.blocks,
    { id: 'private-solution', parentId: null, body: { kind: 'text', text: '仅供解答。' } }] };
  await send(saveQuestionCommand, { ...graph.question, asset: questionWithSolution });
  await send(saveQuestionCommand, { ...graph.question, id: sourceId });
  const [originalConcept, targetConcept] = graph.concepts;
  await send('content.createKnowledgeEntity', originalConcept);
  await send('content.createKnowledgeEntity', { ...targetConcept,
    resolution: { ...targetConcept.resolution, sourceUses: [{ id: sourceId, rev: 1, accessEpoch: '0' }] } });
  await send(createKnowledgeEdgeCommand, graph.edge);

  const rejected = await proposeGraph(graph.split);
  assert.equal(rejected.state, 'proposed');
  assert.deepEqual(rejected.wrote, []);
  assert.equal((await decideGraph(rejected, false)).state, 'rejected');
  await assert.rejects(decideGraph(await proposeGraph({ ...graph.split, purpose: 'storage' })), /用途/);
  assert.equal(await name('等时均速'), undefined);

  const proposals = await Promise.all([proposeGraph(graph.split), proposeGraph(graph.split)]);
  assert.equal((await openEdge(graph.edge.id, follow)).edge.to.sourceUse.id, parent);
  const results = await Promise.allSettled(proposals.map(receipt => decideGraph(receipt)));
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.deepEqual(await name('时间加权均速'), { learner, id: secondChild.id, rev: 1 });
  assert.equal((await openEdge(graph.edge.id, pin)).edge.to.sourceUse.id, parent);
  const newChild = { ...firstChild, id: stableId('split-collision-child'),
    entity: { ...firstChild.entity, canonicalName: '等时段', aliases: [] } };
  const aliasConflict = { ...secondChild, id: stableId('split-alias-collision'),
    entity: { ...secondChild.entity, canonicalName: '变时段概念', aliases: ['时间加权均速'] } };
  const collision = { ...graph.split, children: [newChild, aliasConflict], reattachments: [] };
  await assert.rejects(decideGraph(await proposeGraph(collision)), /已有同名实体/);
  assert.equal(await name(newChild.entity.canonicalName), undefined);

  const hierarchies = await Promise.all(graph.split.children.map(item => splitConceptHierarchyEdgeId(item.id, parent)));
  const absorbedEdge = stableId('graph-edge-between-merge-pair');
  const left = graph.edge.edge.to;
  const right = { ...left, sourceUse: { ...left.sourceUse, id: target } };
  await send(createKnowledgeEdgeCommand, { ...graph.edge, id: absorbedEdge,
    edge: { ...graph.edge.edge, kind: 'related_to', from: left, to: right, sourceUses: [left.sourceUse, right.sourceUse] } });
  const merge = await proposeGraph(graph.merge);
  assert.equal((await name('均速'))?.id, parent);
  await decideGraph(merge);
  assert.equal((await name('均速'))?.id, target);
  const followed = await openEdge(hierarchies[1], follow, 'teaching');
  assert.equal(followed.edge.to.sourceUse.id, target);
  assert.equal(followed.snapshot.value.to.sourceUse.id, parent);
  await assert.rejects(openEdge(absorbedEdge, follow), /两端已合并/);
  const { edge: oldEdge } = await openEdge(absorbedEdge, pin);
  assert.deepEqual([oldEdge.from, oldEdge.to], [left, right]);
  const childrenOfMerged = await read(read => walkKnowledgeEdges({ learner, read }, {
    root: left, edgeIds: [...hierarchies, graph.edge.id, absorbedEdge], mode: 'following', hops: 2, direction: 'inbound',
  }), 'teaching');
  assert.deepEqual(childrenOfMerged.paths.map(({ endpoint, via }) => [endpoint.sourceUse.id, via.id]),
    [[firstChild.id, hierarchies[0]], [secondChild.id, hierarchies[1]], [question, graph.edge.id]]);
  const reverse = { ...graph.merge, id: target, into: parent, targetRev: 2 };
  for (const input of [graph.merge, reverse]) {
    await assert.rejects(decideGraph(await proposeGraph(input)), /当前的规范实体修订/);
  }
  const { entity: historicalEntity } = await read(context => openKnowledgeEntity(context, parent, 1));
  assert.equal(historicalEntity.merged_into, null);
  // A legacy cycle must fail closed even if all individual revisions are readable.
  const fixtureRedirect = into => db.query(
    "UPDATE fact_revs SET data=jsonb_set(data,'{merged_into}',$3::jsonb) WHERE learner_id=$1 AND fact_id=$2 AND rev=1",
    [learner, target, JSON.stringify(into)]);
  await fixtureRedirect(parent);
  await assert.rejects(openEdge(hierarchies[1], follow, 'teaching'), /重定向成环/);
  await fixtureRedirect(null);

  assert.equal(content.slots.get(questionMetaType)?.policy, 'lazy');
  const { createAuthorizedFactReader, FactReadDeniedError } = await load('kernel/src/commands/reads.ts');
  const { readCurrentSlotOutcome } = await load('kernel/src/derivations/revalidate.ts');
  const anchor = blockId => JSON.stringify({ v: 1, fact: { id: question, rev: 1, type: 'content.asset' }, anchor: { kind: 'block', blockId } });
  const hint_ladder = { l1: '留意分段用时。', l2: '先写出每段的路程表达式。', l3: '设两段速度为 v₁、v₂，总路程为 v₁×1+v₂×2。用总路程除以总时间 3，得到 (v₁+2v₂)/3。', source_ref: anchor('prompt') };
  const withLadder = { ...graph.questionMeta, append_metadata: { ...graph.questionMeta.append_metadata, hint_ladder } };
  const frozen = { learner, id: question, rev: 1, accessEpoch: '0' };
  const openDraft = () => read(context => openQuestionMetaDraft(context, frozen));
  const hint = (level, expectedDerivationId, { recipient = learner, permits = true, ref = frozen, reveal, authorizeSolution } = {}) => snapshot(tx =>
    readQuestionHintLevel({ learner, recipient, purpose: 'teaching', isUnavailable: error => error instanceof FactReadDeniedError,
      authorizeSolution,
      read: { ...createAuthorizedFactReader(tx, 'teaching', () => permits && recipient === learner),
        slot: slot => readCurrentSlotOutcome(tx, slot, questionMetaDeriver, 'teaching') },
    }, { question: ref, level, reveal, expectedDerivationId }));
  hint_ladder.worked_example = '例如，先把第一段路程写成 v₁×1。';
  const proposeMeta = (input = withLadder) => sendCompanion(proposeQuestionMetaCommand, input);
  const decideMeta = receipt => decide(proposeQuestionMetaCommand, receipt.commandId);
  const confirmMeta = async input => decideMeta(await proposeMeta({ ...withLadder, ...input }));
  const proposeHintOnly = changes => proposeMeta({ ...withLadder, append_metadata: { hint_ladder: { ...hint_ladder, ...changes } } });
  await assert.rejects(proposeHintOnly({ l1: '字'.repeat(26) }), /25 字/);
  const proposed = await proposeMeta();
  const [missingAnchor, privateAnchor] = ['NONEXISTENT-AUDIT-BLOCK', 'private-solution'].map(anchor);
  for (const source_ref of [missingAnchor, privateAnchor]) {
    await assert.rejects(decideMeta(await proposeHintOnly({ source_ref })), /固定公开锚点/);
  }
  const alternative = { ...graph.questionMeta.append_metadata.solutions[0], explanation: '改成另一种说法。' };
  const otherMetadata = { ...graph.questionMeta, append_metadata: { solutions: [alternative] } };
  const stale = await proposeMeta(otherMetadata);
  assert.deepEqual(proposed.wrote, []);
  await decideMeta(proposed);
  await assert.rejects(decideMeta(stale), /Fact revision conflict/);
  const { expectedMetaRev: _, ...legacy } = otherMetadata;
  await assert.rejects(send(proposeQuestionMetaCommand, legacy), /Fact revision conflict/);
  const draft = await openDraft();
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
  const opened = await Promise.all([hint(1), hint(2), hint(3, derivationId, { reveal: 'solution', authorizeSolution(scope) {
    assert.deepEqual(scope, { question: frozen, purpose: 'teaching', recipient: learner });
    return true;
  } })]);
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
  assert.deepEqual((await read(context => context.fact(question, pin))).value, questionWithSolution);
  const seedLegacyHintAnchor = ({ id, rev }, anchor) => db.query(
    "UPDATE fact_revs SET data=jsonb_set(data,'{append_metadata,hint_ladder,source_ref}',to_jsonb($4::text)) WHERE learner_id=$1 AND fact_id=$2 AND rev=$3",
    [learner, id, rev, anchor]);
  // Simulate an already-published pre-fix draft and matching overlay.
  await seedLegacyHintAnchor(draft.snapshot.ref, missingAnchor);
  await db.query("UPDATE derivations SET value=jsonb_set(value,'{value,hint_ladder,source_ref}',to_jsonb($3::text)) WHERE learner_id=$1 AND id=$2",
    [learner, derivationId, missingAnchor]);
  await assert.rejects(openDraft(), /固定公开锚点/);
  assert.equal(await hint(1, derivationId), undefined);
  await confirmMeta({ expectedMetaRev: draft.snapshot.ref.rev });
  const repaired = await openDraft();
  assert.equal(repaired.draft.append_metadata.hint_ladder.source_ref, hint_ladder.source_ref);
  assert.equal(await hint(1, derivationId), undefined);

  const sourceUse = rev => ({ id: sourceId, rev, type: 'content.asset', epoch: '0' });
  const refOf = ({ id, rev, type }) => ({ v: 1, fact: { id, rev, type }, anchor: { kind: 'block', blockId: 'prompt' } });
  const { wrote: [before] } = await confirmMeta({ expectedMetaRev: repaired.snapshot.ref.rev,
    append_metadata: { hint_ladder: { ...hint_ladder, source_ref: sourceId } }, basis: [sourceUse(1)] });
  assert.deepEqual(JSON.parse((await openDraft()).draft.append_metadata.hint_ladder.source_ref), refOf(sourceUse(1)));
  await seedLegacyHintAnchor(before, sourceId);
  await send('content.correctQuestion', { id: sourceId, expectedRev: 1, patch: {
    prompt: { block_id: 'prompt', anchor: '平均速度', replacement: '全程用时' },
  } });
  const appendedSolution = { solutions: [{ ...alternative, method: '新一版解法', source_ref: sourceId }] };
  await confirmMeta({ expectedMetaRev: before.rev, append_metadata: appendedSolution, basis: [sourceUse(2)] });
  const currentHint = (await openDraft()).draft;
  assert.deepEqual(currentHint.basis.filter(use => use.id === sourceId), [sourceUse(1), sourceUse(2)]);
  assert.deepEqual(JSON.parse(currentHint.append_metadata.hint_ladder.source_ref), refOf(sourceUse(1)));
  const historical = await read(context => context.fact(before.id, { mode: 'pinned', rev: before.rev }));
  assert.equal(historical.value.append_metadata.hint_ladder.source_ref, sourceId);

  await send('content.setQuestionTeaching', { id: sourceId, expectedRev: 2, allowed: false });
  await assert.rejects(openEdge(hierarchies[1], follow, 'teaching'), /does not allow read purpose teaching/);
  assert.equal((await openEdge(hierarchies[1], pin, 'teaching')).edge.to.sourceUse.id, parent);
  await send('content.setQuestionTeaching', { id: question, expectedRev: 1, allowed: false });
  assert.equal(await hint(1, derivationId), undefined);
  console.log(JSON.stringify({ questionHintAcceptance: { opened, worked, afterRevocation: null } }));
  for (const options of [pin, follow]) await assert.rejects(openEdge(graph.edge.id, options), /访问代次/);
}
