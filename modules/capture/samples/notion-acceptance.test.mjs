import * as notionSource from '../notion-source.ts';

export default async function({ db, learner, load, send, sendCompanion, assert, snapshot, read, stableId, current, publish }) {
  const { createAuthorizedFactReader } = await load('kernel/src/commands/reads.ts');
  const { captureSourceCommand } = await load('modules/capture/source.ts');
  const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const at = '2026-11-20T01:00:00.000Z';
  const { readNotionSelection, notionSelectionWitness } = await load('modules/capture/notion-selection.ts');
  const settings = { selectionId: 'chemistry', root: { kind: 'page', id: uuid(1) }, preset: 'learning', recipients: [
    { id: 'notebook', purpose: 'teaching' }, { id: 'tutor', purpose: 'teaching' }, { id: 'notebook', purpose: 'learning' }] };
  const grant = (expectedEpoch, options) => send('capture.grantNotionSelection', { ...settings, expectedEpoch }, options);
  const selected = () => read(ctx => readNotionSelection(ctx, learner, settings.selectionId));
  const firstGrant = { commandId: stableId('grant-chemistry') };
  await grant('0', firstGrant);
  const selection = await selected();
  const todo = (n, checked = false, parentId = null) => ({
    id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
  });
  const page = { root: selection.root, dispatch: notionSelectionWitness(selection), pageId: selection.root.id, title: '滴定', lastEditedTime: at,
    blocks: [todo(2), todo(3), todo(4, false, uuid(3)), todo(5), todo(7)] };
  const updatedBlocks = [todo(7), todo(2, true), todo(3), todo(4), todo(6)];
  const revise = (lastEditedTime, blocks = updatedBlocks, observedAt = lastEditedTime) =>
    notionSource.prepareNotionRevision(selection, { ...page, lastEditedTime, blocks }, observedAt);
  const ingest = await notionSource.prepareNotionIngest(selection, page, at);
  const target = { id: ingest.id, expectedRev: 1, accessEpoch: '0', selectionId: selection.id };
  const access = (tx, purpose = 'teaching', recipientId = purpose === 'storage' ? learner : 'notebook') => ({
    learner, purpose, recipientId, selectionRead: createAuthorizedFactReader(tx, 'storage', () => true),
    sourceRead: createAuthorizedFactReader(tx, purpose, () => true),
  });
  const open = (rev, purpose, recipientId, id = ingest.id) => snapshot(tx =>
    notionSource.withSelectedNotionSources(access(tx, purpose, recipientId)).fact(id, { mode: 'pinned', rev }));
  const openBlock = (ref, pinned = false) => snapshot(tx =>
    (pinned ? notionSource.openPinnedNotionBlock : notionSource.openCurrentNotionBlock)(access(tx), ref));
  const sync = input => sendCompanion(notionSource.refreshNotionSourceCommand, input);
  assert.deepEqual((await sendCompanion(captureSourceCommand, ingest)).wrote, [{ learner, id: ingest.id, rev: 1 }]);
  const envelope = await revise('2026-11-20T01:01:00.000Z');
  const forged = structuredClone(envelope);
  forged.unit.blocks[0].body.text = '伪造未变哈希';
  await assert.rejects(sync({ ...target, envelope: forged }), /内容与哈希不一致/);
  assert.deepEqual((await sync({ ...target, envelope })).wrote, [{ learner, id: ingest.id, rev: 2 }]);
  const [first, second] = await Promise.all([1, 2].map(rev => open(rev)));
  assert.deepEqual(notionSource.notionRevisionDiff(first.value, second.value), { added: [uuid(6)], removed: [uuid(5)], edited: [uuid(2)], moved: [uuid(7), uuid(4)] });
  const checked = source => source.unit.blocks.find(block => block.id === uuid(2)).body.notionBody.data.checked;
  assert.deepEqual([checked(first.value), checked(second.value)], [false, true]);
  const plan = notionSource.planNotionBlockWork(first, second, 'teaching');
  assert.deepEqual(plan.rebuild.map(ref => ref.blockId), [uuid(7), uuid(2), uuid(4), uuid(6)]);
  assert.deepEqual(plan.retire.map(ref => ref.blockId), [uuid(2), uuid(4), uuid(5), uuid(7)]);
  const prior = blockId => ({ id: ingest.id, rev: 1, accessEpoch: '0', blockId: uuid(blockId) });
  assert.equal((await openBlock(prior(3))).text, '任务 3');
  assert.equal((await openBlock(prior(5), true)).text, '任务 5');
  await assert.rejects(openBlock(prior(5)), /已移除/);
  for (const id of [2, 4, 7]) await assert.rejects(openBlock(prior(id)), /已变更/);

  const conceptId = stableId('notion-test-concept');
  await send('content.createKnowledgeEntity', {
    id: conceptId, purpose: 'teaching', entity: { kind: 'concept', canonicalName: '定量滴定', aliases: ['任务 2'] },
    resolution: { decision: 'no-match', reason: '独立样例无候选', candidates: [], sourceUses: [targetUse(second)] },
  });
  const { openKnowledgeName } = await load('modules/content/knowledge-entity.ts');
  const deriver = (await load('modules/capture/derivers/notion-block.ts')).default;
  const writeEdge = (id, edge) => send('content.createKnowledgeEdge', { id, purpose: 'teaching', edge });
  const sent = [];
  const linked = [];
  for (const ref of plan.rebuild) {
    const key = notionSource.notionBlockWorkKey(ref);
    const { outcome } = await publish(notionSource.notionBlockSlot, key, notionSource.notionBlockDeriver, {
      plan: ctx => deriver.gather(ctx, key),
      inspect: gathered => assert.doesNotMatch(JSON.stringify(gathered), /任务/),
      invoke: request => snapshot(tx => notionSource.consumeNotionBlockLink(request, access(tx), async ({ text, basis }) => {
        sent.push(basis.blockId);
        const match = await openKnowledgeName(notionSource.withSelectedNotionSources(access(tx)), 'concept', text);
        return match ? [{ target: targetUse(match.snapshot), confidence: 1 }] : [];
      })),
      authorize: tx => notionSource.openCurrentNotionBlock(access(tx), ref),
      settle: (sealed, receipts) => {
        const outcome = deriver.derive({ ...sealed.plan.data, receipts });
        assert.equal(outcome.kind, 'value');
        assert.doesNotMatch(JSON.stringify(outcome), /任务/);
        return outcome;
      },
    });
    const edges = await snapshot(tx => notionSource.verifyNotionBlockEdges(access(tx), outcome.value));
    for (const edge of edges) {
      const id = stableId('notion-test-edge', edge.from.blockId);
      await writeEdge(id, edge);
      assert.equal((await current(id)).value.to.sourceUse.id, conceptId);
      linked.push(edge.from.blockId);
    }
  }
  assert.deepEqual(sent, [uuid(7), uuid(2), uuid(4), uuid(6)]);
  assert.deepEqual(linked, [uuid(2)]);
  console.log(JSON.stringify({ checked: 'notion block slots pg', rebuilt: sent, retired: plan.retire.map(ref => ref.blockId) }));
  const clock = '2026-11-20T01:03:00.000Z';
  const unchanged = await revise(clock);
  const currentTarget = { ...target, expectedRev: 2 };
  const observe = await notionSource.prepareNotionRefreshInput(currentTarget, second.value, unchanged);
  await assert.rejects(sync({ ...currentTarget, envelope: unchanged }), /无正文/);
  const duplicate = await Promise.all([sync(observe), sync(observe)]);
  assert.equal(duplicate.flatMap(receipt => receipt.wrote).length, 1);
  const late = await revise('2026-11-20T01:02:00.000Z', page.blocks, clock);
  await assert.rejects(sync(await notionSource.prepareNotionRefreshInput(currentTarget, second.value, late)), /观测已过时/);
  const renamed = { ...first.value, unit: { ...first.value.unit, title: '新标题' } };
  assert.deepEqual(notionSource.planNotionBlockWork(first, { ...second, value: renamed },
    'teaching'), { rebuild: [], retire: [] });
  const journal = await db.query("SELECT input->'input' AS payload FROM commands WHERE learner_id=$1 AND type=$2 ORDER BY tick", [learner, notionSource.refreshNotionSourceCommand]);
  assert.deepEqual(journal.rows.map(row => row.payload), [{ ...target, envelope }, observe, observe]);
  const [movedBlock, ...remainingBlocks] = updatedBlocks;
  const movesBack = await revise('2026-11-20T01:04:00.000Z', [...remainingBlocks, movedBlock]);
  await sync(await notionSource.prepareNotionRefreshInput(currentTarget, second.value, movesBack));
  assert.equal((await openBlock(prior(3))).text, '任务 3');
  assert.equal((await openBlock(prior(7), true)).text, '任务 7');
  await assert.rejects(openBlock(prior(7)), /已变更/);
  await assert.rejects(openBlock(plan.rebuild[0]), /已变更/);
  const third = await open(3);
  const { readQuestionNotionLinks } = await load('modules/content/knowledge-reads.ts');
  const questionId = stableId('notion-reverse-question');
  await send('content.saveQuestion', { id: questionId, purpose: 'teaching', asset: {
    kind: 'question', title: '滴定', promptBlockId: 'stem',
    blocks: [{ id: 'stem', parentId: null, body: { kind: 'text', text: '滴定用到了什么概念？' } }],
  } });
  const question = { kind: 'question', sourceUse: targetUse(await current(questionId)) };
  const concept = { kind: 'concept', sourceUse: targetUse(await current(conceptId)) };
  const noteAt = source => ({ kind: 'note', sourceUse: targetUse(source), blockId: uuid(2) });
  const writeTrailEdge = (id, kind, from) => writeEdge(id, {
    kind, from, to: concept, sourceUses: [from.sourceUse, concept.sourceUse], scope: 'chemistry',
  });
  const questionEdge = stableId('notion-question-target');
  await writeTrailEdge(questionEdge, 'targets_concept', question);
  const noteEdge = stableId('notion-test-edge', uuid(2));
  const beforeEdit = stableId('notion-previous-note-edge');
  await writeTrailEdge(beforeEdit, 'explains', noteAt(first));
  const reverse = (mode, edge = noteEdge) => snapshot(tx => {
    const selected = access(tx);
    return readQuestionNotionLinks({
      learner, read: notionSource.withSelectedNotionSources(selected), purpose: selected.purpose, recipient: selected.recipientId,
      isUnavailable: error => ['Notion 选源不可用。', 'Notion 块已变更。'].includes(error.message),
    }, { root: noteAt(third), mode, edgeIds: [edge, questionEdge] },
    (ref, readMode) => (readMode === 'following' ? notionSource.openCurrentNotionBlock : notionSource.openPinnedNotionBlock)(selected, ref));
  });
  const [match] = await reverse('following');
  assert.deepEqual(match.question, question.sourceUse);
  assert.deepEqual(match.trail.map(step => [step.edge.id, step.edge.rev]), [[noteEdge, 1], [questionEdge, 1]]);
  assert.deepEqual(await reverse('pinned'), []);
  assert.deepEqual(await reverse('following', beforeEdit), []);

  const withdraw = () => send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '1', recipient: settings.recipients[0] });
  const race = await Promise.allSettled([withdraw(), withdraw()]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(await reverse('following'), []);
  await assert.rejects(open(2), /选源不可用/);
  await assert.rejects(openBlock(plan.rebuild[1]), /选源不可用/);
  await assert.rejects(snapshot(tx => notionSource.consumeNotionBlockLink({
    label: notionSource.notionBlockLinkEffect, stepKey: 'links', input: plan.rebuild[1],
  }, access(tx), () => assert.fail('撤回后不能执行连边'))), /选源不可用/);
  for (const [purpose, recipient] of [['storage',learner], ['learning','notebook'], ['teaching','tutor']])
    assert.equal(checked((await open(2,purpose,recipient)).value), true);
  await send(notionSource.setNotionPurposeCommand, { ...currentTarget, expectedRev: 3, preset: 'storage' });
  const narrowed = await open(4, 'storage');
  assert.deepEqual(narrowed.purpose, ['storage']);
  assert.deepEqual(notionSource.planNotionBlockWork(third, narrowed, 'teaching').rebuild, []);
  await assert.rejects(send(notionSource.setNotionPurposeCommand, { ...currentTarget, expectedRev: 4, accessEpoch: '1', preset: 'learning' }), /选源或用途已变更/);
  await send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '2' });
  await grant('0', firstGrant);
  assert.equal((await selected()).active, false);
  await grant('3');
  const renewed = await selected();
  await assert.rejects(notionSource.prepareNotionIngest(renewed, page, at), /拉取见证已变更/);
  await assert.rejects(sync({ ...observe, expectedRev: 4, accessEpoch: '1' }), /选源或用途已变更/);
  const newSource = await notionSource.prepareNotionIngest(renewed, { ...page, dispatch: notionSelectionWitness(renewed) }, at);
  assert.notEqual(newSource.id, ingest.id);
  await sendCompanion(captureSourceCommand, newSource);
  assert.equal((await open(1, 'teaching', 'notebook', newSource.id)).ref.id, newSource.id);
  await assert.rejects(open(2, 'storage'), /选源不可用/);
  const fresh = { ...target, id: newSource.id };
  await send(notionSource.setNotionPurposeCommand, { ...fresh, preset: 'storage' });
  await assert.rejects(open(1, 'teaching', 'notebook', fresh.id), { reason: 'purpose' });
  await assert.rejects(sync({ ...fresh, expectedRev: 2, envelope }), /版本或授权已变更/);
  const storage = await open(2, 'storage', learner, fresh.id);
  assert.deepEqual(storage.purpose, ['storage']);
  assert.equal(storage.accessEpoch, '1');
  await assert.rejects(open(2, 'storage', 'other', fresh.id), /选源不可用/);
  await send(notionSource.revokeNotionSourceCommand, { ...fresh, expectedRev: 2, accessEpoch: storage.accessEpoch });
  await assert.rejects(open(1, 'storage', learner, fresh.id), { reason: 'retracted' });

  for (const preset of ['turn-only', 'temporary']) {
    await assert.rejects(notionSource.prepareNotionIngest({ ...selection, preset }, page, at), /不能保存/);
  }
}

function targetUse({ ref, accessEpoch }) {
  return { id: ref.id, rev: ref.rev, accessEpoch };
}
