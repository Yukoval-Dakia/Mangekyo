import { expect, it } from 'vitest';
import type { BusWitness, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import { archetypeQuestionConceptId, projectArchetypeMastery, type ArchetypeMasterySources } from './archetype-mastery.ts';
import type { TextbookMasteryEvidenceBatch } from './textbook-mastery.ts';

const learner = 'learner' as LearnerId;
const now = '2026-11-21T00:00:00.000Z';
const watermark = '1' as Tick;
const witness = (id: string, type = 'content.question'): BusWitness =>
  ({ learner, id: id as BusWitness['id'], rev: 1 as Revision, accessEpoch: '0' as Tick, type, mode: 'pinned' });
const scope = { learner, purpose: 'teaching', recipientId: 'recipient', asOf: now, clockWatermark: watermark };
const archetype = witness('archetype', 'content.asset');
const first = witness('first');
const second = witness('second');
const deniedPath = [witness('denied-path', 'content.knowledgeEdge')];
const activity = witness('activity', 'activity.workbookAttempt');
const anchors = [first, second].map(question => ({
  submission: witness(question.id + '-submission', 'activity.workbookAttempt'),
  question, itemId: question.id, href: '/' + question.id, recordedAt: watermark,
  basis: [witness(question.id + '-basis', 'content.examItem')],
}));
const batch: TextbookMasteryEvidenceBatch = { slice: {
  clock_watermark: watermark, as_of_at: now, constraints: { budget_min: null, locks: [], deadlines: [] },
  candidate_pool: [], events: [],
}, anchors };
const sources = (allowedIds: readonly string[], expectedQuestions = [first, second]): ArchetypeMasterySources => ({
  readEvidence: async (_scope, questions) => {
    expect(questions).toEqual(expectedQuestions);
    return batch;
  },
  derive: async (_scope, _method, slice) => {
    expect(slice.events).toEqual([]);
    return { method_version: 'cognition@3', state: 'unknown', state_vector: [...new Set(slice.events.map(event =>
      event.concept_ids.find(Boolean)!))].map(concept_id => ({
      concept_id, item_novelty: 'same', representation: null, context: null, method: null,
      state: 'unknown', uncertainty: { kind: 'unknown', reason: 'missing-independent-scored-evidence', needed: 'independent evidence' },
      evidence_refs: [],
    })) };
  },
  reopen: async (_scope, witnesses) => witnesses.filter(ref => allowedIds.includes(ref.id)),
});
const cluster = (members: readonly { question: BusWitness; basis: readonly BusWitness[]; practiceBasis?: readonly BusWitness[] }[]) =>
  ({ kind: 'archetype' as const, archetype, title: '一元二次方程', members });

it('batch-reads exact questions, removes revoked members, and gates practice on Activity permission', async () => {
const authorized = [archetype, first, second, activity, witness('first-basis', 'content.knowledgeEdge'),
    witness('second-basis', 'content.knowledgeEdge'), ...anchors.flatMap(anchor => [anchor.submission, ...anchor.basis])]
    .map(ref => ref.id);
  const view = await projectArchetypeMastery({ ...scope, clusters: [cluster([
    { question: first, basis: [witness('first-basis', 'content.knowledgeEdge')], practiceBasis: [activity] },
    { question: second, basis: [witness('second-basis', 'content.knowledgeEdge')], practiceBasis: [activity] },
  ])] }, {
    ...sources(authorized),
    readEvidence: async (_scope, questions) => {
      expect(questions).toEqual([first, second]);
      return batch;
    },
  });
  expect(view).toEqual({ asOf: now, clusters: [{
    archetype, title: '一元二次方程', coveredQuestionCount: 2,
    members: [{ question: first, state: 'unknown' }, { question: second, state: 'unknown' }],
    counts: { steady: 0, due: 0, weak: 0, unknown: 2 },
    representative: { question: first, state: 'unknown' },
  }] });
  expect(view.clusters[0]?.representative?.question.id).toBe('first');
  expect(await projectArchetypeMastery({ ...scope, clusters: [cluster([
    { question: first, basis: [witness('first-basis', 'content.knowledgeEdge')] },
  ])] }, sources([archetype.id, first.id, 'first-basis', ...anchors.map(anchor => anchor.submission.id)], [first])))
    .toEqual({ asOf: now, clusters: [{
      archetype, title: '一元二次方程', coveredQuestionCount: 1,
      counts: { steady: 0, due: 0, weak: 0, unknown: 1 }, members: [{ question: first, state: 'unknown' }],
    }] });
  expect(archetypeQuestionConceptId(first)).toBe('archetype-mastery/first/1');
});
