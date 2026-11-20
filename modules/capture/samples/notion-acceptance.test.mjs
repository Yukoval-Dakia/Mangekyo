export default async function({ db, learner, load, send, assert, read, stableId }) {
  const { createAuthorizedFactReader } = await load('kernel/src/commands/reads.ts');
  const { captureSourceCommand } = await load('modules/capture/source.ts');
  const {
    notionRevisionDiff, withSelectedNotionSources,
    prepareNotionIngest, prepareNotionRevision, refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand,
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
  const todo = (n, checked = false, parentId = null) => ({
    id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
  });
  const page = { root: selection.root, dispatch: notionSelectionWitness(selection), pageId: selection.root.id, title: '滴定', lastEditedTime: at,
    blocks: [todo(2), todo(3), todo(4, false, uuid(3)), todo(5), todo(7)] };
  const updated = { ...page, blocks: [todo(7), todo(2, true), todo(3), todo(4), todo(6)] };
  const ingest = await prepareNotionIngest(selection, page, at);
  const target = { id: ingest.id, expectedRev: 1, accessEpoch: '0', selectionId: selection.id };
  const open = (rev, purpose = 'teaching', recipientId = purpose === 'storage' ? learner : 'notebook', id = ingest.id) => db.snapshot({ learner }, tx =>
    withSelectedNotionSources({ learner, purpose, recipientId, selectionRead: createAuthorizedFactReader(tx, 'storage', () => true),
      sourceRead: createAuthorizedFactReader(tx, purpose, () => true) }).fact(id, { mode: 'pinned', rev }));
  const sync = input => send(refreshNotionSourceCommand, input, { actor: 'companion' });
  assert.deepEqual((await send(captureSourceCommand, ingest, { actor: 'companion' })).wrote, [{ learner, id: ingest.id, rev: 1 }]);
  const envelope = await prepareNotionRevision(selection, updated, '2026-11-20T01:01:00.000Z');
  assert.deepEqual((await sync({ ...target, envelope })).wrote, [{ learner, id: ingest.id, rev: 2 }]);
  const [before, after] = await Promise.all([1, 2].map(async rev => (await open(rev)).value));
  assert.deepEqual(notionRevisionDiff(before, after), { added: [uuid(6)], removed: [uuid(5)], edited: [uuid(2)], moved: [uuid(7), uuid(4)] });
  const checked = source => source.unit.blocks.find(block => block.id === uuid(2)).body.notionBody.data.checked;
  assert.deepEqual([checked(before), checked(after)], [false, true]);
  await assert.rejects(sync({ ...target, expectedRev: 2, envelope }), { code: 'notion_source_unchanged' });
  assert.equal((await db.query('SELECT id FROM commands WHERE learner_id=$1 AND type=$2', [learner, refreshNotionSourceCommand])).rows.length, 1);

  const withdraw = () => send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '1', recipient: settings.recipients[0] });
  const race = await Promise.allSettled([withdraw(), withdraw()]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(open(2), /选源不可用/);
  for (const [purpose, recipient] of [['storage',learner], ['learning','notebook'], ['teaching','tutor']])
    assert.equal(checked((await open(2,purpose,recipient)).value), true);
  await send('capture.revokeNotionSelection', { selectionId: selection.id, expectedEpoch: '2' });
  await grant('0', {}, firstGrant);
  assert.equal((await selected()).active, false);
  await grant('3', {});
  const renewed = await selected();
  await assert.rejects(prepareNotionIngest(renewed, page, at), /拉取见证已变更/);
  await assert.rejects(sync({ ...target, expectedRev: 2, envelope }), /选源或用途已变更/);
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
