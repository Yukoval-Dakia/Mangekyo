import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {recordLocalRead} from './effects.ts';
import { createPgDb } from '../db/pg.ts';
import type { Db, DbTransaction } from '../db/types.ts';
import { factId, learnerId } from '../declarations/ids.ts';
import type { Json, Outcome } from '../declarations/types.ts';
import { gatherSnapshot } from '../derivations/gather.ts';
import { applyKernelSchema, kernelSchemaStatements, workerStorage } from '../schema.ts';
import { newUlid } from './identity.ts';
import {
  checkTodoTriggers, completeTodo, emitTodo, maxTodoHops, newFactWatermark, readTodo, updateOrCancelTodo, type TodoInput,
} from './todos.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, registerWorkWait, relayPending, requestWork, runEffect, wakeWaitingWork,
  type WorkRef,
} from './index.ts';

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

  const slot = (key: string) => ({ learner, type: 'test.grade', key });
  const scope = { knowledgePoint: 'K' };
  async function addSlot(key: string, eligible = false) {
    await db.query(
      "INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, evidence_eligible) VALUES ($1, 'test.grade', $2, $3, $4)",
      [learner, key, JSON.stringify(scope), eligible],
    );
  }
  const request = (slotKey: string) => db.tx({ learner }, tx =>
    tx.withLearnerWrite(tick => requestWork(tx, tick, { slotType: 'test.grade', slotKey, deriver: 'derive' })));
  const gatherRange = () => gatherSnapshot(db, { learner, purpose: 'study' }, async ctx => {
    const range = await ctx.read.range('test.grade', scope);
    return { kind: 'input', data: range.members.map(member => member.outcome), effects: [] };
  });
  const register = (ref: WorkRef, snapshot: Awaited<ReturnType<typeof gatherRange>>) =>
    db.tx({ learner }, tx => registerWorkWait(tx, ref, snapshot.waits));

  function publish(tx: DbTransaction, key: string, outcome: Outcome<Json>) {
    return tx.withLearnerWrite(async tick => {
      const id = newUlid();
      await tx.insert('derivations', {
        id, learner_id: learner, slot_type: 'test.grade', slot_key: key, deriver: 'derive',
        lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick,
        manifest: JSON.stringify({ version: 1, learner, purpose: 'study', gatherTick: tick, inputs: [] }),
        scope_keys: JSON.stringify(scope), value: JSON.stringify(outcome),
      });
      await tx.query(
        "UPDATE slot_state SET current_id = $3, last_id = $3, changed_tick = $4 WHERE learner_id = $1 AND slot_type = 'test.grade' AND slot_key = $2",
        [learner, key, id, tick],
      );
      return wakeWaitingWork(tx, tick, slot(key));
    });
  }

  async function race(first: (tx: DbTransaction) => Promise<unknown>, second: () => Promise<unknown>) {
    const entered = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const held = db.tx({ learner }, async tx => {
      const result = await first(tx);
      const { rows: [row] } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      entered.resolve(row!.pid);
      await release.promise;
      return result;
    });
    void held.catch(entered.reject);
    let contender: Promise<unknown> | undefined;
    try {
      const pid = await entered.promise;
      contender = second();
      await vi.waitFor(async () => {
        const { rows: [row] } = await admin.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
          [pid],
        );
        expect(row?.blocked).toBe(true);
      });
    } finally {
      release.resolve();
      await Promise.all([held, contender]);
    }
  }

  it.each(['wait first', 'target first'])('resumes strict range demand with concurrent writes (%s)', async order => {
    await applyKernelSchema(db);
    await addSlot('grade', true);
    await addSlot('unknown', true);
    await addSlot('summary');
    const unknown = { kind: 'unknown', reason: 'grading evidence inconclusive' } as const;
    await db.tx({ learner }, tx => publish(tx, 'grade', { kind: 'value', value: 2 }));
    await db.tx({ learner }, tx => publish(tx, 'unknown', unknown));
    await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      await tx.query(
        "UPDATE derivations SET lifecycle = 'stale', invalidated_tick = $2 WHERE learner_id = $1 AND slot_key = 'grade'",
        [learner, tick],
      );
      await tx.query(
        "UPDATE slot_state SET current_id = NULL, changed_tick = $2 WHERE learner_id = $1 AND slot_key = 'grade'",
        [learner, tick],
      );
    }));
    const ref = await request('summary');
    const snapshot = await gatherRange();
    expect(snapshot.plan.kind).toBe('waiting');
    expect(snapshot.waits).toEqual([{ ref: slot('grade'), changedTick: '3' }]);

    const wait = (tx: DbTransaction) => registerWorkWait(tx, ref, snapshot.waits);
    const grade = { kind: 'value', value: 6 } as const;
    const accept = (tx: DbTransaction) => publish(tx, 'grade', grade);
    if (order === 'wait first') await race(wait, () => db.tx({ learner }, accept));
    else await race(accept, () => db.tx({ learner }, wait));

    const restart = { ...ref, generation: '2' };
    const starts: WorkRef[] = [];
    expect(await relayPending(db, async next => { starts.push(next); })).toBe(1);
    expect(starts).toEqual([restart]);
    expect((await db.query('SELECT clock::text FROM learners WHERE id = $1', [learner])).rows).toEqual([{ clock: '5' }]);
    expect((await db.query('SELECT work_id FROM work_waits WHERE learner_id = $1', [learner])).rows).toEqual([]);
    expect((await gatherRange()).plan).toEqual({ kind: 'input', data: [grade, unknown], effects: [] });
    expect(await finishWork(db, ref)).toBe(false);
    expect(await finishWork(db, restart)).toBe(true);
    expect(await register(restart, snapshot)).toEqual({ kind: 'obsolete' });
    await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      expect(await wakeWaitingWork(tx, tick, slot('grade'))).toEqual([]);
    }));
    expect(await relayPending(db, async () => {})).toBe(0);
  });

  it.each(['blocked', 'unavailable', 'denied', 'stale'])('reconciles %s on either side of registration', async status => {
    await applyKernelSchema(db);
    await addSlot('grade', true);
    await addSlot('before');
    await addSlot('after');
    const before = await request('before');
    const after = await request('after');
    const snapshot = await gatherRange();
    expect(await register(before, snapshot)).toEqual({ kind: 'waiting' });
    expect((await db.query('SELECT observed_change_tick::text AS tick FROM work_waits WHERE learner_id = $1', [learner])).rows).toEqual([{ tick: '0' }]);
    const expected = (ref: WorkRef) => status === 'stale'
      ? { kind: 'ready', ref: { ...ref, generation: '2' } }
      : { kind: status, ref };
    if (status === 'blocked') {
      expect(await failWork(db, await request('grade'), async (tx, tick) => {
        expect(await wakeWaitingWork(tx, tick, slot('grade'))).toEqual([expected(before)]);
      })).toBe(true);
    } else {
      await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
        await tx.query(
          "UPDATE slot_state SET last_error = $2, changed_tick = $3 WHERE learner_id = $1 AND slot_type = 'test.grade' AND slot_key = 'grade'",
          [learner, JSON.stringify({ status }), tick],
        );
        expect(await wakeWaitingWork(tx, tick, slot('grade'))).toEqual([expected(before)]);
      }));
    }
    expect(await register(after, snapshot)).toEqual(expected(after));
    const state = status === 'stale' ? 'ready' : status;
    expect((await db.query('SELECT DISTINCT state FROM work WHERE learner_id = $1', [learner])).rows).toEqual([{ state }]);
    expect((await db.query('SELECT work_id FROM work_waits WHERE learner_id = $1', [learner])).rows).toEqual([]);
    expect(await relayPending(db, async () => {})).toBe(status === 'stale' ? 2 : 0);
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
    expect((await db.query('SELECT version FROM kernel_schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }]);
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
    await db.query('INSERT INTO kernel_schema_migrations (version) VALUES (9)');
    expect(await workerStorage(db)).toBe(store);
    await db.query('UPDATE kernel_runtime_identity SET minimum_worker_schema = 9');
    await expect(workerStorage(db)).rejects.toThrow('incompatible');
  });

  it('dispatches scheduled and enumerated completion Todos through the same deduped outbox', async () => {
    await applyKernelSchema(db);
    const source = { id: newUlid(), revision: 1, accessEpoch: '0' };
    const spec: TodoInput = { dedupKey: 'scheduled', goal: 'Prepare review', workerProfile: 'deterministic_compute',
      trigger: { kind: 'scheduled', fireAtMs: 5 }, refs: [], sourceFactRev: source, autonomyTier: 1,
      budgetCap: 0, settingsRevision: 1, expiresAtMs: 50 };
    const eligible = vi.fn(async () => true);
    const emit = (intent: TodoInput) => db.tx({ learner }, tx => tx.withLearnerWrite(tick => emitTodo(tx, tick, intent, 1, eligible)));
    const inspect = (id: string) => db.snapshot({ learner }, tx => readTodo(tx, id));
    const sweep = (now: number) => db.tx({ learner }, tx => checkTodoTriggers(tx, now, eligible));
    const root = (await emit(spec))!;
    expect((await emit(spec))?.id).toBe(root.id);
    const edit = (todo: { id: string; revision: number }, change: Parameters<typeof updateOrCancelTodo>[4]) =>
      db.tx({ learner }, tx => tx.withLearnerWrite(tick => updateOrCancelTodo(tx, tick, todo.id, todo.revision, change, 1, eligible)));
    expect(await edit(root, { kind: 'update', patch: { trigger: { kind: 'scheduled', fireAtMs: 8 } } })).toBe(true);
    expect(await edit(root, { kind: 'cancel' })).toBe(false);
    const followup = (parent: string, hop: number) => emit({ ...spec, dedupKey: 'followup:' + hop,
      trigger: { kind: 'event', event: { type: 'on_work_completed', subject: parent } } });
    const next = (await followup(root.id, 1))!;
    expect(await sweep(5)).toEqual({ advanced: false, nextAt: 8 });
    expect(eligible).not.toHaveBeenCalled();
    expect(await sweep(8)).toMatchObject({ advanced: true });
    expect((await inspect(next.id))?.state).toBe('pending');
    const dispatched = (await inspect(root.id))!;
    const ref = { learner, workId: root.id, generation: '1' };
    await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      expect(await completeTodo(tx, tick, { ...ref, generation: '2' }, dispatched, source.id)).toBe(false);
      expect(await completeTodo(tx, tick, { ...ref, learner: newUlid() }, dispatched, source.id)).toBe(false);
      expect(await completeTodo(tx, tick, ref, { ...dispatched, learner: newUlid() }, source.id)).toBe(false);
      expect(await completeTodo(tx, tick, ref, dispatched, source.id)).toBe(true);
    }));
    expect(await edit(next, { kind: 'update', patch: { expiresAtMs: 60 } })).toBe(true);
    expect(await sweep(8)).toMatchObject({ advanced: true });
    expect(await inspect(next.id)).toMatchObject({ state: 'dispatched', chainId: root.id, hopCount: 1 });
    expect(await sweep(8)).toMatchObject({ advanced: false });
    expect((await db.query('SELECT intent_id FROM work_outbox')).rowCount).toBe(2);
    expect(await db.snapshot({ learner }, newFactWatermark)).toBeNull();
    let tail = next;
    for (let hop = 2; hop <= maxTodoHops; hop++) tail = (await followup(tail.id, hop))!;
    expect(tail.hopCount).toBe(maxTodoHops);
    expect(await followup(tail.id, maxTodoHops + 1)).toBeNull();
    expect(await db.tx({ learner }, tx => tx.withLearnerWrite(tick =>
      updateOrCancelTodo(tx, tick, tail.id, tail.revision, { kind: 'cancel' }, 8, eligible)))).toBe(true);
    expect((await inspect(tail.id))?.state).toBe('cancelled');
  });

  it('keeps v6 SQL on the same work row while old pinned workers drain', async () => {
    await applyKernelSchema(db);
    const id = newUlid();
    const source = { id: newUlid(), revision: 1, accessEpoch: '0' };
    const spec: TodoInput = { dedupKey: 'legacy', goal: 'Review', trigger: { kind: 'immediate' },
      workerProfile: 'deterministic_compute', budgetCap: 0, refs: [], sourceFactRev: source,
      autonomyTier: 1, settingsRevision: 1, expiresAtMs: 50 };
    await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      await tx.insert('working_todos', { learner_id: learner, todo_id: id, dedup_key: spec.dedupKey,
        spec: JSON.stringify(spec), state: 'pending', chain_id: id, hop_count: 0, registered_tick: tick });
      await tx.query("UPDATE working_todos SET state='dispatched',revision=revision+1 WHERE todo_id=$1 AND revision=1", [id]);
      // V6 requestWork reuses a ready generation with matching tick and worker.
      const current = (await tx.query("SELECT FROM work WHERE learner_id=$1 AND slot_key=$2 AND state='ready' AND requested_tick=$3 AND deriver=$4",
        [learner, id, tick, spec.workerProfile])).rowCount;
      expect(current).toBe(1);
    }));
    const [row] = (await db.query<{ intent_id: string }>('SELECT intent_id FROM work_outbox')).rows;
    const ref = await acknowledgeStartedWork(db, row!.intent_id);
    expect(ref).toBeTruthy();
    await db.tx({ learner }, tx => tx.withLearnerWrite(async () => {
      await tx.query("UPDATE work SET state='blocked' WHERE learner_id=$1 AND id=$2 AND generation=$3",
        [learner, ref!.workId, ref!.generation]);
    }));
    expect((await db.query("SELECT state,revision FROM working_todos WHERE todo_id=$1", [id])).rows)
      .toEqual([{ state: 'failed', revision: 3 }]);
    expect((await db.query("SELECT relkind FROM pg_class WHERE oid='working_todos'::regclass")).rows)
      .toEqual([{ relkind: 'v' }]);
  });

  it('prioritizes admitted todos and fences cancellation after a durable start', async () => {
    await applyKernelSchema(db);
    const source = { id: newUlid(), revision: 1, accessEpoch: '0' };
    const emit = (dedupKey: string, priority: 0 | 1, budgetCap: number) =>
      db.tx({ learner }, tx => tx.withLearnerWrite(tick => emitTodo(tx, tick, {
        dedupKey, priority, budgetCap, goal: 'Review', trigger: { kind: 'immediate' },
        workerProfile: 'deterministic_compute', refs: [], sourceFactRev: source, autonomyTier: 1,
        settingsRevision: 1, expiresAtMs: 50,
      }, 1, async spec => spec.budgetCap === 0)));
    const maintenance = (await emit('warm', 1, 0))!;
    const foreground = (await emit('hot', 0, 0))!;
    expect((await emit('over-budget', 1, 5))?.state).toBe('cancelled');
    const starts: string[] = [];
    await relayPending(db, async (ref, intent) => {
      expect(await acknowledgeStartedWork(db, intent)).toEqual(ref);
      starts.push(ref.workId);
    });
    expect(starts).toEqual([foreground.id, maintenance.id]);
    const cancel = await db.tx({ learner }, tx => tx.withLearnerWrite(tick =>
      updateOrCancelTodo(tx, tick, foreground.id, foreground.revision, { kind: 'cancel' }, 2, async () => true)));
    expect(cancel).toBe(true);
    expect(await db.tx({ learner }, tx => tx.withLearnerWrite(tick => completeTodo(tx, tick, { learner, workId: foreground.id, generation: '1' }, foreground, source.id)))).toBe(false);
    expect(await relayPending(db, async () => {})).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM work_outbox")).rows).toEqual([{ count: 2 }]);
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

  it('replays one authorized local snapshot and rolls back a failed read', async () => {
    await applyKernelSchema(db);
    const step = {learner, ownerKind:'session' as const, ownerId:'turn', stepKey:'1', label:'local:search', input:{query:'old'}};
    const allow = async () => {};
    await expect(recordLocalRead(db, step, async () => {throw new Error('interrupted');}, allow)).rejects.toThrow('interrupted');
    const read = vi.fn(async () => 'original');
    const results = await Promise.all([recordLocalRead(db, step, read, allow), recordLocalRead(db, step, read, allow)]);
    expect(results).toEqual(['original','original']);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(recordLocalRead(db,step,read,async () => {throw new Error('revoked');})).rejects.toThrow('revoked');
    await expect(recordLocalRead(db,{...step,input:{query:'new'}},read,allow)).rejects.toThrow('does not match');
  });
  it('settles a fact-scoped reservation across another erasure and blocks revoked replay', async () => {
    await applyKernelSchema(db);
    const id = factId(newUlid());
    await db.tx({learner}, tx => tx.withLearnerWrite(async tick => {
      await tx.insert('facts', {learner_id:learner,id,type:'test.answer',current_rev:1,created_tick:tick,changed_tick:tick});
      await tx.insert('fact_revs', {learner_id:learner,fact_id:id,rev:1,data:'{}',kind:'value',purpose:['storage'],
        sticky:false,author:'learner',command_id:'fixture',tick});
    }));
    const {manifest} = await gatherSnapshot(db, {learner,purpose:'storage'}, async ({read}) => {
      await read.fact(id, {mode:'following'});
      return {kind:'input',data:null,effects:[]};
    });
    const request = {learner,ownerKind:'session' as const,ownerId:id,stepKey:'grade',label:'model',input:{}};
    const send = vi.fn(async () => {
      await db.tx({learner}, tx => tx.withLearnerWrite(tick => tx.insert('erasure_requests', {
        learner_id:learner,request_id:'fixture',root_id:'unrelated',expected_rev:1,generation:tick,
      })));
      return 'scored';
    });
    expect(await runEffect(db,request,send,undefined,{manifest})).toEqual({kind:'done',result:'scored'});
    await db.query('UPDATE facts SET access_epoch=access_epoch+1 WHERE learner_id=$1 AND id=$2',[learner,id]);
    await expect(runEffect(db,request,send)).rejects.toThrow('Effect inputs no longer authorized');
    await expect(db.query("UPDATE effects SET result='42' WHERE learner_id=$1 AND owner_id=$2",[learner,id]))
      .rejects.toMatchObject({code:'55000'});
    expect(send).toHaveBeenCalledTimes(1);
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
