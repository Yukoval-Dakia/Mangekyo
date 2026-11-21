export default async function({ db, learner, load, send, assert, read, stableId, current, publish }) {
  const { createAuthorizedFactReader } = await load('kernel/src/commands/reads.ts');
  const { captureSourceCommand } = await load('modules/capture/source.ts');
  const {
    notionRevisionDiff, withSelectedNotionSources, prepareNotionRefreshInput,
    prepareNotionIngest, prepareNotionRevision, refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand,
    planNotionBlockWork, openCurrentNotionBlock, openPinnedNotionBlock, notionBlockWorkKey,
    notionBlockDeriver, notionBlockSlot, notionBlockLinkEffect, consumeNotionBlockLink, verifyNotionBlockEdges,
  } = await load('modules/capture/notion-source.ts');
  const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const at = '2026-11-20T01:00:00.000Z';
  const { readNotionSelection, notionSelectionWitness } = await load('modules/capture/notion-selection.ts');
  const settings = { selectionId: 'chemistry', root: { kind: 'page', id: uuid(1) }, preset: 'learning', recipients: [
    { id: 'notebook', purpose: 'teaching' }, { id: 'tutor', purpose: 'teaching' }, { id: 'notebook', purpose: 'learning' }] };
  const grant = (expectedEpoch, changes, options) => send('capture.grantNotionSelection', { ...settings, expectedEpoch, ...changes }, options);
  const selected = () => read(ctx => readNotionSelection(ctx, learner, settings.selectionId));
  const firstGrant = { commandId: stableId('grant-chemistry') };
  await grant('0', {}, firstGrant);
  const selection = await selected();
  const revise = (page, observedAt = page.lastEditedTime) => prepareNotionRevision(selection, page, observedAt);
  const todo = (n, checked = false, parentId = null) => ({
    id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
  });
  const page = { root: selection.root, dispatch: notionSelectionWitness(selection), pageId: selection.root.id, title: '滴定', lastEditedTime: at,
    blocks: [todo(2), todo(3), todo(4, false, uuid(3)), todo(5), todo(7)] };
  const updated = { ...page, lastEditedTime: '2026-11-20T01:01:00.000Z', blocks: [todo(7), todo(2, true), todo(3), todo(4), todo(6)] };
  const ingest = await prepareNotionIngest(selection, page, at);
  const target = { id: ingest.id, expectedRev: 1, accessEpoch: '0', selectionId: selection.id };
  const access = (tx, purpose = 'teaching', recipientId = purpose === 'storage' ? learner : 'notebook') => ({
    learner, purpose, recipientId, selectionRead: createAuthorizedFactReader(tx, 'storage', () => true),
    sourceRead: createAuthorizedFactReader(tx, purpose, () => true),
  });
  const open = (rev, purpose, recipientId, id = ingest.id) => db.snapshot({ learner }, tx =>
    withSelectedNotionSources(access(tx, purpose, recipientId)).fact(id, { mode: 'pinned', rev }));
  const openBlock = (ref, pinned = false) => db.snapshot({ learner }, tx =>
    (pinned ? openPinnedNotionBlock : openCurrentNotionBlock)(access(tx), ref));
  const sync = input => send(refreshNotionSourceCommand, input, { actor: 'companion' });
  assert.deepEqual((await send(captureSourceCommand, ingest, { actor: 'companion' })).wrote, [{ learner, id: ingest.id, rev: 1 }]);
  const envelope = await revise(updated);
  const forged = structuredClone(envelope);
  forged.unit.blocks[0].body.text = '伪造未变哈希';
  await assert.rejects(sync({ ...target, envelope: forged }), /内容与哈希不一致/);
  assert.deepEqual((await sync({ ...target, envelope })).wrote, [{ learner, id: ingest.id, rev: 2 }]);
  const [first, second] = await Promise.all([1, 2].map(rev => open(rev)));
  const { value: before } = first;
  const { value: after } = second;
  assert.deepEqual(notionRevisionDiff(before, after), { added: [uuid(6)], removed: [uuid(5)], edited: [uuid(2)], moved: [uuid(7), uuid(4)] });
  const checked = source => source.unit.blocks.find(block => block.id === uuid(2)).body.notionBody.data.checked;
  assert.deepEqual([checked(before), checked(after)], [false, true]);
  const plan = planNotionBlockWork(first, second, 'teaching');
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
  const sent = [];
  const linked = [];
  for (const ref of plan.rebuild) {
    const key = notionBlockWorkKey(ref);
    const { outcome } = await publish(notionBlockSlot, key, notionBlockDeriver, {
      plan: ctx => deriver.gather(ctx, key),
      inspect: gathered => assert.doesNotMatch(JSON.stringify(gathered), /任务/),
      invoke: request => db.snapshot({ learner }, tx => consumeNotionBlockLink(request, access(tx), async ({ text, basis }) => {
        sent.push(basis.blockId);
        const match = await openKnowledgeName(withSelectedNotionSources(access(tx)), 'concept', text);
        return match ? [{ target: targetUse(match.snapshot), confidence: 1 }] : [];
      })),
      authorize: tx => openCurrentNotionBlock(access(tx), ref),
      settle: (sealed, receipts) => {
        const outcome = deriver.derive({ ...sealed.plan.data, receipts });
        assert.equal(outcome.kind, 'value');
        assert.doesNotMatch(JSON.stringify(outcome), /任务/);
        return outcome;
      },
    });
    const edges = await db.snapshot({ learner }, tx => verifyNotionBlockEdges(access(tx), outcome.value));
    for (const edge of edges) {
      const id = stableId('notion-test-edge', edge.from.blockId);
      await send('content.createKnowledgeEdge', { id, purpose: 'teaching', edge });
      assert.equal((await current(id)).value.to.sourceUse.id, conceptId);
      linked.push(edge.from.blockId);
    }
  }
  assert.deepEqual(sent, [uuid(7), uuid(2), uuid(4), uuid(6)]);
  assert.deepEqual(linked, [uuid(2)]);
  console.log(JSON.stringify({ checked: 'notion block slots pg', rebuilt: sent, retired: plan.retire.map(ref => ref.blockId) }));
  const clock = '2026-11-20T01:03:00.000Z';
  const unchanged = await revise({ ...updated, lastEditedTime: clock });
  const currentTarget = { ...target, expectedRev: 2 };
  const observe = await prepareNotionRefreshInput(currentTarget, after, unchanged);
  await assert.rejects(sync({ ...currentTarget, envelope: unchanged }), /无正文/);
  const duplicate = await Promise.all([sync(observe), sync(observe)]);
  assert.equal(duplicate.flatMap(receipt => receipt.wrote).length, 1);
  const late = await revise({ ...page, lastEditedTime: '2026-11-20T01:02:00.000Z' }, clock);
  await assert.rejects(sync(await prepareNotionRefreshInput(currentTarget, after, late)), /观测已过时/);
  assert.deepEqual(planNotionBlockWork(first, { ...second, value: { ...before, unit: { ...before.unit, title: '新标题' } } },
    'teaching'), { rebuild: [], retire: [] });
  const journal = await db.query("SELECT input->'input' AS payload FROM commands WHERE learner_id=$1 AND type=$2 ORDER BY tick", [learner, refreshNotionSourceCommand]);
  assert.deepEqual(journal.rows.map(row => row.payload), [{ ...target, envelope }, observe, observe]);
  const movesBack = await revise({
    ...updated, lastEditedTime: '2026-11-20T01:04:00.000Z', blocks: [...updated.blocks.slice(1), updated.blocks[0]],
  });
  await sync(await prepareNotionRefreshInput(currentTarget, after, movesBack));
  assert.equal((await openBlock(prior(3))).text, '任务 3');
  assert.equal((await openBlock(prior(7), true)).text, '任务 7');
  await assert.rejects(openBlock(prior(7)), /已变更/);
  await assert.rejects(openBlock(plan.rebuild[0]), /已变更/);
  const third = await open(3);

  const withdraw = () => send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '1', recipient: settings.recipients[0] });
  const race = await Promise.allSettled([withdraw(), withdraw()]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(open(2), /选源不可用/);
  await assert.rejects(openBlock(plan.rebuild[1]), /选源不可用/);
  await assert.rejects(db.snapshot({ learner }, tx => consumeNotionBlockLink({
    label: notionBlockLinkEffect, stepKey: 'links', input: plan.rebuild[1],
  }, access(tx), () => assert.fail('撤回后不能执行连边'))), /选源不可用/);
  for (const [purpose, recipient] of [['storage',learner], ['learning','notebook'], ['teaching','tutor']])
    assert.equal(checked((await open(2,purpose,recipient)).value), true);
  await send(setNotionPurposeCommand, { ...currentTarget, expectedRev: 3, preset: 'storage' });
  const narrowed = await open(4, 'storage');
  assert.deepEqual(narrowed.purpose, ['storage']);
  assert.deepEqual(planNotionBlockWork(third, narrowed, 'teaching').rebuild, []);
  await assert.rejects(send(setNotionPurposeCommand, { ...currentTarget, expectedRev: 4, accessEpoch: '1', preset: 'learning' }), /选源或用途已变更/);
  await send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '2' });
  await grant('0', {}, firstGrant);
  assert.equal((await selected()).active, false);
  await grant('3', {});
  const renewed = await selected();
  await assert.rejects(prepareNotionIngest(renewed, page, at), /拉取见证已变更/);
  await assert.rejects(sync({ ...observe, expectedRev: 4, accessEpoch: '1' }), /选源或用途已变更/);
  const newSource = await prepareNotionIngest(renewed, { ...page, dispatch: notionSelectionWitness(renewed) }, at);
  assert.notEqual(newSource.id, ingest.id);
  await send(captureSourceCommand, newSource, { actor: 'companion' });
  assert.equal((await open(1, 'teaching', 'notebook', newSource.id)).ref.id, newSource.id);
  await assert.rejects(open(2, 'storage'), /选源不可用/);
  const fresh = { ...target, id: newSource.id };
  await send(setNotionPurposeCommand, { ...fresh, preset: 'storage' });
  await assert.rejects(open(1, 'teaching', 'notebook', fresh.id), { reason: 'purpose' });
  await assert.rejects(sync({ ...fresh, expectedRev: 2, envelope }), /版本或授权已变更/);
  const storage = await open(2, 'storage', learner, fresh.id);
  assert.deepEqual(storage.purpose, ['storage']);
  assert.equal(storage.accessEpoch, '1');
  await assert.rejects(open(2, 'storage', 'other', fresh.id), /选源不可用/);
  await send(revokeNotionSourceCommand, { ...fresh, expectedRev: 2, accessEpoch: storage.accessEpoch });
  await assert.rejects(open(1, 'storage', learner, fresh.id), { reason: 'retracted' });

  for (const preset of ['turn-only', 'temporary']) {
    await assert.rejects(prepareNotionIngest({ ...selection, preset }, page, at), /不能保存/);
  }
}

function targetUse({ ref, accessEpoch }) {
  return { id: ref.id, rev: ref.rev, accessEpoch };
}
