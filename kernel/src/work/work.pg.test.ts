import { testDatabaseUrl, withLearnerDatabase } from '../../test/learner-database.ts';
import { aroundEach, describe, expect, it, vi } from 'vitest';
import { effectBudgetUsage, EffectBudgetExceeded, EffectIdentityMismatch, recordLocalRead } from './effects.ts';
import type { Db, DbTransaction } from '../db/types.ts';
import { commandId, factId, learnerId, type FactId, type Tick } from '../declarations/ids.ts';
import type { Json, Outcome } from '../declarations/types.ts';
import { gatherSnapshot } from '../derivations/gather.ts';
import { applyKernelSchema, kernelSchemaStatements, workerStorage } from '../schema.ts';
import { eraseOriginal } from '../lifecycle.ts';
import { newUlid } from './identity.ts';
import { bindWorkPayload } from './payload.ts';
import {
  checkTodoTriggers, completeTodo, deferDispatchedTodo, emitTodo, maxTodoHops, newFactWatermark, readTodo, updateOrCancelTodo, type TodoInput,
} from './todos.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, registerWorkWait, relayPending, requestWork, runEffect, wakeWaitingWork,
  type WorkRef,
} from './index.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
async function legacyWorkSchema(db: Db) {
  for (const statement of kernelSchemaStatements) await db.query(statement);
}

describe.skipIf(!testDatabaseUrl)('Durable work in PostgreSQL', () => {
  let db: Db;
  aroundEach(run => withLearnerDatabase(learner, async database => {
    db = database;
    await applyKernelSchema(db);
    await run();
  }, { initialize: legacyWorkSchema }));

  const authorPricing = {route:'one', limitUsdMicros:40, reserveUsdMicros:10, actualUsdMicros:() => 10,
    workStages:{followups:['solve-0','solve-1']}};
  function preparePricedTodo(key: string, comparison?: FactId) {
    const source = factId(newUlid()), now = Date.now();
    const ref = (id: FactId) => ({id, revision:1, accessEpoch:'0'});
    return db.tx({learner}, tx => tx.withLearnerWrite(async tick => {
      if (comparison) await tx.insert('facts', {learner_id:learner, id:comparison, type:'test.original',
        current_rev:1, created_tick:tick, changed_tick:tick});
      const todo = await emitTodo(tx,tick,{dedupKey:key, goal:key, trigger:{kind:'immediate'}, workerProfile:'question_author',
        sourceFactRev:ref(source), refs:comparison ? [ref(comparison)] : [], autonomyTier:1,
        budgetCap:30, settingsRevision:1, expiresAtMs:now+60_000},now,async () => true);
      const work = {learner, workId:todo!.id, generation:'1'};
      expect(await bindWorkPayload(tx,work,comparison ? [source,comparison] : [source],
        {factId:factId(newUlid()), commandId:commandId(newUlid())})).toBe(true);
      return {source, work};
    }));
  }

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

  const write = <T>(run: (tx: DbTransaction, tick: Tick) => Promise<T>) =>
    db.tx({ learner }, tx => tx.withLearnerWrite(tick => run(tx, tick)));
  const newTodoSource = () => ({ id: newUlid(), revision: 1, accessEpoch: '0' });
  const todoDefaults = {
    goal: 'Review', trigger: { kind: 'immediate' }, workerProfile: 'deterministic_compute',
    refs: [], autonomyTier: 1, budgetCap: 0, settingsRevision: 1, expiresAtMs: 50,
  } satisfies Omit<TodoInput, 'dedupKey' | 'sourceFactRev'>;
  const submitTodo = (spec: TodoInput, eligible: Parameters<typeof emitTodo>[4], route?: Parameters<typeof emitTodo>[5]) =>
    write((tx, tick) => emitTodo(tx, tick, spec, 1, eligible, route));
  const erase = (root: FactId) => eraseOriginal(db, { learner }, {
    actor: 'learner', confirmed: true, requestId: commandId(newUlid()), root, expectedRev: 1,
  }, async () => ({ ids: [root], commandTypes: [] }), async () => {});

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
        const { rows: [row] } = await db.query<{ blocked: boolean }>(
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

  it('serializes priced effects, charges once and holds unknown amounts across changed limits', async () => {
    const request = { learner, ownerKind: 'session', ownerId: newUlid(), label: 'test-scout', input: { route: 'one' } } as const;
    const pricing = { route: 'one', limitUsdMicros: 100, reserveUsdMicros: 60,
      actualUsdMicros: (result: Json) => typeof result === 'number' ? result : null };
    const usage = () => db.snapshot({ learner }, effectBudgetUsage);
    const sending = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Json>();
    const invoke = vi.fn(async () => {
      sending.resolve();
      return reply.promise;
    });
    const first = { ...request, stepKey: 'known' };
    const second = { ...request, stepKey: 'unreported' };
    const running = runEffect(db, first, invoke, undefined, undefined, pricing);
    void running.catch(sending.reject);
    try {
      await sending.promise;
      expect(await usage()).toEqual({ held: 60n, settled: 0n });
      await expect(runEffect(db, second, invoke, undefined, undefined, pricing)).rejects.toBeInstanceOf(EffectBudgetExceeded);
      expect(await runEffect(db, first, invoke, undefined, undefined, pricing)).toMatchObject({ kind: 'unknown', inFlight: true });
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      reply.resolve(30);
      await running;
    }
    expect(await usage()).toEqual({ held: 0n, settled: 30n });
    expect(await runEffect(db, first, invoke, undefined, undefined, pricing)).toEqual({ kind: 'done', result: 30 });
    await expect(runEffect(db, { ...first, input: { route: 'two' } }, invoke, undefined, undefined, pricing))
      .rejects.toBeInstanceOf(EffectIdentityMismatch);

    const unreported = vi.fn(async () => ({ decision: 'no_action' }));
    await runEffect(db, second, unreported, undefined, undefined, pricing);
    await runEffect(db, second, unreported, undefined, undefined, pricing);
    expect(unreported).toHaveBeenCalledTimes(1);
    expect(await usage()).toEqual({ held: 60n, settled: 30n });

    const lost = { ...request, stepKey: 'lost' };
    const noReply = vi.fn(async () => { throw new Error('connection lost'); });
    const increased = { ...pricing, limitUsdMicros: 150 };
    const unknown = await runEffect(db, lost, noReply, undefined, undefined, increased);
    expect(unknown.kind).toBe('unknown');
    expect(await runEffect(db, lost, noReply, undefined, undefined, increased)).toEqual(unknown);
    expect(noReply).toHaveBeenCalledTimes(1);
    expect(await usage()).toEqual({ held: 120n, settled: 30n });

    const dispatch = vi.fn(async () => null);
    const remaining = { ...pricing, limitUsdMicros: 210 };
    const attempts = await Promise.allSettled(['parallel-a', 'parallel-b'].map(stepKey =>
      runEffect(db, { ...request, stepKey }, dispatch, undefined, undefined, remaining)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts).toContainEqual({ status: 'rejected', reason: expect.any(EffectBudgetExceeded) });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await usage()).toEqual({ held: 180n, settled: 30n });
  });

  it.each([false, true])('reserves all author stages before send and replays the receipt (interrupted: %s)', async interrupted => {
    const prepare = async (key: string) => {
      const {source, work} = await preparePricedTodo(key);
      return {learner, ownerKind:'derivation', ownerId:source, label:'priced-test', stepKey:'author', input:{}, payloadWork:work} as const;
    };
    const request = await prepare('author-a'), contender = await prepare('author-b');
    const response = {title:'Test', question:'2+2?', answer:4};
    const entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<typeof response>();
    const send = vi.fn(async () => { entered.resolve(); return reply.promise; });
    const run = () => runEffect(db,request,send,undefined,undefined,authorPricing);
    const usage = () => db.snapshot({learner}, effectBudgetUsage);
    if (interrupted) {
      await db.query(`CREATE FUNCTION stop_effect_publication() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'publication interrupted'; END $$`);
      await db.query(`CREATE TRIGGER stop_effect_publication BEFORE UPDATE OF state ON effects
        FOR EACH ROW EXECUTE FUNCTION stop_effect_publication()`);
    }
    const first = run();
    void first.catch(entered.reject);
    try {
      await entered.promise;
      expect(await usage()).toEqual({held:30n, settled:0n});
      const secondSend = vi.fn(async () => response);
      await expect(runEffect(db,contender,secondSend,undefined,undefined,authorPricing)).rejects.toBeInstanceOf(EffectBudgetExceeded);
      expect(secondSend).not.toHaveBeenCalled();
    } finally { reply.resolve(response); }
    const retained = {held:20n, settled:10n};
    const done = {kind:'done', result:response};
    if (interrupted) {
      await expect(first).rejects.toThrow('publication interrupted');
      expect((await db.query("SELECT state,result,actual_usd_micros FROM effects WHERE step_key='author'")).rows)
        .toEqual([{state:'started', result:response, actual_usd_micros:'10'}]);
      await db.query('DROP TRIGGER stop_effect_publication ON effects');
    } else expect(await first).toEqual(done);
    expect(await usage()).toEqual(retained);
    expect(await run()).toEqual(done);
    expect(await run()).toEqual(done);
    expect(send).toHaveBeenCalledTimes(1);
    const solve = vi.fn(async () => ({answer:4}));
    const results = await Promise.all(authorPricing.workStages.followups.map(stepKey => runEffect(db, {...request,stepKey},
      solve, undefined, undefined, {...authorPricing,workStages:'claim',actualUsdMicros:() => interrupted ? null : 10})));
    expect(results).toEqual([0,1].map(() => ({kind:'done',result:{answer:4}})));
    expect(solve).toHaveBeenCalledTimes(2);
    expect(await usage()).toEqual(interrupted ? retained : {held:0n, settled:30n});
  });

  it.each([false, true])('settles only the amount after erasure (receipt compacted: %s)', async compacted => {
    const root = factId(newUlid());
    const request = { learner, ownerKind: 'session', ownerId: compacted ? root : newUlid(),
      label: 'priced-test', stepKey: 'send', input: { request: 'private' } } as const;
    const pricing = { route: 'one', limitUsdMicros: 85, reserveUsdMicros: 60,
      actualUsdMicros: (result: Json) => typeof result === 'number' ? result : null };
    await db.tx({ learner }, tx => tx.withLearnerWrite(tick => tx.insert('facts', {
      learner_id: learner, id: root, type: 'test.original', current_rev: 1, created_tick: tick, changed_tick: tick,
    })));
    const effect = await runEffect(db, request, async () => {
      await erase(root);
      return 25;
    }, undefined, undefined, pricing);
    expect(effect.kind).toBe('unknown');
    expect(await db.snapshot({ learner }, effectBudgetUsage)).toEqual({ held: 0n, settled: 25n });
    const ledger = compacted ? 'erased_effect_receipts' : 'effects';
    expect((await db.query(`SELECT actual_usd_micros FROM ${ledger} WHERE learner_id=$1 AND owner_id=$2`,
      [learner, request.ownerId])).rows).toEqual([{ actual_usd_micros: '25' }]);
    expect((await db.query('SELECT result FROM effects WHERE learner_id=$1 AND owner_id=$2',
      [learner, request.ownerId])).rows).toEqual(compacted ? [] : [{ result: null }]);
    if (compacted) await expect(runEffect(db, request, async () => 25, undefined, undefined, pricing)).rejects.toMatchObject({ status: 410 });
    else expect((await runEffect(db, request, async () => 25, undefined, undefined, pricing)).kind).toBe('unknown');
    const next = vi.fn(async () => null);
    await runEffect(db, { ...request, ownerId: newUlid() }, next, undefined, undefined, pricing);
    expect(next).toHaveBeenCalledTimes(1);
    expect(await db.snapshot({ learner }, effectBudgetUsage)).toEqual({ held: 60n, settled: 25n });
  });

  it.each(['erasure','failure'])('releases unsent holds and settles late cost after work %s', async terminal => {
    const root = factId(newUlid());
    const usage = () => db.snapshot({learner}, effectBudgetUsage);
    const {source:primary, work} = await preparePricedTodo('compare', root);
    const request = {learner, ownerKind:'derivation', ownerId:primary, stepKey:'send',
      label:'priced-test', input:{}} as const;
    const cache = {...request,label:'cached-test'};
    const other = {...cache,stepKey:'other'};
    const linked = {...request,payloadWork:work};
    const authorize = async () => {};
    await recordLocalRead(db,other,async () => 'unrelated result',authorize);
    const cached = Promise.withResolvers<string>(), reply = Promise.withResolvers<number>();
    const send = vi.fn<Parameters<typeof runEffect>[2]>(async (id, checkDispatch) => {
      await recordLocalRead(db,{...cache,payloadWork:work},async () => 'mixed result',authorize);
      cached.resolve(id);
      await reply.promise;
      return {saved:await db.tx({learner},checkDispatch).then(() => true, () => false)};
    });
    const run = () => runEffect(db,linked,send,undefined,undefined,authorPricing);
    const running = run();
    void running.catch(cached.reject);
    let providerEffectId: string;
    try {
      providerEffectId = await cached.promise;
      expect(await run()).toEqual({kind:'unknown',providerEffectId,inFlight:true});
      if (terminal === 'erasure') {
        await eraseOriginal(db,{learner},{actor:'learner',confirmed:true,requestId:commandId(newUlid()),root,expectedRev:1},
          async () => ({ids:[root],commandTypes:[]}),async () => {});
        expect((await db.query('SELECT step_key,result FROM effects WHERE learner_id=$1 AND owner_id=$2',[learner,primary])).rows)
          .toEqual([{step_key:other.stepKey,result:'unrelated result'}]);
      } else expect(await failWork(db,work)).toBe(true);
      expect(await usage()).toEqual({held:10n,settled:0n});
    } finally {
      reply.resolve(10);
      await running;
    }
    expect(await usage()).toEqual({held:0n,settled:10n});
    if (terminal === 'erasure') {
      expect(await running).toEqual({kind:'unknown',providerEffectId});
      expect(await run()).toEqual({kind:'unknown',providerEffectId});
    } else {
      expect(await running).toEqual({kind:'done',result:{saved:false}});
      await expect(run()).rejects.toThrow('Work payload is no longer active');
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['wait first', 'target first'])('resumes strict range demand with concurrent writes (%s)', async order => {
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

  it('dispatches scheduled and enumerated completion Todos through the same deduped outbox', async () => {
    const source = newTodoSource();
    const spec: TodoInput = { ...todoDefaults, dedupKey: 'scheduled', goal: 'Prepare review',
      trigger: { kind: 'scheduled', fireAtMs: 5 }, sourceFactRev: source };
    const eligible = vi.fn(async () => true);
    const emit = (intent: TodoInput) => submitTodo(intent, eligible);
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

  it('isolates and defers routed Todos, fencing a previous dispatch generation', async () => {
    const source = newTodoSource();
    const route = { deriver: 'scheduled-v1', erasureBasis: [factId(source.id)], settingsFactId: factId(newUlid()) };
    const deferred = { status: 'not_dispatched', reason: 'unavailable', retryAtMs: 10 } as const;
    const decide = vi.fn(async () => deferred);
    const sweep = (now: number, eligible = async () => true) =>
      db.tx({ learner }, tx => checkTodoTriggers(tx, now, eligible, route.deriver));
    const root = (await submitTodo({ ...todoDefaults, dedupKey: 'deferred', sourceFactRev: source,
      trigger: { kind: 'scheduled', fireAtMs: 5 } }, decide, route))!;
    expect(await db.tx({ learner }, tx => checkTodoTriggers(tx, 5, async () => false))).toEqual({ advanced: false, nextAt: undefined });
    expect(await db.tx({ learner }, tx => checkTodoTriggers(tx, 5, decide, route.deriver))).toEqual({ advanced: false, nextAt: 10 });
    expect(await sweep(9)).toEqual({ advanced: false, nextAt: 10 });
    expect((await db.query('SELECT intent_id FROM work_outbox')).rowCount).toBe(0);
    expect(await sweep(10)).toMatchObject({ advanced: true });
    const ref = { learner, workId: root.id, generation: '1' };
    const { rows: [firstDelivery] } = await db.query<{ intent_id: string }>('SELECT intent_id FROM work_outbox');
    expect(await relayPending(db, async () => {})).toBe(0);
    expect(await acknowledgeStartedWork(db, firstDelivery!.intent_id)).toBeNull();
    expect(await acknowledgeStartedWork(db, firstDelivery!.intent_id, route)).toEqual(ref);
    await write(async (tx, tick) => {
      const dispatched = (await readTodo(tx, root.id))!;
      expect(await deferDispatchedTodo(tx, ref, dispatched, { ...deferred, retryAtMs: 20 }, 11)).toBe(true);
      expect(await completeTodo(tx, tick, ref, dispatched, source.id)).toBe(false);
    });
    expect(await sweep(20)).toMatchObject({ advanced: true });
    expect((await db.query('SELECT generation::text FROM work_outbox ORDER BY generation')).rows)
      .toEqual([{ generation: '1' }, { generation: '2' }]);
    const { rows: [retry] } = await db.query<{ intent_id: string }>("SELECT intent_id FROM work_outbox WHERE generation=2");
    await erase(factId(source.id));
    expect(await db.snapshot({ learner }, tx => readTodo(tx, root.id))).toMatchObject({ state: 'cancelled' });
    expect(await acknowledgeStartedWork(db, retry!.intent_id, route)).toBeNull();
  });

  it('keeps v6 SQL on the same work row while old pinned workers drain', async () => {
    const id = newUlid();
    const spec = { ...todoDefaults, dedupKey: 'legacy', sourceFactRev: newTodoSource() };
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
    const source = newTodoSource();
    const emit = (dedupKey: string, priority: 0 | 1, budgetCap: number) =>
      submitTodo({ ...todoDefaults, dedupKey, priority, budgetCap, sourceFactRev: source }, async spec => spec.budgetCap === 0);
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

it.skipIf(!testDatabaseUrl).each(['valid', 'erased', 'revoked'])('backfills %s v13 correction Work without reissuing it', authority =>
  withLearnerDatabase(learner, async db => {
    const settings = newUlid(), original = newUlid(), source = newUlid();
    const correction = newUlid(), grant = newUlid(), paper = newUlid(), execution = newUlid(), ordinary = newUlid();
    const spec = {
      goal: 'Review', workerProfile: 'deterministic_compute', trigger: { kind: 'scheduled', fireAtMs: 10 },
      sourceFactRev: { id: correction, revision: 1, accessEpoch: '0' },
      refs: [original, grant, paper].map(id => ({ id, revision: 1, accessEpoch: '0' })),
      autonomyTier: 1, budgetCap: 0, settingsRevision: 1, expiresAtMs: 50,
    };
    // Insert the draft rows with the actual v13 constraints, before applying v14.
    const schemaTransaction: Db['schemaTransaction'] = run => db.schemaTransaction(tx => run({
      async query<Row>(...args: Parameters<Db['query']>) {
        const result = await tx.query<Row>(...args);
        if (args[0] !== 'INSERT INTO kernel_schema_migrations (version) VALUES ($1)' || args[1]?.[0] !== 13) return result;
        await tx.query(`INSERT INTO facts (learner_id,id,type,current_rev,created_tick,changed_tick,purpose)
          SELECT $1,id,type,1,1,1,'{storage,teaching,background-research}' FROM unnest($2::text[],$3::text[]) AS f(id,type)`,
        [learner, [original, grant, paper, settings, correction],
          ['content.asset','activity.workbookAttempt','activity.workbookPaper','companion.researchSettings','activity.workbookCorrection']]);
        await tx.query(`INSERT INTO fact_revs (learner_id,fact_id,rev,data,purpose,sticky,kind,author,command_id,tick)
          SELECT learner_id,id,1,CASE id WHEN $2 THEN $3::jsonb WHEN $4 THEN '{"enabled":true}' ELSE '{}' END,
            purpose,false,'value','learner',id,1 FROM facts WHERE learner_id=$1`,
        [learner, original, JSON.stringify({ basis: [{ id: source, rev: 1 }] }), settings]);
        await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys) VALUES
          ($1,'companion.researchWake',$2,'{}'),($1,'working.todo',$3,'{}'),($1,'working.todo',$4,'{}')`,
        [learner, settings, correction, ordinary]);
        await tx.query(`INSERT INTO work (learner_id,id,slot_type,slot_key,deriver,state,execution_ref) VALUES
          ($1,$2,'companion.researchWake',$2,'studio/research-wake-v1','satisfied',NULL)`, [learner, settings]);
        await tx.query(`INSERT INTO work (learner_id,id,slot_type,slot_key,deriver,state,execution_ref,family,spec,chain_id,hop_count,registered_tick) VALUES
          ($1,$2,'working.todo',$2,'deterministic_compute','ready',$3,'todo',$4,$2,0,1),
          ($1,$5,'working.todo',$5,'deterministic_compute','pending',NULL,'todo',$6,$5,0,1)`,
        [learner, correction, execution, JSON.stringify({ ...spec, dedupKey: `correction-retest:${correction}:1` }), ordinary,
          JSON.stringify({ ...spec, dedupKey: `review-attempt:${correction}:1:0` })]);
        await tx.query("INSERT INTO work_outbox VALUES ($1,$2,$3,1,'pending')", [learner, execution, correction]);
        if (authority === 'erased') await tx.query("INSERT INTO tombstones VALUES ($1,$2,'fact',1)", [learner, source]);
        if (authority === 'revoked') await tx.query('UPDATE facts SET access_epoch=1 WHERE learner_id=$1 AND id=$2', [learner, grant]);
        return result;
      },
    }));
    await applyKernelSchema({ ...db, schemaTransaction });
    const valid = authority === 'valid';
    expect(await db.snapshot({ learner }, tx => readTodo(tx, correction))).toMatchObject({
      id: correction, spec, state: valid ? 'dispatched' : 'cancelled', revision: valid ? 1 : 2, route: 'studio/correction-retest-v1',
    });
    expect(await db.snapshot({ learner }, tx => readTodo(tx, ordinary))).toMatchObject({ state: 'pending', route: null });
    expect(await relayPending(db, async (_ref, id) => { expect(id).toBe(execution); })).toBe(valid ? 1 : 0);
  }, { initialize: legacyWorkSchema }));

it.skipIf(!testDatabaseUrl)('rolls back a failed migration and serializes concurrent migration of legacy work', () =>
  withLearnerDatabase(learner, async db => {
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
    expect((await db.query('SELECT version FROM kernel_schema_migrations ORDER BY version')).rows)
      .toEqual(Array.from({ length: 17 }, (_, i) => ({ version: i + 1 })));
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
    await db.query('INSERT INTO kernel_schema_migrations (version) VALUES (18)');
    expect(await workerStorage(db)).toBe(store);
    await db.query('UPDATE kernel_runtime_identity SET minimum_worker_schema = 18');
    await expect(workerStorage(db)).rejects.toThrow('incompatible');
  }, { initialize: legacyWorkSchema }));
