import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { kernelSchemaStatements } from '../../../kernel/src/schema.ts';
import { commandId, factId, learnerId } from '../../../kernel/src/declarations/ids.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { fileURLToPath } from 'node:url';
import type { TextbookBlock } from '../../../modules/content/textbook-page.ts';
import { organizerNoteType } from '../../../modules/activity/organizer-values.ts';
import { stableId } from '../identity.ts';
import { openTextbook, TextbookConflictError } from '../textbook.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
const learner = learnerId(stableId('textbook', 'learner'));

it.skipIf(!connectionString)('serves nested pages, retains conflicting edits, and scopes reference access', async () => {
  const schema = 'textbook_' + randomBytes(6).toString('hex');
  const admin = createPgDb(new pg.Pool({ connectionString }));
  await admin.query('CREATE SCHEMA ' + schema);
  const db = createPgDb(new pg.Pool({ connectionString }), { schema });
  const content = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/content', import.meta.url)));
  const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity', import.meta.url)));
  const textbook = openTextbook(db, content, { async onFactsChanged() {} });
  const request = (name: string) => stableId('textbook-request', name);
  const page = (id: string, parentId: string | null, value: string): TextbookBlock => ({ id, parentId, body: { kind: 'text', text: value } });
  const create = (name: string, title: string, content: TextbookBlock[]) => textbook.create({ learner, requestId: request(name), clientEditSeq: 0, page: { title, blocks: content } });
  try {
    for (const sql of kernelSchemaStatements) await db.query(sql);
    await db.query('INSERT INTO learners (id) VALUES ($1)', [learner]);
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
  } finally {
    await db.close();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.close();
  }
});
