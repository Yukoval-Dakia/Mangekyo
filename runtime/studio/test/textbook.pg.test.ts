import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { commandId, factId, learnerId } from '../../../kernel/src/declarations/ids.ts';
import type { TextbookBlock } from '../../../modules/content/textbook-page.ts';
import { organizerNoteType } from '../../../modules/activity/organizer-values.ts';
import { stableId } from '../identity.ts';
import { openTextbook, TextbookConflictError } from '../textbook.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { loadStudioTestModule } from './modules.ts';

const learner = learnerId(stableId('textbook', 'learner'));

it.skipIf(!testDatabaseUrl)('serves nested pages, retains conflicting edits, and scopes reference access', () =>
  withLearnerDatabase(learner, async db => {
    const content = await loadStudioTestModule('content');
    const activity = await loadStudioTestModule('activity');
    const textbook = openTextbook(db, content, { async onFactsChanged() {} });
    const request = (name: string) => stableId('textbook-request', name);
    const page = (id: string, parentId: string | null, value: string): TextbookBlock => ({ id, parentId, body: { kind: 'text', text: value } });
    const create = (name: string, title: string, content: TextbookBlock[]) => textbook.create({ learner, requestId: request(name), clientEditSeq: 0, page: { title, blocks: content } });
    const blocks = [page('root', null, '一级'), page('second', 'root', '二级'), page('third', 'second', '三级'), page('fourth', 'third', '四级'), page('fifth', 'fourth', '五级'), page('sixth', 'fifth', '六级')];
    const created = await create('create', '嵌套教材', blocks);
    const edit = (name: string, seq: number, rev: number, blockId: string, value: string) => ({
      learner, requestId: request(name), id: created.id, expectedRev: rev, clientEditSeq: seq,
      edits: [{ kind: 'rewrite', blockId, body: { kind: 'text', text: value } }],
    });
    expect(created).toMatchObject({ id: created.id, expectedRev: null, rev: 1, clientEditSeq: 0, state: 'done' });
    expect(await create('create', '嵌套教材', blocks)).toEqual(created);
    expect((await textbook.list({ learner })).pages[0]).toMatchObject({ id: created.id, purpose: ['storage'], readOnly: false }); await expect(create('create', '另一页', blocks)).rejects.toMatchObject({ status: 409 });

    const firstEdit = edit('edit-1', 1, 1, 'sixth', '第一端的新稿');
    const first = await textbook.revise(firstEdit);
    expect(first).toMatchObject({ rev: 2, expectedRev: 1, clientEditSeq: 1, requestId: request('edit-1') });
    expect(await textbook.revise(firstEdit)).toEqual(first);
    await expect(textbook.revise({ ...firstEdit, ...edit('duplicate-seq', 1, 1, 'fifth', '同序号的不同编辑') }))
      .rejects.toMatchObject({ code: 'CLIENT_EDIT_SEQ_CONFLICT', current: { rev: 2 },
        originalEdit: { expectedRev: 1 }, previousReceipt: { commandId: first.commandId } });

    const leftEdit = edit('left', 2, 2, 'fifth', '左端保留稿');
    const rightEdit = edit('right', 3, 2, 'fourth', '右端保留稿');
    expect(await textbook.revise({ ...firstEdit, requestId: request('replayed-edit') }))
      .toMatchObject({ requestId: request('replayed-edit'), commandId: first.commandId, rev: 2 });
    const race = await Promise.allSettled([textbook.revise(leftEdit), textbook.revise(rightEdit)]);
    const loser = race.find(result => result.status === 'rejected');
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    if (loser?.status !== 'rejected') throw new Error('Concurrent revision did not conflict');
    expect(loser.reason).toBeInstanceOf(TextbookConflictError);
    expect(loser.reason).toMatchObject({ current: { rev: 3 }, originalEdit: { expectedRev: 2 } });

    expect(JSON.stringify(loser.reason.originalEdit.edits)).toMatch(/左端保留稿|右端保留稿/);
    expect(JSON.stringify(await textbook.get({ learner, id: created.id }))).toContain('第一端的新稿');

    expect(await textbook.openBlock({ learner, id: created.id, rev: 1, blockId: 'sixth', mode: 'following' }))
      .toMatchObject({ block: { id: 'sixth', parentId: 'fifth' }, siblingIndex: 0, ref: { rev: 3 } });
    expect(await textbook.openBlock({ learner, id: created.id, rev: 1, blockId: 'sixth' }))
      .toMatchObject({ ref: { rev: 1 }, block: { body: { kind: 'text', text: '六级' } } });

    const citation = await create('citation', '引用来源', [page('source', null, '来源正文')]);
    const linked = await create('linked', '引用页', [JSON.parse(JSON.stringify({ id: 'quote', parentId: null, body: { kind: 'reference', role: 'citation', target: { fact: { learner, id: citation.id, rev: 1 }, type: 'content.textbookPage', anchor: { kind: 'block', blockId: 'source' } } } })) as TextbookBlock]);
    const linkedView = await textbook.get({ learner, id: linked.id });
    expect(linkedView.kind === 'textbook' && linkedView.references[0]).toMatchObject({
      blockId: 'quote', ref: { id: citation.id, rev: 1 }, anchor: { blockId: 'source' },
    });
    await expect(textbook.get({ learner, id: linked.id, purpose: 'teaching' })).rejects.toMatchObject({ status: 403 });
    await expect(textbook.revise({ ...edit('denied', 4, 3, 'root', '不应写入'), purpose: 'teaching' }))
      .rejects.toMatchObject({ status: 403 });
    const { rows: doneCommands } = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM commands WHERE state='done'");
    expect(doneCommands[0]?.count).toBe(5);
    const patch = { ...edit('local-patch', 4, 3, 'sixth', ''), edits: [
      { kind: 'replace_anchor', blockId: 'sixth', anchor: '新稿', replacement: '修订' },
      { kind: 'insert_after', blockId: 'example', afterId: 'sixth', body: { kind: 'text', text: '例子' } },
    ] };
    expect(await textbook.revise(patch)).toMatchObject({ rev: 4 });
    expect(await textbook.openBlock({ learner, id: created.id, blockId: 'sixth' }))
      .toMatchObject({ block: { body: { text: '第一端的修订' } } });
    expect(await textbook.openBlock({ learner, id: created.id, blockId: 'example' }))
      .toMatchObject({ block: { parentId: 'fifth' }, siblingIndex: 1 });
    expect(await textbook.revise({ ...edit('delete-example', 5, 4, 'example', ''), edits: [
      { kind: 'delete_block', blockId: 'example' },
    ] })).toMatchObject({ rev: 5 });
    expect(await textbook.openBlock({ learner, id: created.id, rev: 4, blockId: 'example' }))
      .toMatchObject({ block: { id: 'example' } });

    const noteId = factId(stableId('legacy', 'note'));
    await createCommandHandler(db, { modules: [activity], hooks: { async onFactsChanged() {} } })({
      learner, actor: 'learner', purpose: 'storage', type: 'activity.organizerCreateNote',
      id: commandId(stableId('legacy', 'create')),
      input: { id: noteId, title: '旧笔记', markdown: '原正文', materialId: null },
    });
    expect(await textbook.get({ learner, id: noteId })).toMatchObject({ kind: 'legacyNote', readOnly: true,
      owner: organizerNoteType, id: noteId, rev: 1, purpose: ['storage'], markdown: '原正文' });
    expect((await textbook.list({ learner })).legacyNotes[0]).toMatchObject({ id: noteId, readOnly: true });
    await expect(textbook.revise({ ...edit('legacy-edit', 1, 1, 'anything', '不能迁移'), id: noteId }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('只能读取') });
    let url = '';
    const tbGen = openTextbook(db, content, { async onFactsChanged() {} }, undefined, undefined, { loadProvider: async () => ({
      baseUrl: url, model: 'm', protocol: 'openai', reasoningEffort: 'low', apiKey: '', activeProviderId: 'm',
      providers: [], mcpServers: [], exaApiKey: '', allowSearch: false }),
    authorTextbook: async c => ({ draft: { mode: 'full', title: `${c.topic}精讲`, summary: '摘要', tags: [], sourceIds: [], sections: [
      { heading: '直觉', kind: 'overview', body: '概念直觉说明。' },
      { heading: '例题', kind: 'example', body: '典型例题解析。' }] }, usage: { model: 'm', durationMs: 1 } }) });
    await expect(tbGen.generate({ learner, requestId: request('gen-404'), topic: '无' })).rejects.toMatchObject({ status: 404 });
    const pId = factId(stableId('tb-gen', 'p'));
    await createCommandHandler(db, { modules: [content], hooks: { async onFactsChanged() {} } })({ learner, actor: 'learner',
      purpose: 'teaching', id: commandId(stableId('tb-gen', 'p')), type: 'content.createTextbookPage',
      input: { id: pId, clientEditSeq: 0, purpose: ['storage', 'teaching'],
        page: { title: '极限基础', blocks: [page('b', null, 'lim 定义与邻域')] } } });
    await expect(tbGen.generate({ learner, requestId: request('gen-503'), topic: '极限' })).rejects.toMatchObject({ status: 503 });
    url = 'http://127.0.0.1:3425/v1';
    expect(await tbGen.generate({ learner, requestId: request('gen-201'), topic: '极限' })).toMatchObject({ title: '极限精讲' });
  }));
