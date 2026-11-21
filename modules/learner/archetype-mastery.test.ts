import { expect, it } from 'vitest';
import type { BusWitness, EvidenceEventV1, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import {
  archetypeQuestionConceptId, projectArchetypeMastery,
  type ArchetypeFoldingCluster, type ArchetypeMasterySources,
} from './archetype-mastery.ts';
import type { TextbookMasteryEvidenceBatch } from './textbook-mastery.ts';

const learner = 'learner' as LearnerId, now = '2026-11-21T00:00:00.000Z', watermark = '1' as Tick;
const witness = (id: string, type = 'content.question', epoch = '0' as Tick, rev = 1 as Revision): BusWitness =>
  ({ learner, id: id as BusWitness['id'], rev, accessEpoch: epoch, type, mode: 'pinned' });
const scope = { learner, purpose: 'teaching', recipientId: 'recipient', asOf: now, clockWatermark: watermark };
const archetype = witness('archetype', 'content.asset');
const [first, second, third, fourth, fifth, sixth] = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map(id => witness(id)) as [BusWitness, BusWitness, BusWitness, BusWitness, BusWitness, BusWitness];
const edgeOf = (id: string) => witness(id, 'content.knowledgeEdge'), attemptOf = (id: string) => witness(id, 'activity.workbookAttempt');
const anchorFor = (question: BusWitness, sub = question.id + '-sub'): TextbookMasteryEvidenceBatch['anchors'][number] => ({
  submission: attemptOf(sub), question, itemId: question.id, href: '/' + question.id,
  recordedAt: watermark, basis: [witness(question.id + '-basis', 'content.examItem')],
});
const eventFor = (question: BusWitness, outcome: EvidenceEventV1['outcome'] = 'correct',
  concepts: readonly string[] = [archetypeQuestionConceptId(question)], ref = question.id + '-sub'): EvidenceEventV1 => ({
  ref, rev: 1, occurred_at: now, help_level: 'independent', outcome, item_novelty: 'same', claim_ids: [], concept_ids: concepts,
});
const batchFor = (questions: readonly BusWitness[], events: readonly EvidenceEventV1[] = [],
  anchors = questions.map(question => anchorFor(question))): TextbookMasteryEvidenceBatch => ({ anchors,
  slice: { clock_watermark: watermark, as_of_at: now, events,
    constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] } });
const rowFor = (event: EvidenceEventV1, rNow = event.outcome === 'incorrect' ? .2 :
  event.concept_ids[0] === archetypeQuestionConceptId(third) ? .5 : .95) => ({
  concept_id: event.concept_ids[0]!, item_novelty: 'same', representation: null, context: null, method: null,
  state: 'known' as const, uncertainty: { kind: 'interval' as const, low: .9, high: .99 }, r_now: rNow,
  evidence_refs: [{ ref: event.ref, rev: event.rev }] });
const sources = (over: Partial<ArchetypeMasterySources> = {}): ArchetypeMasterySources => ({
  readEvidence: async () => batchFor([]), derive: async (_scope, _method, slice) =>
    ({ method_version: 'cognition@3', state_vector: slice.events.map(event => rowFor(event)) }),
  reopen: async (_scope, witnesses) => witnesses, ...over });
const cluster = (members: ArchetypeFoldingCluster['members'], title: string | null = ' 一元二次方程 '): ArchetypeFoldingCluster =>
  ({ kind: 'archetype' as const, archetype, members, ...(title === null ? {} : { title }) });
const run = (clusters: readonly ArchetypeFoldingCluster[], over: Partial<ArchetypeMasterySources> = {}) =>
  projectArchetypeMastery({ ...scope, clusters }, sources(over));

it('covers archetype mastery authorization, anchoring, conflicts, paths, states, and practice', async () => {
  const callOrder: string[] = [];
  const preparedConcepts: string[][] = [];
  const stateView = await run([cluster([
    { question: first, basis: [edgeOf('e1')], practiceBasis: [attemptOf('p1')] },
    { question: second, proof: { membership: edgeOf('m2'), basis: [] }, practiceBasis: [attemptOf('p2')] },
    { question: third, proof: { memberships: [edgeOf('m3')], basis: [] } },
    { question: fourth, basis: [edgeOf('e4')] },
  ])], {
    prepareEvidence: (_scope, conceptIds) => { callOrder.push('prepare'); preparedConcepts.push([...conceptIds]); },
    readEvidence: async () => { callOrder.push('read'); return batchFor([first, second, third, fourth],
      [eventFor(first), eventFor(second, 'incorrect'), eventFor(third)]); },
  });
  expect(callOrder).toEqual(['prepare', 'read']);
  expect(preparedConcepts).toEqual([[first, second, third, fourth].map(archetypeQuestionConceptId)]);
  expect(stateView.clusters[0]).toMatchObject({ title: '一元二次方程', coveredQuestionCount: 4,
    counts: { steady: 1, due: 1, weak: 1, unknown: 1 }, representative: { question: second, state: 'weak' } });
  expect(stateView.clusters[0]?.members.map(({ question, state }) => [question.id, state]))
    .toEqual([['first', 'steady'], ['second', 'weak'], ['third', 'due'], ['fourth', 'unknown']]);
  expect(archetypeQuestionConceptId(witness('a/b'))).toBe('archetype-mastery/a%2Fb/1');

  const foreign = { ...witness('foreign'), learner: 'other' as LearnerId };
  const seenEvidence: string[] = [], seenReopen: string[] = [];
  const partialRevoked = await run([cluster([
    { question: first, basis: [edgeOf('e1')] }, { question: second, basis: [edgeOf('e2')] },
    { question: foreign, basis: [foreign] }, { question: witness('stale', 'content.question', '9' as Tick), basis: [edgeOf('es')] },
  ])], {
    readEvidence: async (_scope, questions) => { seenEvidence.push(...questions.map(ref => ref.id)); return batchFor([first, second], [eventFor(first)]); },
    reopen: async (_scope, witnesses) => { seenReopen.push(...witnesses.map(ref => ref.id)); return witnesses.filter(ref => ref.id !== 'second'); },
  });
  expect(seenEvidence).toEqual(['first', 'second']);
  expect(seenReopen.filter(id => id === 'foreign' || id === 'stale')).toEqual([]);
  expect(partialRevoked.clusters[0]).toMatchObject({ coveredQuestionCount: 1, counts: { steady: 1, due: 0, weak: 0, unknown: 0 } });
  expect((await run([cluster([{ question: first, basis: [edgeOf('o1')] }]),
    cluster([{ question: { ...first, type: 'content.variant' }, basis: [edgeOf('o2')] }])])).clusters).toEqual([]);

  const anchored = await run([cluster([first, second, third, fourth, fifth, sixth].map(question =>
    ({ question, basis: [edgeOf(question.id + '-e')] })))], { readEvidence: async () => batchFor([first], [
    eventFor(first), eventFor(second), eventFor(third, 'correct', ['kc-only']),
    eventFor(fourth), eventFor(fourth, 'incorrect', ['kc-only'], 'fourth-sub-2'),
    eventFor(fifth), eventFor(fifth, 'incorrect', ['kc-only']), eventFor(sixth),
  ], [
    anchorFor(first), anchorFor({ ...second, rev: 2 as Revision }, 'second-sub'), anchorFor(third),
    anchorFor(fourth), anchorFor(fourth, 'fourth-sub-2'), anchorFor(fifth), anchorFor(sixth), anchorFor(foreign, 'sixth-sub'),
  ]) });
  expect(anchored.clusters[0]?.members.map(({ question, state }) => [question.id, state])).toEqual([
    ['first', 'steady'], ['second', 'unknown'], ['third', 'unknown'], ['fourth', 'unknown'], ['fifth', 'unknown'], ['sixth', 'unknown']]);

  const alternate = await run([cluster([
    { question: first, basis: [witness('bad-edge', 'content.knowledgeEdge', '9' as Tick)], practiceBasis: [attemptOf('p1')] },
    { question: first, basis: [edgeOf('good-edge')] },
    { question: second, basis: [edgeOf('revoked-edge')], practiceBasis: [attemptOf('still-valid-practice')] },
    { question: second, proof: { membership: edgeOf('membership'), basis: [] } },
    { question: second, basis: [edgeOf('second-edge')], practiceBasis: [attemptOf('revoked-practice')] },
  ], null)], { readEvidence: async () => batchFor([first, second], [eventFor(first, 'incorrect')]),
    reopen: async (_scope, witnesses) => witnesses.filter(ref => !['revoked-edge', 'revoked-practice'].includes(ref.id)) });
  expect(alternate.clusters[0]).toEqual({ archetype, coveredQuestionCount: 2, counts:
    { steady: 0, due: 0, weak: 1, unknown: 1 }, members: [{ question: first, state: 'weak' }, { question: second, state: 'unknown' }] });
  let skippedPrepare = 0;
  await run([cluster([{ question: first, basis: [edgeOf('e1')] }])], { methodVersion: 'unknown@0', prepareEvidence: () => { skippedPrepare++; } });
  await run([], { prepareEvidence: () => { skippedPrepare++; } });
  expect(skippedPrepare).toBe(0);
});
