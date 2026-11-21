import { type BusWitness, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createAuthorizedFactReader } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import { activityEvidenceSlice, controlledWorkbookHelp } from '../activity/evidence-slice.ts';
import type { AdmittedHelpEvent } from '../activity/help-exposure.ts';
import { hypothesesAsOf } from './belief-view.ts';
import {
  correctionContradictions, correctionRetestDue, planCorrectionCheck, type ActiveMisconception, type CorrectionObservation,
  type CorrectionReopen, type CorrectionVariant,
} from './correction-check.ts';
import { factWriter, learner, seed, snapshot, use as ref } from './test/facts.ts';

const day = 86_400_000;
const now = Date.parse('2026-11-21T05:00:00.000Z');
const at = (ms: number) => new Date(now + ms).toISOString();
const correction = { source: ref(2, 'test.recordedCorrection'), originalQuestion: ref(3, 'activity.workspaceEntry'),
  admittedAt: '10' as Tick, correctedAt: at(0) };
const proof = ref(6, 'content.knowledgeEdgeEvidence');
const question = ref(4, 'activity.workspaceEntry');
const variant: CorrectionVariant = {
  question, edge: ref(5, 'content.knowledgeEdge'), kind: 'variant_of',
  from: correction.originalQuestion, to: question, verification: proof,
  basis: [proof], variant: { relation: 'numbers_only', spoilsNext: 'none' }, history: 'unseen',
};

it('uses a controlled frozen item and the actual displayed/opened help classification at submission', async () => {
  const source = ref(7, 'activity.retentionPosttestSubmission');
  const issuance = ref(8, 'activity.retentionPosttest');
  const authorization = ref(9, 'test.memoryEvidenceConsent');
  const belief: ActiveMisconception = {
    ref: ref(10, 'companion.memoryAssertion'), kind: 'misconception', conceptIds: ['fraction'],
    stage: 'supported', sticky: false, evidenceSourceIds: [],
  };
  const cutoff = { tick: '13' as Tick, at: at(30_000) };
  const mount = { activityId: issuance.id, issuance, item: { itemId: 'q' } };
  const shown = { ref: ref(11, 'activity.helpExposure'), admittedAt: '12' as Tick,
    value: { kind: 'displayed', mount, content: proof, alsoAppliesTo: [], step: { kind: 'solution', order: 1 } } } satisfies AdmittedHelpEvent;
  let revoked: BusWitness | undefined;
  const reopen: CorrectionReopen = async (ref, purpose) => ref.id !== revoked?.id ? snapshot(ref, {}, [purpose]) : undefined;
  const evidence = (at = cutoff.at, events: readonly AdmittedHelpEvent[] = [], novelty: 'isomorphic' | 'same' = 'isomorphic', confidence?: number) => {
    const { helpLevel } = controlledWorkbookHelp(source, cutoff.tick, [mount], events, false, false);
    const slice = activityEvidenceSlice(cutoff.tick, at, undefined,
      [{ submission: source, occurredAt: at, concepts: belief.conceptIds, novelty, helpLevel, result: 'correct', score: 1 }]);
    return { ...slice, events: slice.events.map(event => event.help_level === 'unknown' ? event : {
      ...event, claim_ids: [belief.ref.id], ...(confidence === undefined ? {} : {confidence}),
    }) };
  };
  const observation: CorrectionObservation = {
    source, issuance, issuedAt: '11' as Tick, itemId: mount.item.itemId, authorization, basis: [],
    admittedAt: cutoff.tick, startedAt: correction.correctedAt, through: at(60_000), window: 'immediate', variant,
    cutoff, slice: evidence(), fragment: { anchor: 'q', excerpt: '12' },
  };
  const result = (changes: Partial<CorrectionObservation> = {}, selected = belief) =>
    correctionContradictions(reopen, correction, { ...observation, ...changes }, [selected]);

  expect(await planCorrectionCheck(reopen, correction, [variant], 1, now))
    .toMatchObject({kind: 'offer', variant, suggestedDurationMs: 30_000});
  const links = await result();
  expect(links).toMatchObject([{ edge: { kind: 'contradicts', to_ref: belief.ref },
    citation: { id: source.id, anchor: 'q', direction: 'contradict' } }]);
  const time = {validFrom: cutoff.at, validTo: null, recordedAt: cutoff.at, supersededAt: null};
  const edge = {...links[0]!.edge, ...time};
  const row = {ref: belief.ref, value: {...time, category: 'hypothesis', kind: belief.kind, status: belief.stage,
    text: '错将分母相加', scope: {}, sticky: belief.sticky, evidence_refs: [correction.source]}} as const;
  const later = at(90 * day);
  const read = (opened: readonly BusWitness[]) => hypothesesAsOf([row], [edge], {validAt: later, knownAt: later}, opened).relations;
  expect(read(edge.basis)).toEqual([edge]);
  expect(read(edge.basis.map(ref => ref.id === source.id ? {...ref, mode: 'pinned'} : ref))).toEqual([]);
  const submitted = (at: string, confidence?: number) => ({cutoff: {...cutoff, at}, slice: evidence(at, [], 'isomorphic', confidence)});
  expect(await result(submitted(cutoff.at.replace('.000Z', 'Z')))).toHaveLength(1);
  expect(await result(submitted(at(30_001), 0.36))).toHaveLength(1);
  for (const kind of ['displayed', 'opened'] as const)
    expect(await result({slice: evidence(cutoff.at, [{...shown, value: {...shown.value, kind}}])}), kind).toEqual([]);
  for (const changes of [{slice: evidence(cutoff.at, [], 'same')}, {slice: evidence(cutoff.at, [], 'isomorphic', 0.35)},
    {variant: {...variant, question: correction.originalQuestion}}, {cutoff: {...cutoff, tick: '14' as Tick}},
    {through: at(29_999)}, {issuedAt: cutoff.tick}, {itemId: 'unassigned-item'}])
    expect(await result(changes)).toEqual([]);
  expect(await result({...submitted(at(day + 10_000)), window: 'scheduled', startedAt: at(day), through: at(day + 60_000)})).toHaveLength(1);
  for (const change of [{evidenceSourceIds: [source.id]}, {sticky: true}, {stage: 'retired' as const}])
    expect(await result({}, {...belief, ...change})).toEqual([]);
  for (const ref of [authorization, proof]) {
    revoked = ref;
    expect(await result()).toEqual([]);
    expect(read(edge.basis.filter(basis => basis.id !== revoked?.id))).toEqual([]);
  }
});

it('rechecks the 24h reservation against the pinned question and current authorization', { timeout: 20_000 }, () =>
  withLearnerDatabase(learner, async db => {
    const { source, originalQuestion } = correction;
    const apply = factWriter(db, {learner, purpose: 'storage'});
    await apply([
      seed(source, ['storage', 'background-research']),
      seed(originalQuestion, ['storage', 'teaching']),
    ], 20);
    const reopen = (tx: ReadTransaction): CorrectionReopen => (ref, purpose) =>
      readable(() => createAuthorizedFactReader(tx, purpose, () => true).reopen(ref));
    const recorded = { ...correction, originalQuestion: { ...originalQuestion, mode: 'pinned' as const } };
    const plan = await db.snapshot({ learner }, tx => planCorrectionCheck(reopen(tx), recorded, [], 1, now));
    if (plan?.kind !== 'scheduled') throw new Error('Missing scheduled Work');
    const dueAt = now + day;
    expect(plan.todo.trigger.fireAtMs).toBe(dueAt);
    const due = (ms: number, revision = 1, subject: typeof correction = recorded) =>
      db.snapshot({ learner }, tx => correctionRetestDue(reopen(tx), subject, plan.todo, revision, ms));
    expect(await due(dueAt - 1)).toBe(false);
    await apply([{ kind: 'correct', id: originalQuestion.id, expectedRev: originalQuestion.rev, data: { title: '更正标题' } }], 21);
    expect(await due(dueAt)).toBe(true);
    expect(await due(dueAt, 1, correction)).toBe(false);
    expect(await due(dueAt, 2)).toBe(false);
    for (const [rev, purpose] of [[2, ['storage']], [3, ['storage', 'teaching']]] as const) {
      await apply([{kind: 'set_purpose', id: originalQuestion.id, expectedRev: rev as Revision, purpose}], 20 + rev);
      expect(await due(dueAt), 'authorization loss or an old epoch').toBe(false);
    }
  }, { postgres: Boolean(testDatabaseUrl) }));
