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
import {
  notionRevisionDiff, notionSourceRecipient, prepareNotionIngest, prepareNotionRevision,
  refreshNotionSourceCommand, revokeNotionSourceCommand, setNotionPurposeCommand, type NotionSelection,
} from './notion-source.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const time = '2026-11-20T01:00:00.000Z';
const selection = { learner, id: 'chemistry', root: { kind: 'page', id: uuid(1) }, preset: 'learning' } satisfies NotionSelection;
const todo = (n: number, checked = false, parentId: string | null = null) => ({
  id: uuid(n), parentId, text: `任务 ${n}`, body: { type: 'to_do', data: { checked } },
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
