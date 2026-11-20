export default async function({ db, learner, load, send, stableId, assert }) {
  const { createAuthorizedFactReader } = await load('kernel/src/commands/reads.ts');
  const { captureSourceCommand, sourceEnvelope } = await load('modules/capture/source.ts');
  const {
    notionRevisionDiff, notionSourceRecipient, openNotionBoundedSnapshot, prepareNotionBoundedSnapshot,
    prepareNotionIngest, prepareNotionRevision, refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand,
  } = await load('modules/capture/notion-source.ts');
  const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const at = '2026-11-20T01:00:00.000Z';
  const selection = { learner, id: 'chemistry', root: { kind: 'page', id: uuid(1) }, preset: 'learning' };
  const todo = (n, checked = false, parentId = null) => ({
    id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
  });
  const page = { pageId: selection.root.id, title: '滴定', lastEditedTime: at,
    blocks: [todo(2), todo(3), todo(4, false, uuid(3)), todo(5), todo(7)] };
  const updated = { ...page, blocks: [todo(7), todo(2, true), todo(3), todo(4), todo(6)] };
  const ingest = await prepareNotionIngest(selection, page, at);
  const target = { id: ingest.id, expectedRev: 1, accessEpoch: '0', selectionId: selection.id };
  const open = (rev, purpose = 'teaching') => db.snapshot({ learner }, tx => createAuthorizedFactReader(tx, purpose,
    notionSourceRecipient(selection, purpose, purpose === 'storage' ? 'learner' : 'workspace'))
    .fact(ingest.id, { mode: 'pinned', rev }));
  const sync = input => send(refreshNotionSourceCommand, input, { actor: 'companion' });
  assert.deepEqual((await send(captureSourceCommand, ingest, { actor: 'companion' })).wrote, [{ learner, id: ingest.id, rev: 1 }]);
  const envelope = await prepareNotionRevision(selection, updated, '2026-11-20T01:01:00.000Z');
  assert.deepEqual((await sync({ ...target, envelope })).wrote, [{ learner, id: ingest.id, rev: 2 }]);
  const before = sourceEnvelope((await open(1)).value);
  const after = sourceEnvelope((await open(2)).value);
  assert.deepEqual(notionRevisionDiff(before, after), { added: [uuid(6)], removed: [uuid(5)], edited: [uuid(2)], moved: [uuid(7), uuid(4)] });
  const checked = source => source.unit.blocks.find(block => block.id === uuid(2)).body.notionBody.data.checked;
  assert.deepEqual([checked(before), checked(after)], [false, true]);
  assert.deepEqual((await sync({ ...target, expectedRev: 2, envelope })).wrote, []);

  await send(setNotionPurposeCommand, { ...target, expectedRev: 2, preset: 'storage' });
  await assert.rejects(open(2), { reason: 'purpose' });
  await assert.rejects(sync({ ...target, expectedRev: 3, envelope }), /版本或授权已变更/);
  const storage = await open(3, 'storage');
  assert.deepEqual(storage.purpose, ['storage']);
  assert.equal(storage.accessEpoch, '1');
  await send(revokeNotionSourceCommand, { ...target, expectedRev: 3, accessEpoch: storage.accessEpoch });
  await assert.rejects(open(1, 'storage'), { reason: 'retracted' });

  const use = {
    selection: { learner, selectionId: selection.id, selectionEpoch: '4', root: selection.root },
    pageId: page.pageId, conversationId: stableId('notion-acceptance-chat'), turnId: stableId('notion-acceptance-turn'),
    authorizationEpoch: '2', recipient: { purpose: 'turn-tool', id: 'tool-call-8' },
    authorizedAt: at, expiresAt: '2026-11-21T01:00:00.000Z',
  };
  for (const preset of ['turn-only', 'temporary']) {
    await assert.rejects(prepareNotionIngest({ ...selection, preset }, page, at), /不能保存/);
    const grant = { ...use, preset };
    const snapshot = await prepareNotionBoundedSnapshot(grant, grant, page, at);
    assert.equal(openNotionBoundedSnapshot(snapshot, grant, at).blocks[0].text, '任务 2');
    const mismatch = [
      { ...grant, turnId: stableId('next-turn') },
      { ...grant, recipient: { ...grant.recipient, id: 'other-tool' } },
    ];
    for (const current of mismatch) assert.throws(() => openNotionBoundedSnapshot(snapshot, current, at), /本轮授权无效/);
    assert.throws(() => openNotionBoundedSnapshot(snapshot, grant, grant.expiresAt), /本轮授权无效/);
  }
}
