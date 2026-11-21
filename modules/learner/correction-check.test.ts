import { commandId, factId, learnerId, type BusWitness, type FactWrite, type Json, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { FactNotFoundError, FactReadDeniedError, createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import { applyFactWrites } from '../../kernel/src/commands/writes.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { relayPending } from '../../kernel/src/work/index.ts';
import { checkTodoTriggers, completeTodo, emitTodo, readTodo, updateOrCancelTodo, type TodoSpec } from '../../kernel/src/work/todos.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import { activityEvidenceSlice, controlledWorkbookHelp } from '../activity/evidence-slice.ts';
import type { AdmittedHelpEvent } from '../activity/help-exposure.ts';
import {
  correctionContradictions, correctionRetestDue, planCorrectionCheck, type CorrectionReopen, type CorrectionVariant,
} from './correction-check.ts';

const id = (n: number) => factId(String(n).padStart(26, '0'));
const learner = learnerId(id(1));
const ref = (n: number, type: string): BusWitness => ({
  id: id(n), rev: 1 as Revision, accessEpoch: '0' as Tick, learner, type, mode: 'following',
});
const now = Date.parse('2026-11-21T05:00:00.000Z');
const at = (ms: number) => new Date(now + ms).toISOString();
const correction = { source: ref(2, 'test.recordedCorrection'), originalQuestion: ref(3, 'activity.workspaceEntry'),
  admittedAt: '10' as Tick, correctedAt: at(0) };
const proof = ref(6, 'content.knowledgeEdgeEvidence');
const variant: CorrectionVariant = {
  question: ref(4, 'activity.workspaceEntry'), edge: ref(5, 'content.knowledgeEdge'), kind: 'variant_of',
  from: correction.originalQuestion, to: ref(4, 'activity.workspaceEntry'), verification: proof,
  basis: [proof], variant: { relation: 'numbers_only', spoilsNext: 'none' }, history: 'unseen',
};

it('uses a controlled frozen item and the actual displayed/opened help classification at submission', async () => {
  const source = ref(7, 'activity.retentionPosttestSubmission');
  const issuance = ref(8, 'activity.retentionPosttest');
  const authorization = ref(9, 'test.memoryEvidenceConsent');
  const belief: Parameters<typeof correctionContradictions>[3][number] = {
    ref: ref(10, 'companion.memoryAssertion'), kind: 'misconception', conceptIds: ['fraction'],
    stage: 'supported', sticky: false, evidenceSourceIds: [],
  };
  const cutoff = { tick: '13' as Tick, at: at(30_000) };
  const mount = { activityId: issuance.id, issuance, item: { itemId: 'q' } };
  const shown = { ref: ref(11, 'activity.helpExposure'), admittedAt: '12' as Tick,
    value: { kind: 'displayed', mount, content: proof, alsoAppliesTo: [], step: { kind: 'solution', order: 1 } } } satisfies AdmittedHelpEvent;
  const opened: AdmittedHelpEvent = { ...shown, value: { ...shown.value, kind: 'opened' } };
  let revoked: BusWitness | undefined;
  const reopen: CorrectionReopen = async (ref, purpose) => ref.id !== revoked?.id
    ? { type: ref.type, ref, accessEpoch: ref.accessEpoch, purpose: [purpose], value: {} } : undefined;
  const result = (events: AdmittedHelpEvent[] = [], changes: Partial<Parameters<typeof correctionContradictions>[2]> = {},
    novelty: 'isomorphic' | 'same' = 'isomorphic', selected = [belief], submittedAt = cutoff.at) => {
    const observedCutoff = changes.cutoff ?? cutoff;
    const { helpLevel } = controlledWorkbookHelp(source, cutoff.tick, [mount], events, false, false);
    const slice = activityEvidenceSlice(cutoff.tick, observedCutoff.at, { ref: issuance.id, at: observedCutoff.at },
      [{ submission: source, occurredAt: submittedAt, concepts: ['fraction'], novelty, helpLevel, result: 'correct', score: 1 }]);
    return correctionContradictions(reopen, correction, {
      source, issuance, issuedAt: '11' as Tick, itemId: mount.item.itemId, authorization, basis: [],
      admittedAt: cutoff.tick, startedAt: at(0), through: at(60_000), window: 'immediate', variant,
      cutoff: observedCutoff, slice: { ...slice, events: slice.events.map(event => ({ ...event, claim_ids: [belief.ref.id] })) },
      fragment: { anchor: 'q', excerpt: '12' }, ...changes,
    }, selected);
  };

  expect(await planCorrectionCheck(reopen, correction, [variant], 1, now)).toMatchObject({
    kind: 'offer', variant: { question: variant.question }, suggestedDurationMs: 30_000,
  });
  expect(await result()).toMatchObject([{ edge: { kind: 'contradicts', to_ref: belief.ref },
    citation: { id: source.id, anchor: 'q', direction: 'contradict' } }]);
  const seconds = cutoff.at.replace('.000Z', 'Z');
  expect(await result([], {cutoff: {...cutoff, at: seconds}}, 'isomorphic', [belief], seconds)).toHaveLength(1);
  expect(await result([shown])).toEqual([]);
  expect(await result([opened])).toEqual([]);
  expect(await result([], {}, 'same')).toEqual([]);
  expect(await result([], { variant: { ...variant, question: correction.originalQuestion } })).toEqual([]);
  expect(await result([], { cutoff: { ...cutoff, tick: '14' as Tick } })).toEqual([]);
  expect(await result([], { cutoff: { ...cutoff, at: at(30_001) } }, 'isomorphic', [belief], at(30_001))).toHaveLength(1);
  expect(await result([], { through: at(29_999) })).toEqual([]);
  expect(await result([], { issuedAt: cutoff.tick })).toEqual([]);
  expect(await result([], { itemId: 'unassigned-item' })).toEqual([]);
  const scheduledAt = 86_400_000;
  expect(await result([], { window: 'scheduled', startedAt: at(scheduledAt), through: at(scheduledAt + 60_000),
    cutoff: { ...cutoff, at: at(scheduledAt + 10_000) } }, 'isomorphic', [belief], at(scheduledAt + 10_000))).toHaveLength(1);
  expect(await result([], {}, 'isomorphic', [{ ...belief, evidenceSourceIds: [source.id] }])).toEqual([]);
  expect(await result([], {}, 'isomorphic', [{ ...belief, sticky: true }])).toEqual([]);
  expect(await result([], {}, 'isomorphic', [{ ...belief, stage: 'retired' as const }])).toEqual([]);
  revoked = authorization;
  expect(await result()).toEqual([]);
  revoked = proof;
  expect(await result()).toEqual([]);
});

it('persists the 24h reservation through Work and blocks revoked or cancelled replays', { timeout: 20_000 }, async () => {
  await withLearnerDatabase(learner, async db => {
    const teaching = ['storage', 'teaching'];
    const research = ['storage', 'background-research'];
    const sources = [
      [correction.source, research], [correction.originalQuestion, teaching],
      [ref(12, correction.source.type), research], [ref(13, correction.source.type), research],
    ] as const;
    const reopen = (tx: ReadTransaction): CorrectionReopen => async (ref, purpose) => {
      try { return await createCommandReadContext(tx, purpose).fact(ref.id,
        ref.mode === 'pinned' ? { mode: 'pinned', rev: ref.rev } : { mode: 'following' }); }
      catch (error) {
        if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return undefined;
        throw error;
      }
    };
    const apply = (writes: readonly FactWrite[], n: number) => db.tx({ learner }, tx => tx.withLearnerWrite(tick =>
      applyFactWrites(tx, tick, writes, { actor: 'learner', purpose: 'storage', commandId: commandId(id(n)) },
        type => ({ type, schema: { parse: (value: Json) => value } }))));
    await apply(sources.map(([ref, purpose]) => ({ kind: 'create', id: ref.id, factType: ref.type, data: {}, purpose })), 20);
    const recorded = { ...correction, originalQuestion: { ...correction.originalQuestion, mode: 'pinned' as const } };
    const second = { ...recorded, source: sources[2][0] };
    const third = { ...recorded, source: sources[3][0] };
    const emit = (source: typeof correction) => db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      const plan = await planCorrectionCheck(reopen(tx), source, [], 1, now);
      if (plan?.kind !== 'scheduled') throw new Error('Missing scheduled Work');
      expect(plan.todo.trigger.fireAtMs).toBe(Date.parse(at(86_400_000)));
      const todo = await emitTodo(tx, tick, plan.todo, now, async () => true);
      if (!todo) throw new Error('Work rejected');
      return todo;
    }));

    const first = await emit(recorded);
    expect((await emit(recorded)).id).toBe(first.id);
    const cancelled = await emit(second);
    const revoked = await emit(third);
    const dueAt = Date.parse(at(86_400_000));
    const sweep = (ms: number) => db.tx({ learner }, tx => checkTodoTriggers(tx, ms, (spec: TodoSpec) => {
      const subject = [recorded, second, third].find(value => value.source.id === spec.sourceFactRev.id);
      return subject ? correctionRetestDue(reopen(tx), subject, spec, 1, ms) : Promise.resolve(false);
    }));
    expect(await sweep(dueAt - 1)).toEqual({ advanced: false, nextAt: dueAt });
    expect(await relayPending(db, async () => {})).toBe(0);
    await apply([{ kind: 'set_purpose', id: third.source.id, expectedRev: third.source.rev, purpose: ['storage'] }], 21);
    await apply([{ kind: 'correct', id: recorded.originalQuestion.id, expectedRev: recorded.originalQuestion.rev, data: { title: '更正标题' } }], 22);
    expect(await db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), recorded, first.spec, 1, dueAt))).toBe(true);
    expect(await db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), correction, first.spec, 1, dueAt))).toBe(false);
    expect(await db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), recorded, first.spec, 2, dueAt))).toBe(false);
    expect(await sweep(dueAt)).toMatchObject({ advanced: true });
    const inspect = (todoId: string) => db.snapshot({ learner }, tx => readTodo(tx, todoId));
    expect((await inspect(revoked.id))?.state).toBe('cancelled');

    const dispatched = await inspect(cancelled.id);
    if (!dispatched) throw new Error('Missing Work');
    const workRef = { learner, workId: cancelled.id, generation: '1' };
    await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
      expect(await updateOrCancelTodo(tx, tick, cancelled.id, dispatched.revision, { kind: 'cancel' }, dueAt, async () => true)).toBe(true);
      expect(await completeTodo(tx, tick, workRef, dispatched, id(23))).toBe(false);
    }));
    expect(await relayPending(db, async work => { expect(work.workId).toBe(first.id); })).toBe(1);
    expect(await sweep(dueAt + 1)).toMatchObject({ advanced: false });
    const changePurpose = (rev: number, purpose: string[], command: number) =>
      apply([{ kind: 'set_purpose', id: recorded.originalQuestion.id, expectedRev: rev as Revision, purpose }], command);
    await changePurpose(2, ['storage'], 24);
    expect(await db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), recorded, first.spec, 1, dueAt))).toBe(false);
    await changePurpose(3, teaching, 25);
    expect(await db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), recorded, first.spec, 1, dueAt))).toBe(false);
  }, { postgres: Boolean(testDatabaseUrl) });
});
