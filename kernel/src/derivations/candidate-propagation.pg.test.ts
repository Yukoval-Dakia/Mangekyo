import { testDatabaseUrl, withLearnerDatabase } from '../../test/learner-database.ts';
import { aroundEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noteModule } from '../../test/commands/fixture.ts';
import { createCommandHandler, type CommandHandler, type CommandRequest } from '../commands/index.ts';
import type { Db } from '../db/types.ts';
import { defineCommand, defineSlot } from '../declarations/define.ts';
import { commandId, factId, learnerId, type FactId, type Revision } from '../declarations/ids.ts';
import type { GatherContext, Json, SlotRef } from '../declarations/types.ts';
import { newUlid } from '../work/identity.ts';
import { cancelWork, registerWorkWait, requestWork, type WorkRef } from '../work/index.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from './candidate.ts';
import { gatherSnapshot } from './gather.ts';
import { createPropagationHooks } from './propagation.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const purpose = 'learn';
let db: Db;
let handle: CommandHandler;

aroundEach(run => withLearnerDatabase(learner, async database => {
  db = database;
  await run();
}));

const command = (type: string, input: CommandRequest['input']) =>
  handle({ learner, id: commandId(newUlid()), actor: 'learner', purpose, type, input });
const policyFor = (type: string, deriver = type): CandidatePolicy => ({ deriver, purpose, slot: { type } });
type ReadInputs = (ctx: GatherContext) => Json | Promise<Json>;
const gather = (read: ReadInputs) => gatherSnapshot(db, { learner, purpose }, async ctx =>
  ({ kind: 'input', data: await read(ctx), effects: [] }));
const readFact = (id: FactId, mode: 'following' | 'pinned' = 'following'): ReadInputs => async ({ read }) =>
  (await read.fact(id, mode === 'pinned' ? { mode, rev: 1 as Revision } : { mode })).value;
const seal = async (work: WorkRef, policy: CandidatePolicy, read: ReadInputs = () => null) => {
  const result = await sealCandidate(db, work, policy, await gather(read));
  if (result.kind !== 'sealed') throw new Error(`Expected sealed work, got ${result.kind}`);
  return result;
};

const fact = factId('01KFS4AAA00000000000000001');
const slotType = 'note.score';
const request = { slotType, slotKey: 'one', deriver: 'note/score' };
const policy = policyFor(slotType, request.deriver);
const changePurpose = defineCommand({
  type: 'note.purpose', destructive: true,
  schema: z.object({ rev: z.number().int().positive().transform(rev => rev as Revision), purpose: z.array(z.string()) }),
  write: (_ctx, input) => [{ kind: 'set_purpose', id: fact, expectedRev: input.rev, purpose: input.purpose }],
});

// These scenarios drive the command, gather, seal and acceptance entrypoints against one PostgreSQL ledger.
describe.skipIf(!testDatabaseUrl)('Candidate transactions in PostgreSQL', () => {
  const note = noteModule([purpose]);
  const commands = new Map(note.commands).set(changePurpose.type, changePurpose);
  const module = { ...note, commands };
  const hooks = { onSlotChanged: vi.fn() };
  beforeEach(async () => {
    hooks.onSlotChanged.mockClear();
    handle = createCommandHandler(db, { modules: [module], hooks: { onFactsChanged: async () => {} } });
    await db.query("INSERT INTO slot_state(learner_id, slot_type, slot_key, scope_keys) VALUES ($1, $2, $3, '{}')", [learner, slotType, request.slotKey]);
  });

  const register = () => db.tx({ learner }, tx => tx.withLearnerWrite(tick => requestWork(tx, tick, request)));
  const sealed = (ref: WorkRef, mode?: 'following' | 'pinned') => seal(ref, policy, mode ? readFact(fact, mode) : undefined);
  const value = { kind: 'value', value: 3 };
  const ledger = () => db.query('SELECT clock::text, current_id, last_id, changed_tick::text FROM learners JOIN slot_state ON id = learner_id');

  it.each([['S02: following after correction', 'following'], ['S15: pinned after purpose restoration', 'pinned']] as const)(
    '%s requires a fresh gather', async (_scenario, mode) => {
      await command('note.record', { id: fact, text: 'original' });
      const old = await register();
      const candidate = await sealed(old, mode);
      if (mode === 'following') await command('note.correct', { id: fact, text: 'corrected', rev: 1 });
      else {
        await command('note.purpose', { rev: 1, purpose: ['storage'] });
        await command('note.purpose', { rev: 2, purpose: [purpose] });
      }
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
    await command('note.record', { id: fact, text: 'old basis' });
    const first = await register();
    const old = await sealed(first, 'following');
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

const scope = { knowledgePoint: 'K' };
const excluded = factId('01KFS4AAA00000000000000001');
const promotion = factId('01KFS4AAA00000000000000002');
const gradeSlot = defineSlot({ type: 'note.grade', key: (input: { id: string }) => input.id,
  policy: 'eager', triggers: [{ kind: 'fact', factType: 'note.entry' }, { kind: 'slot', slotType: 'note.grade' }] });
const slot = (type: string, key: string): SlotRef => ({ learner, type, key });
const grade = (id: FactId) => slot(gradeSlot.type, id);
const mastery = (key: string) => slot('note.mastery', key);
const plan = (key: string) => slot('note.plan', key);
const candidatePolicy = (ref: SlotRef) => policyFor(ref.type);
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

describe.skipIf(!testDatabaseUrl)('Production propagation in PostgreSQL', () => {
  beforeEach(() => {
    handle = createCommandHandler(db, { modules: [noteModule([purpose])], hooks });
  });

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
  const readSlot = (ref: SlotRef, mode: 'following' | 'asof' | 'pinned' = 'following') => async ({ read }: GatherContext) =>
    (await read.slot(ref, { mode })).outcome;
  const readRange = async ({ read }: GatherContext) => (await read.range(gradeSlot.type, scope)).members.map(member => member.outcome);
  const publish = async (ref: SlotRef, read: ReadInputs, work?: WorkRef) => {
    work ??= await request(ref);
    const sealed = await seal(work, candidatePolicy(ref), read);
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
    const inFlight = await seal(next, candidatePolicy(g), readFact(id));

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
    const retryCandidate = await seal(retry, candidatePolicy(g), readFact(id));
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
    const sealed = await seal(active, candidatePolicy(mastery('K')), readRange);
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
    const candidate = await seal(work, candidatePolicy(target), readRange);
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
