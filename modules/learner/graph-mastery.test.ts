import { expect, it } from 'vitest';
import type { BusWitness, CanonicalEvidenceSliceV1, EvidenceEventV1, LearnerId, Revision, Tick } from '@mangekyo/kernel';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { snapshotFactReaders } from '../../kernel/src/commands/reads.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../kernel/test/learner-database.ts';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { factWriter, id, learner, seed, use } from './test/facts.ts';
import { projectGraphConceptMastery } from './graph-mastery.ts';
import type { TextbookMasteryEvidenceAnchor, TextbookMasteryScope } from './textbook-mastery.ts';
import type { CognitionOutput, PythonRetentionMethod } from './retention.ts';

const asOf = '2026-01-02T00:00:00.000Z', watermark = '10' as Tick;
const event = (concept: string, n: number, outcome: 'correct' | 'incorrect' | 'unknown',
    help: 'independent' | 'hinted' = 'independent', occurred = asOf): EvidenceEventV1 =>
  ({ref: id(n), rev: 1, occurred_at: occurred, concept_ids: [concept], item_novelty: 'transfer' as const,
    help_level: help, outcome, claim_ids: []});
const anchor = (ev: EvidenceEventV1, epoch = watermark): TextbookMasteryEvidenceAnchor => ({
  submission: {id: ev.ref as ReturnType<typeof id>, rev: ev.rev as ReturnType<typeof use>['rev'], learner,
    type: 'activity.workbookAttempt', mode: 'following' as const, accessEpoch: epoch},
  question: {...use(90, 'content.asset'), accessEpoch: epoch}, itemId: ev.ref, href: `/${ev.ref}`, recordedAt: epoch, basis: [],
});
const host = (events: readonly EvidenceEventV1[], omissions: CanonicalEvidenceSliceV1['omissions'] = [], deny = '') => {
  const counts = {readEvidence: 0, derive: 0, reopen: 0, prepareEvidence: 0};
  return {counts, sources: {
    prepareEvidence: () => { counts.prepareEvidence++; },
    async readEvidence(scope: TextbookMasteryScope, conceptIds: readonly string[]) { counts.readEvidence++;
      return {completeConceptIds: conceptIds, anchors: events.map(ev => anchor(ev)),
      slice: {clock_watermark: scope.clockWatermark, as_of_at: scope.asOf, events, omissions,
        constraints: {budget_min: null, locks: [], deadlines: []}, candidate_pool: []} satisfies CanonicalEvidenceSliceV1}; },
    async derive(_s: TextbookMasteryScope, method: PythonRetentionMethod, slice: CanonicalEvidenceSliceV1): Promise<CognitionOutput> {
      counts.derive++; return {method_version: method.id + '@' + method.version,
      state_vector: slice.events.filter(ev => ev.concept_ids.length && ev.help_level === 'independent' && ev.outcome !== 'unknown')
        .map(ev => ({state: 'known' as const, concept_id: ev.concept_ids[0]!, item_novelty: ev.item_novelty,
          representation: null, context: null, method: null, uncertainty: {kind: 'interval' as const, low: .1, high: .9},
          evidence_refs: [{ref: ev.ref, rev: ev.rev}],
          r_now: ev.outcome === 'incorrect' ? .45 : ev.concept_ids[0] === 'fading' ? .5 : .8}))}; },
    async reopen(_s: TextbookMasteryScope, witnesses: readonly BusWitness[]) { counts.reopen++;
      return witnesses.filter(ref => ref.id !== deny); },
  }};
};
const scope = {learner, purpose: 'teaching', recipientId: 'graph', asOf, clockWatermark: watermark};

it('maps states, evidence, proof witnesses and deduped nodes with zero N+1', async () => {
  const {counts, sources} = host([event('solid', 1, 'correct'), event('fading', 2, 'correct'), event('weak', 3, 'incorrect')]);
  const view = await projectGraphConceptMastery({...scope,
    concepts: [{conceptId: 'solid', proof: [use(80, 'content.asset')]}, {conceptId: 'solid', witness: use(80, 'content.asset')},
      {conceptId: 'fading'}, {conceptId: 'weak'}, {conceptId: 'unknown'}]}, sources);
  expect(counts).toEqual({readEvidence: 1, derive: 1, reopen: 1, prepareEvidence: 1});
  expect(view.concepts.map(({conceptId, status, retrievability, independentAttempts, lastEvidenceAt, recentEvidenceRefs}) =>
    [conceptId, status, retrievability, independentAttempts, lastEvidenceAt, recentEvidenceRefs.length])).toEqual([
    ['solid', 'solid', .8, 1, asOf, 1], ['fading', 'fading', .5, 1, asOf, 1],
    ['weak', 'weak', .45, 1, asOf, 1], ['unknown', 'unknown', null, 0, null, 0],
  ]);
  expect(view.concepts[0]!.recentEvidenceRefs[0]).toMatchObject({itemId: id(1), href: `/${id(1)}`});
});

it('fails closed for non-independent, omitted, revoked, future-epoch or foreign-learner evidence', async () => {
  const events = [event('helped', 1, 'correct', 'hinted'), event('omitted', 2, 'correct'), event('revoked', 3, 'correct'), event('future', 4, 'correct')];
  const {sources} = host(events, [{ref: {id: id(2), rev: 1}, reason: 'withheld'}], use(3, 'activity.workbookAttempt').id);
  const view = await projectGraphConceptMastery({...scope, concepts: [{conceptId: 'helped'}, {conceptId: 'omitted'}, {conceptId: 'revoked'},
    {conceptId: 'future', witness: {...use(81, 'content.asset'), accessEpoch: '11' as Tick}},
    {conceptId: 'foreign', witness: {...use(82, 'content.asset'), learner: 'other' as LearnerId}}]}, sources);
  expect(view.concepts.map(({status, retrievability, independentAttempts, recentEvidenceRefs}) =>
    [status, retrievability, independentAttempts, recentEvidenceRefs])).toEqual(Array(5).fill(['unknown', null, 0, []]));
});

it('projects real Python cognition@3 mastery on Postgres and hides revoked nodes', { timeout: 20_000 }, () =>
  withLearnerDatabase(learner, async db => {
    const python = createPythonDeriverHost();
    try {
      const apply = factWriter(db, { learner, purpose: 'teaching' });
      const nodeW = use(85, 'content.asset'), subW = use(5, 'activity.workbookAttempt'), qW = use(90, 'content.asset');
      await apply([seed(nodeW, ['teaching']), seed(subW, ['teaching']), seed(qW, ['teaching'])], 40);
      const epochs = new Map<string, string>((await db.query<{ id: string; access_epoch: string }>(
        'SELECT id, access_epoch FROM facts WHERE learner_id=$1', [learner])).rows.map(r => [r.id, String(r.access_epoch)]));
      const live = (ref: BusWitness) => ({ ...ref, accessEpoch: epochs.get(ref.id) as Tick });
      const ev = event('c-live', 5, 'incorrect', 'independent', '2026-01-01T12:00:00.000Z');
      const liveAnchor: TextbookMasteryEvidenceAnchor = { ...anchor(ev, epochs.get(subW.id) as Tick),
        submission: live(subW), question: live(qW), recordedAt: epochs.get(subW.id) as Tick };
      const req = { ...scope, clockWatermark: '999999999' as Tick, concepts: [{ conceptId: 'c-live', proof: [live(nodeW)] }] };
      const run = () => db.snapshot({ learner }, tx => projectGraphConceptMastery(req, {
        readEvidence: async (s, ids) => ({ completeConceptIds: ids, anchors: [liveAnchor],
          slice: { clock_watermark: s.clockWatermark, as_of_at: s.asOf, events: [ev],
            constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] } }),
        derive: async (_s, method, slice) => {
          const out = await python.derive(method.deriver, slice);
          return out.kind === 'ok' && out.outcome.kind === 'value' ? out.outcome.value as CognitionOutput : null;
        },
        reopen: async (_s, refs) => {
          const reader = snapshotFactReaders(tx)('teaching', () => true);
          await reader.preloadFollowing(refs.map(ref => ref.id));
          const opened: BusWitness[] = [];
          for (const ref of refs)
            if (await readable(() => reader.reopen(ref))) opened.push(ref);
          return opened;
        },
      }));
      const before = await run();
      expect(before.concepts[0]).toMatchObject({ conceptId: 'c-live', status: 'weak', independentAttempts: 1 });
      expect(before.concepts[0]!.retrievability).toBeTypeOf('number');
      await apply([{ kind: 'set_purpose', id: nodeW.id, expectedRev: 1 as Revision, purpose: ['storage'] }], 41);
      expect((await run()).concepts[0]).toMatchObject({ conceptId: 'c-live', status: 'unknown', retrievability: null, independentAttempts: 0, recentEvidenceRefs: [] });
    } finally { await python.close(); }
  }, { postgres: Boolean(testDatabaseUrl) }));

it('transitions multi-novelty (same->isomorphic) to solid and stays conservative across representations', { timeout: 20_000 }, async () => {
  const python = createPythonDeriverHost();
  try {
    const asOfMulti = '2026-11-22T00:00:00.000Z';
    const mk = (concept: string, n: number, outcome: 'correct' | 'incorrect', occurred: string,
      novelty: 'same' | 'isomorphic', representation?: string): EvidenceEventV1 =>
      ({ ref: id(n), rev: 1, occurred_at: occurred, concept_ids: [concept], item_novelty: novelty,
        ...(representation ? { representation } : {}), help_level: 'independent', outcome, claim_ids: [] });
    const events: EvidenceEventV1[] = [
      mk('c-prog', 11, 'incorrect', '2026-11-10T10:00:00.000Z', 'same'),
      mk('c-prog', 12, 'correct', '2026-11-13T10:00:00.000Z', 'isomorphic'),
      mk('c-prog', 13, 'correct', '2026-11-18T10:00:00.000Z', 'isomorphic'),
      mk('c-prog', 14, 'correct', '2026-11-21T10:00:00.000Z', 'isomorphic'),
      mk('c-rep', 15, 'incorrect', '2026-11-10T10:00:00.000Z', 'isomorphic', 'graphical'),
      mk('c-rep', 16, 'correct', '2026-11-13T10:00:00.000Z', 'isomorphic', 'symbolic'),
      mk('c-rep', 17, 'correct', '2026-11-18T10:00:00.000Z', 'isomorphic', 'symbolic'),
      mk('c-rep', 18, 'correct', '2026-11-21T10:00:00.000Z', 'isomorphic', 'symbolic'),
    ];
    const view = await projectGraphConceptMastery({ ...scope, asOf: asOfMulti,
      concepts: [{ conceptId: 'c-prog' }, { conceptId: 'c-rep' }] }, {
      readEvidence: async (s, ids) => ({ completeConceptIds: ids, anchors: events.map(ev => anchor(ev)),
        slice: { clock_watermark: s.clockWatermark, as_of_at: s.asOf, events,
          constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] } }),
      derive: async (_s, method, slice) => {
        const out = await python.derive(method.deriver, slice);
        return out.kind === 'ok' && out.outcome.kind === 'value' ? out.outcome.value as CognitionOutput : null;
      },
      reopen: async (_s, refs) => refs,
    });
    expect(view.concepts[0]).toMatchObject({ conceptId: 'c-prog', status: 'solid', independentAttempts: 4 });
    expect(view.concepts[0]!.retrievability!).toBeGreaterThan(0.6);
    expect(view.concepts[1]).toMatchObject({ conceptId: 'c-rep', status: 'fading', independentAttempts: 4 });
    expect(view.concepts[1]!.retrievability!).toBeLessThan(0.5);
  } finally { await python.close(); }
});
