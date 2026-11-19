import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noteModule } from '../../test/commands/fixture.ts';
import { createCommandHandler, type CommandRequest } from '../commands/index.ts';
import { createPgDb } from '../db/pg.ts';
import type { Db } from '../db/types.ts';
import { defineSlot } from '../declarations/define.ts';
import { commandId, factId, learnerId, type FactId, type Revision } from '../declarations/ids.ts';
import type { GatherContext, Json, SlotRef } from '../declarations/types.ts';
import { applyKernelSchema } from '../schema.ts';
import { newUlid } from '../work/identity.ts';
import { registerWorkWait, requestWork, type WorkRef } from '../work/index.ts';
import { sealCandidate, submitCandidate } from './candidate.ts';
import { gatherSnapshot } from './gather.ts';
import { createPropagationHooks } from './propagation.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
const learner = learnerId('01KFS4AAA00000000000000000');
const purpose = 'learn';
const scope = { knowledgePoint: 'K' };
const excluded = factId('01KFS4AAA00000000000000001');
const promotion = factId('01KFS4AAA00000000000000002');
const gradeSlot = defineSlot({ type: 'note.grade', key: (input: { id: string }) => input.id,
  policy: 'eager', triggers: [{ kind: 'fact', factType: 'note.entry' }, { kind: 'slot', slotType: 'note.grade' }] });
const slot = (type: string, key: string): SlotRef => ({ learner, type, key });
const grade = (id: FactId) => slot(gradeSlot.type, id);
const mastery = (key: string) => slot('note.mastery', key);
const plan = (key: string) => slot('note.plan', key);
const candidatePolicy = (ref: SlotRef) => ({ deriver: ref.type, purpose, slot: { type: ref.type } });
const hooks = createPropagationHooks([
  { slot: gradeSlot, deriver: gradeSlot.type, targets: (_tx, event) => event.kind === 'fact'
    ? [{ key: gradeSlot.key(event.change.ref), scopeKeys: scope,
      evidenceEligible: event.change.ref.id !== excluded && event.change.ref.id !== promotion }]
    : event.kind === 'slot' && event.slot.key === promotion && event.currentId
      ? [{ key: promotion, scopeKeys: scope, evidenceEligible: true }] : [] },
  { slot: { type: 'note.lazy', policy: 'lazy', triggers: [{ kind: 'fact', factType: 'note.entry' }] }, deriver: 'note.lazy',
    targets: (_tx, event) => event.kind === 'fact' ? [{ key: event.change.ref.id, scopeKeys: {}, evidenceEligible: false }] : [] },
  { slot: { type: 'note.mastery', policy: 'eager', triggers: [{ kind: 'slot', slotType: gradeSlot.type }] }, deriver: 'note.mastery',
    targets: (_tx, event) => event.kind === 'slot' && event.currentId && event.slot.key !== excluded
      ? [{ key: 'K', scopeKeys: {}, evidenceEligible: false }] : [] },
]);

describe.skipIf(!connectionString)('Production propagation in PostgreSQL', () => {
  const schema = `propagation_${process.pid}`;
  let admin: Db;
  let db: Db;
  let handle: ReturnType<typeof createCommandHandler>;
  beforeEach(async () => {
    admin = createPgDb(new pg.Pool({ connectionString }));
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = createPgDb(new pg.Pool({ connectionString }), { schema });
    await applyKernelSchema(db);
    await db.query('INSERT INTO learners(id) VALUES($1)', [learner]);
    handle = createCommandHandler(db, { modules: [noteModule([purpose])], hooks });
  });
  afterEach(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });

  const command = (type: string, input: CommandRequest['input']) =>
    handle({ learner, id: commandId(newUlid()), actor: 'learner', purpose, type, input });
  const correction = async (id: FactId) => {
    await command('note.correct', { id, rev: 1, text: 'corrected' });
    return (await db.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id = $1', [learner])).rows[0]!.tick;
  };
  const state = async (ref: SlotRef) => (await db.query(
    'SELECT current_id, last_id, changed_tick::text, evidence_eligible FROM slot_state WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3',
    [learner, ref.type, ref.key],
  )).rows[0];
  const producer = async (ref: SlotRef) => (await db.query<WorkRef & { state: string; requested_tick: string }>(
    'SELECT learner_id AS learner, id AS "workId", generation::text, state, requested_tick::text FROM work WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3',
    [learner, ref.type, ref.key],
  )).rows[0]!;
  const ledger = async (id: string) => (await db.query(
    'SELECT lifecycle, freshness, invalidated_tick::text, selection_ended_tick::text, value FROM derivations WHERE learner_id = $1 AND id = $2',
    [learner, id],
  )).rows[0];

  const request = (ref: SlotRef) => db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
    await tx.query(`INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
      VALUES ($1, $2, $3, '{}', $4) ON CONFLICT DO NOTHING`, [learner, ref.type, ref.key, tick]);
    return requestWork(tx, tick, { slotType: ref.type, slotKey: ref.key, deriver: ref.type });
  }));
  const gather = (read: (ctx: GatherContext) => Promise<Json>) => gatherSnapshot(db, { learner, purpose }, async ctx =>
    ({ kind: 'input', data: await read(ctx), effects: [] }));
  const readFact = (id: FactId, mode: 'following' | 'pinned' = 'following') => async ({ read }: GatherContext) =>
    (await read.fact<{ text: string }>(id, mode === 'pinned' ? { mode, rev: 1 as Revision } : { mode })).value;
  const readSlot = (ref: SlotRef, mode: 'following' | 'asof' | 'pinned' = 'following') => async ({ read }: GatherContext) =>
    (await read.slot(ref, { mode })).outcome;
  const readRange = async ({ read }: GatherContext) => (await read.range(gradeSlot.type, scope)).members.map(member => member.outcome);
  const seal = async (ref: SlotRef, work: WorkRef, read: Parameters<typeof gather>[0]) => {
    const result = await sealCandidate(db, work, candidatePolicy(ref), await gather(read));
    if (result.kind !== 'sealed') throw new Error(`Expected sealed work, got ${result.kind}`);
    return result;
  };
  const publish = async (ref: SlotRef, read: Parameters<typeof gather>[0], work?: WorkRef) => {
    work ??= await request(ref);
    const sealed = await seal(ref, work, read);
    const result = await submitCandidate(db, work, candidatePolicy(ref), sealed.id, { kind: 'value', value: sealed.plan.data }, hooks);
    if (result.kind !== 'effective') throw new Error(`Expected effective work, got ${result.kind}`);
    return { id: sealed.id, tick: result.tick };
  };
  const wait = (work: WorkRef, snapshot: Awaited<ReturnType<typeof gather>>) =>
    db.tx({ learner }, tx => registerWorkWait(tx, work, snapshot.waits));

  it('closes a real correction in one tick and registers a retryable stale slot as a wait target', async () => {
    const id = factId(newUlid());
    await command('note.record', { id, text: 'original' });
    const g = grade(id);
    const m = mastery('K');
    const p = plan('following');
    const old = await publish(g, readFact(id), await producer(g));
    const summary = await publish(m, readRange, await producer(m));
    const schedule = await publish(p, readSlot(m));
    const pinned = await publish(plan('pinned'), readFact(id, 'pinned'));
    const next = await request(g);
    const inFlight = await seal(g, next, readFact(id));

    const tick = await correction(id);
    for (const [ref, accepted] of [[g, old], [m, summary], [p, schedule]] as const) {
      expect(await state(ref)).toMatchObject({ current_id: null, last_id: accepted.id, changed_tick: tick });
      expect(await ledger(accepted.id)).toMatchObject({ lifecycle: 'stale', invalidated_tick: tick });
    }
    expect(await ledger(old.id)).toMatchObject({ value: { kind: 'value', value: { text: 'original' } } });
    expect(await ledger(pinned.id)).toMatchObject({ lifecycle: 'effective', value: { kind: 'value', value: { text: 'original' } } });
    expect(await ledger(inFlight.id)).toMatchObject({ lifecycle: 'stale', invalidated_tick: tick });
    expect(await producer(g)).toMatchObject({ workId: next.workId, state: 'ready', generation: '3', requested_tick: tick });
    expect(await producer(p)).toMatchObject({ state: 'satisfied' });
    expect(await submitCandidate(db, next, candidatePolicy(g), inFlight.id, { kind: 'value', value: null }, hooks)).toEqual({ kind: 'obsolete' });

    const snapshot = await gather(readRange);
    expect(snapshot.waits).toEqual([{ ref: g, changedTick: tick }]);
    expect(await wait(await producer(m), snapshot)).toEqual({ kind: 'waiting' });
    const retry = await producer(g);
    const retryCandidate = await seal(g, retry, readFact(id));
    await submitCandidate(db, retry, candidatePolicy(g), retryCandidate.id, { kind: 'failed', reason: 'grade failed' }, hooks);
    expect(await producer(m)).toMatchObject({ state: 'blocked' });
    expect(await wait(await request(m), await gather(readRange))).toMatchObject({ kind: 'blocked' });

    const recovered = await request(g);
    expect(await wait(await request(m), await gather(readRange))).toEqual({ kind: 'waiting' });
    await publish(g, readFact(id), recovered);
    expect(await producer(m)).toMatchObject({ state: 'ready' });
  });

  it('keeps range/asof behind local and later propagates an exact superseded member invalidation', async () => {
    const first = factId(newUlid());
    await command('note.record', { id: first, text: '2026-11-18T00:00:00Z' });
    const g = grade(first);
    const old = await publish(g, readFact(first), await producer(g));
    const m = await publish(mastery('K'), readRange, await producer(mastery('K')));
    const child = await publish(plan('child'), readSlot(mastery('K'), 'asof'));
    const following = await publish(plan('following'), readSlot(g));
    const asof = await publish(plan('asof'), readSlot(g, 'asof'));
    const pinned = await publish(plan('pinned'), readSlot(g, 'pinned'));

    await command('note.record', { id: excluded, text: 'ineligible' });
    await publish(grade(excluded), readFact(excluded), await producer(grade(excluded)));
    expect(await state(grade(excluded))).toMatchObject({ evidence_eligible: false });
    expect(await ledger(m.id)).toMatchObject({ lifecycle: 'effective', freshness: 'current' });

    const active = await request(mastery('K'));
    const sealed = await seal(mastery('K'), active, readRange);
    const late = factId(newUlid());
    await command('note.record', { id: late, text: '2026-11-17T00:00:00Z' });
    expect(await state(grade(late))).toMatchObject({ current_id: null, evidence_eligible: true });
    const waiter = await request(mastery('wait'));
    expect(await wait(waiter, await gather(readRange))).toEqual({ kind: 'waiting' });
    const added = await publish(grade(late), readFact(late), await producer(grade(late)));
    expect(await ledger(m.id)).toMatchObject({ lifecycle: 'effective', freshness: 'behind' });
    expect(await ledger(child.id)).toMatchObject({ lifecycle: 'effective', freshness: 'current' });
    expect(await producer(mastery('K'))).toMatchObject({ state: 'ready', generation: active.generation });
    expect(await producer(mastery('wait'))).toMatchObject({ state: 'ready', generation: '2', requested_tick: added.tick });
    const published = await submitCandidate(db, active, candidatePolicy(mastery('K')), sealed.id,
      { kind: 'value', value: sealed.plan.data }, hooks);
    expect(published).toMatchObject({ kind: 'effective', freshness: 'behind' });
    expect(await producer(mastery('K'))).toMatchObject({ state: 'ready', generation: '3' });

    const replacement = await publish(g, readFact(first, 'pinned'));
    expect(await ledger(following.id)).toMatchObject({ lifecycle: 'stale', invalidated_tick: replacement.tick });
    expect(await ledger(asof.id)).toMatchObject({ lifecycle: 'effective', freshness: 'behind' });
    expect(await ledger(pinned.id)).toMatchObject({ lifecycle: 'effective', freshness: 'current' });
    const tick = await correction(first);
    for (const item of [old, m, asof, pinned, child]) {
      expect(await ledger(item.id)).toMatchObject({ lifecycle: 'stale', invalidated_tick: tick });
    }
    expect(await ledger(old.id)).toMatchObject({ selection_ended_tick: replacement.tick });
    expect(await state(g)).toMatchObject({ current_id: replacement.id, last_id: replacement.id, changed_tick: replacement.tick });
    expect(await ledger(added.id)).toMatchObject({ lifecycle: 'effective', freshness: 'current',
      value: { kind: 'value', value: { text: '2026-11-17T00:00:00Z' } } });
  });

  it.each(['failed', 'rejected'] as const)('queues new evidence after a %s sealed outcome', async kind => {
    const target = mastery('K');
    const work = await request(target);
    const candidate = await seal(target, work, readRange);
    const late = factId(newUlid());
    await command('note.record', { id: late, text: 'new evidence' });
    await publish(grade(late), readFact(late), await producer(grade(late)));
    expect(await producer(target)).toMatchObject({ generation: work.generation, state: 'ready' });
    const outcome = kind === 'failed' ? { kind, reason: 'compute failed' } : { kind: 'value', value: [] };
    const policy = { ...candidatePolicy(target), slot: { type: target.type,
      accept: () => ({ ok: false as const, reason: 'accept rejected' }) } };
    expect(await submitCandidate(db, work, policy, candidate.id, outcome, hooks)).toMatchObject({ kind });
    const catchUp = await producer(target);
    expect(catchUp).toMatchObject({ generation: '2', state: 'ready' });
    const result = await publish(target, readRange, catchUp);
    expect(await ledger(result.id)).toMatchObject({ lifecycle: 'effective', freshness: 'current',
      value: { kind: 'value', value: [{ kind: 'value', value: { text: 'new evidence' } }] } });
  });

  it('catalogues lazy slots and promotes a published value without scheduling it again', async () => {
    await command('note.record', { id: promotion, text: 'answer' });
    const lazy = slot('note.lazy', promotion);
    expect(await state(lazy)).toMatchObject({ current_id: null });
    expect(await producer(lazy)).toBeUndefined();
    const target = grade(promotion);
    await publish(target, readFact(promotion), await producer(target));
    expect(await state(target)).toMatchObject({ evidence_eligible: true });
    expect(await producer(target)).toMatchObject({ generation: '1', state: 'satisfied' });
  });
});
