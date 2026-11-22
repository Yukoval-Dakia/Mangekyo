import { describe, expect, it } from 'vitest';
import type { BusWitness, FactId, Tick } from '@mangekyo/kernel';
import { graphMasterySources } from './graph-mastery-evidence.ts';
import type { ConceptEvidenceRow } from './concept-evidence.ts';

const id = (text: string) => text as FactId;
const rev = 1 as unknown as BusWitness['rev'];
const witness = (value: {id: FactId; type: string; rev?: BusWitness['rev']}) => ({
  learner: 'learner', id: value.id, rev: value.rev ?? rev, type: value.type, accessEpoch: '1' as Tick, mode: 'pinned' as const,
});

function sources(rows: readonly ConceptEvidenceRow[], missing?: string) {
  const isUnavailable = (error: unknown) => error instanceof Error && error.name === 'FactReadDeniedError';
  const counts = {fact: 0};
  const read = {async fact(value: FactId, _options: unknown) {
    counts.fact++;
    if (value === missing) throw Object.assign(new Error('denied'), {name: 'FactReadDeniedError'});
    return {ref: {learner: 'learner', id: value, rev}, type: 'x', accessEpoch: '1', value: {}, purpose: []} as never;
  }};
  return {counts, source: graphMasterySources({
    tx: {learner: 'learner' as never, query: async () => ({rows: []})} as never,
    links: [], read,
    python: {derive: async () => undefined}, reopen: async refs => refs, isUnavailable,
    evidence: {attempts: rows, incompleteConceptIds: new Set()},
  })};
}

describe('graphMasterySources', () => {
  it('keeps true help levels and fail-closes only affected concepts when an anchor is unavailable', async () => {
    const attempt = (conceptId: string, helpLevel: ConceptEvidenceRow['helpLevel']) => ({
      conceptId: id(conceptId), submission: {id: id(`${conceptId}-sub`), rev, type: 'activity.posttestSubmission'},
      questionId: id(`${conceptId}-q`), questionRev: rev, occurredAt: '2026-11-20T00:00:00.000Z', recordedTick: '2' as Tick,
      outcome: 'correct' as const, exposure: helpLevel === 'unknown' ? 'unknown' as const : 'independent' as const, helpLevel, basisRefs: [],
    });
    const {source, counts} = sources([attempt('healthy', 'hinted'), attempt('broken', 'independent')], 'broken-q');
    const batch = await source.readEvidence({learner: 'learner' as never, purpose: 'teaching', recipientId: 'learner', asOf: '2026-11-21T00:00:00.000Z',
      clockWatermark: '4' as Tick}, ['healthy', 'broken', 'empty']);
    expect(batch).not.toBeNull();
    expect(batch?.slice.events).toEqual([expect.objectContaining({ref: 'healthy-sub', help_level: 'hinted'})]);
    expect(batch?.anchors).toHaveLength(1);
    expect(batch?.completeConceptIds).toEqual(['healthy', 'empty']);
    expect(counts.fact).toBeGreaterThan(0);
  });
});
