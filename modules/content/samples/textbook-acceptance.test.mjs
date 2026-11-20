export default async function ({ db, learner, load, send, stableId, assert, read, current, content, hooks }) {
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
  const follow = blockId => read(context => openTextbookBlock(context, original, blockId, 'following'));
  const moved = await follow('intro');
  assert.equal(moved.ref.id, id);
  assert.notEqual(moved.block.id, 'intro');
  assert.deepEqual(moved.block.body, body('来源块'));
  const split = { source: { id, expectedRev: 2 }, title: '子页', blockIds: [moved.block.id] };
  await assert.rejects(send('content.splitTextbookPage', { ...split, newId: source }), /Fact already exists/);
  await send('content.splitTextbookPage', { ...split, newId: child });
  const proof = await follow('proof');
  assert.equal(proof.ref.id, child);
  assert.deepEqual(proof.block, block('proof', '子块', moved.block.id));
  assert.deepEqual((await read(context => openTextbookBlock(context, original, 'intro'))).block, block('intro', '来源块'));
  await send('content.archiveTextbookPage', { id: child, expectedRev: 1 });
  await assert.rejects(send('content.reviseTextbookPage', {
    id: child, expectedRev: 2, clientEditSeq: 1, edits: [rewrite('proof', '归档后编辑')],
  }), /教材已归档/);

  const devices = ['甲设备', '乙设备'].map(text => ({ text, draftId: idFor(text) }));
  const saves = await Promise.all(devices.map(({ text, draftId }) => send('content.saveTextbookDraft', {
    id, draftId, base_rev: 3, clientEditSeq: 1, edits: [rewrite('intro', text)],
  })));
  const winner = saves.findIndex(receipt => receipt.wrote[0].id === id);
  assert.notEqual(winner, -1);
  const savedIntro = block('intro', devices[winner].text);
  const { draftId, text } = devices[1 - winner];
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
  const proposal = await send('content.reviseTextbookPage', revision, { actor: 'companion', purpose: 'teaching' });
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
  const copies = await read(context => openTextbookConflict({ learner, read: context }, draftId));
  assert.equal(copies.base.rev, 3);
  assert.equal(copies.saved.ref.rev, 4);
  assert.deepEqual(copies.saved.page.blocks, [formula, note, savedIntro]);
  assert.deepEqual(copies.draft.page.blocks, [formula, note, block('intro', text)]);
  await send('content.setTextbookTeaching', { id, expectedRev: 7, enabled: false });
  await assert.rejects(read(context => openTextbookBlock(context, original, 'proof', 'following'), 'teaching'),
    /does not allow read purpose teaching/);

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
}
