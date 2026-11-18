import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgDb } from '../db/pg.ts';
import type { Db } from '../db/types.ts';
import { learnerId } from '../declarations/ids.ts';
import { applyKernelSchema, kernelSchemaStatements, workerStorage } from '../schema.ts';
import { acknowledgeStartedWork, cancelWork, finishWork, relayPending, requestWork, runEffect } from './index.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
describe.skipIf(!connectionString)('Durable work in PostgreSQL', () => {
  const learner = learnerId('01KFS4AAA00000000000000000');
  const schema = `durable_work_${process.pid}`;
  let admin: Db;
  let db: Db;
  beforeEach(async () => {
    admin = createPgDb(new pg.Pool({ connectionString }));
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createPgDb(new pg.Pool({ connectionString }), { schema });
    for (const statement of kernelSchemaStatements) await db.query(statement);
    await db.query('INSERT INTO learners (id) VALUES ($1)', [learner]);
  });
  afterEach(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });

  it('rolls back a failed migration and serializes concurrent migration of legacy work', async () => {
    await db.query(`INSERT INTO slot_state (learner_id, slot_type, slot_key, pending, scope_keys)
      VALUES ($1, 'slot', 'a', 'running', '{}'), ($1, 'slot', 'b', 'waiting', '{}')`, [learner]);
    await db.query(`INSERT INTO work (learner_id, id, slot_type, slot_key, deriver, state, gather, token)
      VALUES ($1, 'a', 'slot', 'a', 'derive', 'running', '{}', 'old'), ($1, 'b', 'slot', 'b', 'derive', 'waiting', NULL, NULL)`, [learner]);
    await db.query("INSERT INTO work_waits VALUES ($1, 'b', 'slot', 'a', 7)", [learner]);
    await db.query('CREATE TABLE work_outbox (blocker int)');
    await expect(applyKernelSchema(db)).rejects.toThrow();
    expect((await db.query('SELECT token FROM work ORDER BY id')).rows).toEqual([{ token: 'old' }, { token: null }]);
    await db.query('DROP TABLE work_outbox');

    await Promise.all([applyKernelSchema(db), applyKernelSchema(db), applyKernelSchema(db)]);
    expect((await db.query('SELECT version FROM kernel_schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect((await db.query('SELECT id, state, gather FROM work ORDER BY id')).rows).toEqual([
      { id: 'a', state: 'ready', gather: null }, { id: 'b', state: 'waiting', gather: null },
    ]);
    expect((await db.query('SELECT observed_change_tick::text FROM work_waits')).rows).toEqual([{ observed_change_tick: '7' }]);
    expect((await db.query('SELECT work_id, generation::text, state FROM work_outbox')).rows).toEqual([
      { work_id: 'a', generation: '1', state: 'pending' },
    ]);
    expect(await cancelWork(db, { learner, workId: 'b', generation: '1' })).toBe(true);
    expect((await db.query('SELECT work_id FROM work_waits')).rows).toEqual([]);
    expect((await db.query("SELECT pending FROM slot_state WHERE slot_key = 'b'")).rows).toEqual([{ pending: 'none' }]);
    const store = await workerStorage(db);
    await db.query('INSERT INTO kernel_schema_migrations (version) VALUES (5)');
    expect(await workerStorage(db)).toBe(store);
    await db.query('UPDATE kernel_runtime_identity SET minimum_worker_schema = 5');
    await expect(workerStorage(db)).rejects.toThrow('incompatible');
  });

  it('registers transactionally, retries the same handoff and fences late and competing completions', async () => {
    await applyKernelSchema(db);
    await db.query("INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys) VALUES ($1, 'slot', 'private body', '{}')", [learner]);
    const request = { slotType: 'slot', slotKey: 'private body', deriver: 'derive' };
    const register = () => db.tx({ learner }, tx => tx.withLearnerWrite(tick => requestWork(tx, tick, request)));
    await expect(db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      await requestWork(tx, tick, request);
      throw new Error('rollback');
    }))).rejects.toThrow('rollback');
    const start = vi.fn(async () => {});
    expect(await relayPending(db, start)).toBe(0);
    const old = await register();
    start.mockRejectedValueOnce(new Error('start acknowledgement lost'));
    await expect(relayPending(db, start)).rejects.toThrow();
    expect(await relayPending(db, start)).toBe(1);
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
    const current = await register();
    const accept = vi.fn(async () => {});
    expect(await finishWork(db, old, accept)).toBe(false);
    await expect(relayPending(db, async (_ref, executionRef) => {
      expect(await acknowledgeStartedWork(db, executionRef)).toEqual(current);
      expect((await Promise.all([finishWork(db, current, accept), finishWork(db, current, accept)])).sort()).toEqual([false, true]);
      throw new Error('response lost after Activity');
    })).rejects.toMatchObject({ errors: [{ message: 'response lost after Activity' }] });
    expect(await relayPending(db, start)).toBe(0);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('authorizes effect reservations and replays while reusing the durable outcome', async () => {
    await applyKernelSchema(db);
    const request = { learner, ownerKind: 'session', ownerId: 'session', stepKey: 'answer', label: 'model', input: {} } as const;
    const entered = Promise.withResolvers<string>();
    const complete = Promise.withResolvers<string>();
    const invoke = vi.fn(async (id: string) => { entered.resolve(id); return complete.promise; });
    const deny = () => { throw new Error('denied'); };
    await expect(runEffect(db, request, invoke, deny)).rejects.toThrow('denied');
    const running = runEffect(db, request, invoke);
    const providerEffectId = await entered.promise;
    expect(await runEffect(db, request, invoke)).toEqual({ kind: 'unknown', providerEffectId });
    complete.resolve('answer');
    expect(await running).toEqual({ kind: 'done', result: 'answer' });
    expect(await runEffect(db, request, invoke)).toEqual({ kind: 'done', result: 'answer' });
    await expect(runEffect(db, request, invoke, deny)).rejects.toThrow('denied');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
