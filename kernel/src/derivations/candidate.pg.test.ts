import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noteModule } from '../../test/commands/fixture.ts';
import { createCommandHandler, type CommandRequest } from '../commands/index.ts';
import { createPgDb } from '../db/pg.ts';
import type { Db } from '../db/types.ts';
import { defineCommand } from '../declarations/define.ts';
import { commandId, factId, learnerId, type Revision } from '../declarations/ids.ts';
import { applyKernelSchema } from '../schema.ts';
import { cancelWork, requestWork } from '../work/index.ts';
import { newUlid } from '../work/identity.ts';
import { sealCandidate, submitCandidate } from './candidate.ts';
import { gatherSnapshot } from './gather.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
const learner = learnerId('01KFS4AAA00000000000000000');
const fact = factId('01KFS4AAA00000000000000001');
const purpose = 'learn';
const slotType = 'note.score';
const request = { slotType, slotKey: 'one', deriver: 'note/score' };
const policy = { deriver: request.deriver, purpose, slot: { type: slotType } };
const changePurpose = defineCommand({
  type: 'note.purpose', destructive: true,
  schema: z.object({ rev: z.number().int().positive().transform(rev => rev as Revision), purpose: z.array(z.string()) }),
  write: (_ctx, input) => [{ kind: 'set_purpose', id: fact, expectedRev: input.rev, purpose: input.purpose }],
});

// These scenarios drive the command, gather, seal and acceptance entrypoints against one PostgreSQL ledger.
describe.skipIf(!connectionString)('Candidate transactions in PostgreSQL', () => {
  const schema = `candidate_${process.pid}`;
  let admin: Db;
  let db: Db;
  beforeEach(async () => {
    admin = createPgDb(new pg.Pool({ connectionString }));
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createPgDb(new pg.Pool({ connectionString }), { schema });
    await applyKernelSchema(db);
    await db.query('INSERT INTO learners(id) VALUES($1)', [learner]);
    await db.query("INSERT INTO slot_state(learner_id, slot_type, slot_key, scope_keys) VALUES ($1, $2, $3, '{}')", [learner, slotType, request.slotKey]);
  });
  afterEach(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });

  const register = () => db.tx({ learner }, tx => tx.withLearnerWrite(tick => requestWork(tx, tick, request)));
  const gather = (mode?: 'following' | 'pinned') => gatherSnapshot(db, { learner, purpose }, async ctx => ({
    kind: 'input', effects: [], data: mode ? (await ctx.read.fact(fact, mode === 'pinned' ? { mode, rev: 1 as Revision } : { mode })).value : null,
  }));
  const sealed = async (ref: Awaited<ReturnType<typeof register>>, mode?: 'following' | 'pinned') => {
    const result = await sealCandidate(db, ref, policy, await gather(mode));
    if (result.kind !== 'sealed') throw new Error(`Expected a seal, got ${result.kind}`);
    return result;
  };
  const value = { kind: 'value', value: 3 };
  const ledger = () => db.query('SELECT clock::text, current_id, last_id, changed_tick::text FROM learners JOIN slot_state ON id = learner_id');

  it.each([['S02: following after correction', 'following'], ['S15: pinned after purpose restoration', 'pinned']] as const)(
    '%s requires a fresh gather', async (_scenario, mode) => {
      const note = noteModule([purpose]);
      const commands = new Map(note.commands).set(changePurpose.type, changePurpose);
      const handle = createCommandHandler(db, { modules: [{ ...note, commands }], hooks: { onFactsChanged: async () => {} } });
      const command = (type: string, input: CommandRequest['input']) => handle({ learner, id: commandId(newUlid()), type, input, purpose, actor: 'learner' });
      await command('note.record', { id: fact, text: 'original' });
      const old = await register();
      const candidate = await sealed(old, mode);
      if (mode === 'following') await command('note.correct', { id: fact, text: 'corrected', rev: 1 });
      else {
        await command('note.purpose', { rev: 1, purpose: ['storage'] });
        await command('note.purpose', { rev: 2, purpose: [purpose] });
      }
      const hooks = { onSlotChanged: vi.fn() };
      const retry = await submitCandidate(db, old, policy, candidate.id, value, hooks);
      expect(retry).toMatchObject({ kind: 'retry', ref: { ...old, generation: '2' } });
      if (retry.kind !== 'retry') throw new Error('Expected a retry');
      expect((await ledger()).rows[0]).toMatchObject({ current_id: null, last_id: null });
      expect((await db.query('SELECT lifecycle, value, manifest FROM derivations WHERE id = $1', [candidate.id])).rows)
        .toEqual([{ lifecycle: 'rejected', value: null, manifest: candidate.manifest }]);
      expect((await db.query('SELECT generation::text, state FROM work_outbox WHERE work_id = $1 ORDER BY generation', [old.workId])).rows)
        .toEqual([{ generation: '1', state: 'pending' }, { generation: '2', state: 'pending' }]);
      expect(hooks.onSlotChanged).toHaveBeenCalledTimes(0);
      expect(await submitCandidate(db, old, policy, candidate.id, value, hooks)).toEqual({ kind: 'obsolete' });
      const fresh = await sealed(retry.ref, mode);
      expect(fresh.manifest.inputs).toEqual([{ kind: 'fact', id: fact, mode, ...(mode === 'pinned' ? { rev: 1, accessEpoch: '2' } : { rev: 2, accessEpoch: '0' }) }]);
      expect(await submitCandidate(db, retry.ref, policy, fresh.id, value, hooks)).toMatchObject({ kind: 'effective' });
    },
  );

  it('fences concurrent seals and submissions, and rolls the change hook back with selection', async () => {
    const first = await register();
    const [old, replay] = await Promise.all([sealed(first), sealed(first)]);
    expect(replay).toEqual(old);
    const hooks = { onSlotChanged: vi.fn() };
    await submitCandidate(db, first, policy, old.id, value, hooks);
    const second = await register();
    const next = await sealed(second);
    expect(await submitCandidate(db, second, policy, old.id, value, hooks)).toEqual({ kind: 'unbound' });
    const before = await ledger();
    await expect(submitCandidate(db, second, policy, next.id, value, { onSlotChanged: async () => { throw new Error('handoff failed'); } }))
      .rejects.toThrow('handoff failed');
    expect(await ledger()).toEqual(before);
    const submit = () => submitCandidate(db, second, policy, next.id, value, hooks);
    const results = await Promise.all([submit(), submit()]);
    expect(results.map(r => r.kind).sort()).toEqual(['effective', 'obsolete']);
    const effective = results.find(r => r.kind === 'effective')!;
    expect((await ledger()).rows).toEqual([{ clock: effective.tick, current_id: next.id, last_id: next.id, changed_tick: effective.tick }]);
    expect((await db.query('SELECT id, lifecycle, effective_tick::text, selection_ended_tick::text FROM derivations ORDER BY gather_tick')).rows)
      .toEqual([
        { id: old.id, lifecycle: 'superseded', effective_tick: '3', selection_ended_tick: effective.tick },
        { id: next.id, lifecycle: 'effective', effective_tick: effective.tick, selection_ended_tick: null },
      ]);
    expect(hooks.onSlotChanged).toHaveBeenCalledTimes(2);
    expect(hooks.onSlotChanged).toHaveBeenLastCalledWith(expect.objectContaining({ learner }), effective.tick,
      expect.objectContaining({ kind: 'effective', id: next.id, previousCurrent: old.id }));
  });

  it('clears a no-longer-valid selection before accepting a replacement', async () => {
    const note = noteModule([purpose]);
    const handle = createCommandHandler(db, { modules: [note], hooks: { onFactsChanged: async () => {} } });
    const command = (type: string, input: CommandRequest['input']) =>
      handle({ learner, id: commandId(newUlid()), type, input, purpose, actor: 'learner' });
    await command('note.record', { id: fact, text: 'old basis' });
    const first = await register();
    const old = await sealed(first, 'following');
    const hooks = { onSlotChanged: vi.fn() };
    await submitCandidate(db, first, policy, old.id, value, hooks);

    const next = await register();
    const replacement = await sealed(next);
    await command('note.correct', { id: fact, text: 'corrected basis', rev: 1 });
    const accept = vi.fn((ctx: { learner: string }) => {
      expect(ctx).toEqual({ learner });
      return { ok: true } as const;
    });
    const ruled = { ...policy, slot: { type: slotType, accept } };
    const result = await submitCandidate(db, next, ruled, replacement.id, value, hooks);
    expect(result).toMatchObject({ kind: 'retry', ref: { ...next, generation: '3' } });
    expect(accept).not.toHaveBeenCalled();
    expect((await ledger()).rows[0]).toMatchObject({ current_id: null, last_id: old.id });
    expect(hooks.onSlotChanged).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ kind: 'invalidated', id: old.id }));
    if (result.kind !== 'retry') throw new Error('Expected a retry');
    const fresh = await sealed(result.ref);
    expect(await submitCandidate(db, result.ref, ruled, fresh.id, value, hooks)).toMatchObject({ kind: 'effective' });
    expect(accept).toHaveBeenCalledOnce();
  });

  it('distinguishes a slot rule rejection, terminal failure and cancellation', async () => {
    const ref = await register();
    const candidate = await sealed(ref);
    const hooks = { onSlotChanged: vi.fn() };
    const ruled = { ...policy, slot: { type: slotType, accept: () => ({ ok: false, reason: 'below threshold' } as const) } };
    expect(await submitCandidate(db, ref, ruled, candidate.id, value, hooks)).toEqual({ kind: 'rejected', reason: 'below threshold' });
    expect((await db.query('SELECT state, pending, last_error, current_id FROM work JOIN slot_state USING (learner_id, slot_type, slot_key)')).rows)
      .toEqual([{ state: 'blocked', pending: 'none', last_error: { status: 'blocked', reason: 'below threshold' }, current_id: null }]);
    const failing = await register();
    const failed = await sealed(failing);
    const terminal = { kind: 'failed', reason: 'deriver failed' };
    expect(await submitCandidate(db, failing, policy, failed.id, terminal, hooks)).toEqual(terminal);
    expect((await db.query('SELECT lifecycle, value FROM derivations WHERE id = $1', [failed.id])).rows)
      .toEqual([{ lifecycle: 'failed', value: null }]);
    const next = await register();
    const cancelled = await sealed(next);
    expect(await cancelWork(db, next)).toBe(true);
    expect(await submitCandidate(db, next, policy, cancelled.id, value, hooks)).toEqual({ kind: 'obsolete' });
    expect(hooks.onSlotChanged).toHaveBeenCalledTimes(2);
  });
});
