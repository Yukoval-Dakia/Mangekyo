import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { commandId, learnerId, type Json, type Revision } from '@mangekyo/kernel';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader } from '../../kernel/src/commands/reads.ts';
import { createPgliteDb } from '../../kernel/src/db/pglite.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { applyKernelSchema } from '../../kernel/src/schema.ts';
import { captureSourceCommand, sourceEnvelope } from './source.ts';
import { notionReadPage, notionReadRows } from './notion-api.ts';
import {
  notionRevisionDiff, notionSourceInvalidation, notionSourceRecipient, openNotionBoundedSnapshot, prepareNotionBoundedSnapshot,
  prepareNotionIngest, prepareNotionRevision, refreshNotionSourceCommand, revokeNotionSourceCommand,
  setNotionPurposeCommand, type NotionBoundedUse, type NotionSelection,
} from './notion-source.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const time = '2026-11-20T01:00:00.000Z';
const selection = { learner, id: 'chemistry', root: { kind: 'page', id: uuid(1) }, preset: 'learning' } satisfies NotionSelection;
const todo = (n: number, checked = false, parentId: string | null = null) => ({
  id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
});

it('binds bounded snapshots to the approved turn, recipient, source generation and expiry', async () => {
  const grant = { preset: 'temporary', selection: { learner, selectionId: selection.id, selectionEpoch: '4', root: selection.root },
    pageId: selection.root.id, conversationId: 'chat', turnId: 'turn', authorizationEpoch: '2',
    recipient: { purpose: 'turn-tool', id: 'tool-call-8' },
    authorizedAt: time, expiresAt: '2026-11-21T01:00:00.000Z' } satisfies NotionBoundedUse;
  for (const preset of ['turn-only', 'temporary'] as const) {
    const use = { ...grant, preset };
    const snapshot = await prepareNotionBoundedSnapshot(use, use, first, time);
    const projection = openNotionBoundedSnapshot(snapshot, use, time);
    expect(projection.blocks[0]).toEqual({ id: uuid(2), parentId: null, text: '任务 2' });
    for (const denied of [null, { ...use, turnId: 'next-turn' }, { ...use, conversationId: 'other-chat' },
      { ...use, recipient: { ...use.recipient, id: 'other-tool' } }, { ...use, recipient: { purpose: 'turn-answer' as const, id: use.recipient.id } },
      { ...use, authorizationEpoch: '3' }, { ...use, selection: { ...use.selection, selectionEpoch: '5' } },
      { ...use, expiresAt: '2026-11-21T02:00:00.000Z' }]) {
      expect(() => openNotionBoundedSnapshot(snapshot, denied, time)).toThrow('本轮授权无效');
    }
    expect(() => openNotionBoundedSnapshot(snapshot, use, use.expiresAt)).toThrow('本轮授权无效');
    await expect(prepareNotionBoundedSnapshot(use, use, { ...first, pageId: uuid(9) }, time)).rejects.toThrow('页面授权不匹配');
  }
  const oversized = { ...grant, expiresAt: '2026-11-21T01:00:00.001Z' };
  await expect(prepareNotionBoundedSnapshot(oversized, oversized, first, time)).rejects.toThrow('本轮授权无效');
});

it('notifies the host of remote invalidation only at the observed scope and generation', async () => {
  const witness = { learner, selectionId: selection.id, selectionEpoch: '4' };
  const root = { kind: 'data-source', id: uuid(8) } as const;
  const rows = notionReadRows(root);
  rows.next();
  expect(() => rows.next({ status: 403, body: null })).toThrow(expect.objectContaining({ invalidated: { kind: 'selection' } }));
  const moved = notionReadPage(root, uuid(1));
  await moved.next();
  const movedError = await moved.next({ status: 200, body: { object: 'page', id: uuid(1),
    parent: { type: 'data_source_id', data_source_id: uuid(9) } } }).catch(error => error);
  expect(notionSourceInvalidation(movedError, witness)).toEqual({ selection: witness, target: { kind: 'page', pageId: uuid(1) } });
  const blocks = notionReadPage(selection.root, uuid(1));
  await blocks.next();
  await blocks.next({ status: 200, body: { object: 'page', id: uuid(1), properties: {}, last_edited_time: time } });
  const missingBlockError = await blocks.next({ status: 404, body: null }).catch(error => error);
  expect(notionSourceInvalidation(missingBlockError, witness)).toBeNull();
});
const first = { pageId: selection.root.id, title: '滴定', lastEditedTime: time,
  blocks: [todo(2), todo(3), todo(4, false, uuid(3)), todo(5), todo(7)] };
const next = { ...first, blocks: [todo(7), todo(2, true), todo(3), todo(4), todo(6)] };

it('loads the capture commands and revises one original with pinned durable semantics and revocable access', { timeout: 20_000 }, async () => {
  const requireKernel = createRequire(new URL('../../kernel/package.json', import.meta.url));
  const { PGlite } = requireKernel('@electric-sql/pglite') as { PGlite: new () => Parameters<typeof createPgliteDb>[0] };
  const db = createPgliteDb(new PGlite());
  try {
    await applyKernelSchema(db);
    await db.query('INSERT INTO learners(id) VALUES($1)', [learner]);
    const capture = await loadModuleDirectory(fileURLToPath(new URL('.', import.meta.url)));
    const module = await loadModuleDirectory(fileURLToPath(new URL('../content', import.meta.url)));
    const changes: string[] = [];
    const handle = createCommandHandler(db, { modules: [capture, module], hooks: {
      onFactsChanged: async (_tx, _tick, writes) => { changes.push(...writes.map(write => write.kind)); },
    } });
    let sequence = 0;
    const run = (type: string, input: Json, actor: 'companion' | 'learner' = 'companion') => handle({
      learner, id: commandId(`01KFS4AAA${String(++sequence).padStart(17, '0')}`),
      type, input, actor, purpose: 'storage',
    });
    const ingest = await prepareNotionIngest(selection, first, time);
    const target = { id: ingest.id, expectedRev: 1, accessEpoch: '0', selectionId: selection.id };
    const open = (rev: number, selected: NotionSelection | null = selection, purpose = 'teaching') =>
      db.snapshot({ learner }, tx => createAuthorizedFactReader(tx, purpose,
        notionSourceRecipient(selected, purpose, purpose === 'storage' ? 'learner' : 'workspace'))
        .fact(ingest.id, { mode: 'pinned', rev: rev as Revision }));
    expect((await run(captureSourceCommand, ingest)).wrote).toEqual([{ learner, id: ingest.id, rev: 1 }]);
    const envelope = await prepareNotionRevision(selection, next, '2026-11-20T01:01:00.000Z');
    expect(notionRevisionDiff(sourceEnvelope((await open(1)).value), sourceEnvelope(envelope))).toEqual({
      added: [uuid(6)], removed: [uuid(5)], edited: [uuid(2)], moved: [uuid(7), uuid(4)],
    });
    expect((await run(refreshNotionSourceCommand, { ...target, envelope })).wrote[0]?.rev).toBe(2);
    const before = sourceEnvelope((await open(1)).value);
    const after = sourceEnvelope((await open(2)).value);
    expect(before.unit.blocks.find(block => block.id === uuid(2))?.body).toMatchObject({ notionBody: { data: { checked: false } } });
    expect(after.unit.blocks.find(block => block.id === uuid(2))?.body).toMatchObject({ notionBody: { data: { checked: true } } });
    expect((await run(refreshNotionSourceCommand, { ...target, expectedRev: 2, envelope })).wrote).toEqual([]);
    await expect(run(refreshNotionSourceCommand, { ...target, envelope })).rejects.toThrow('版本或授权已变更');
    await expect(open(2, null)).rejects.toMatchObject({ reason: 'recipient' });
    await expect(open(2, { ...selection, id: 'different-selection' })).rejects.toMatchObject({ reason: 'recipient' });
    expect((await run(setNotionPurposeCommand, { ...target, expectedRev: 2, preset: 'storage' }, 'learner')).wrote[0]?.rev).toBe(3);
    await expect(open(2)).rejects.toMatchObject({ reason: 'purpose' });
    const final = await open(3, { ...selection, preset: 'storage' }, 'storage');
    expect(final.accessEpoch).toBe('1');
    expect((await run(revokeNotionSourceCommand, { ...target, expectedRev: 3, accessEpoch: '1' }, 'learner')).wrote[0]?.rev).toBe(4);
    await expect(open(1, selection, 'storage')).rejects.toMatchObject({ reason: 'retracted' });
    await expect(prepareNotionIngest({ ...selection, preset: 'turn-only' }, first, time)).rejects.toThrow('不能保存');
    await expect(prepareNotionIngest({ ...selection, preset: 'temporary' }, first, time)).rejects.toThrow('不能保存');
    expect(changes).toEqual(['create', 'revise', 'set_purpose', 'retract']);
  } finally {
    await db.close();
  }
});
