import { projectClassroomRadar } from './classroom-radar.ts';
import { expect, it } from 'vitest';
import type { CanonicalEvidenceSliceV1, FactId, Revision, Tick } from '@mangekyo/kernel';
import { freezeCognition, retentionSlice, type RetentionInput } from './retention.ts';

it('binds the frozen cutoff and selects only the exact target from a multi-dimensional result', () => {
  const clock = '9007199254740997' as Tick, now = '2026-11-21T00:00:00.000Z';
  const canonicalEvidence: CanonicalEvidenceSliceV1 = { clock_watermark: clock, as_of_at: now,
    events: [{ ref: 'answer-b', rev: 2, occurred_at: now, concept_ids: ['K'], item_novelty: 'transfer',
      context: 'field', help_level: 'independent', outcome: 'correct', claim_ids: [] }],
    constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] };
  const input: RetentionInput = { target: { paper: { id: 'p' as FactId, rev: 1 as Revision }, itemId: 'b',
    activity: 'frozen-workbook-item', gradingVersion: '1', condition: 'fresh-context',
    dimensions: { kcId: 'K', context: 'field' } }, window: { requestedAt: now, through: now }, observedThrough: clock,
    observations: [], canonicalEvidence };
  expect(retentionSlice(input)).toBe(canonicalEvidence);
  expect(() => retentionSlice({ ...input, observedThrough: '2' as Tick })).toThrow(/cutoff/);
  const row = { state: 'known' as const, concept_id: 'K', item_novelty: 'transfer', representation: null, context: 'field',
    method: null, r_now: 0.7, effective_evidence: 2, evidence_refs: [{ ref: 'answer-b', rev: 2 }],
    uncertainty: { kind: 'interval' as const, low: 0.2, high: 0.8 } };
  const output = { method_version: 'cognition@1', state_vector: [{ ...row, context: 'class', r_now: 0.4 }, row] };
  expect(freezeCognition(input, output).estimate).toMatchObject({ kind: 'probabilistic', probability: 0.7 });
  expect(() => freezeCognition(input, { ...output, state_vector: [{ ...row,
    evidence_refs: [...row.evidence_refs, { ref: 'answer-b', rev: 1 }] }] })).toThrow(/frozen target/);
  expect(freezeCognition({ ...input, target: { ...input.target, condition: 'variant' } }, output).estimate.kind).toBe('unknown');
});

it('scopes only witnessed exact-item submissions to an unclassified target, preserving the raw slice', () => {
  const now = '2026-11-20T00:00:00Z', rev = 2 as Revision, tick = '4' as Tick;
  const event = { ref: 'a', rev, occurred_at: now, item_novelty: 'same' as const, concept_ids: [],
    help_level: 'independent' as const, outcome: 'correct' as const, claim_ids: [] };
  const canonicalEvidence: CanonicalEvidenceSliceV1 = { clock_watermark: tick, as_of_at: now, events: [
    event, { ...event, rev: 1 }, { ...event, ref: 'other' }, { ...event, item_novelty: 'transfer' }],
    constraints: { budget_min: null, locks: [], deadlines: [] }, candidate_pool: [] };
  const input: RetentionInput = { target: { activity: 'frozen-workbook-item', paper: { id: 'p' as FactId, rev },
    itemId: 'q', condition: 'same-item', gradingVersion: '1' }, window: { requestedAt: now, through: now },
    observedThrough: tick, canonicalEvidence, observations: [{ submission: { id: 'a' as FactId, rev },
      admittedAt: tick, result: 'correct', submittedAt: now, exposure: { kind: 'independent' } }] };
  expect(retentionSlice(input).events.map(e => e.concept_ids)).toEqual([['frozen-item/p/2/q'], [], [], []]);
  expect(input.canonicalEvidence!.events.every(e => !e.concept_ids.length)).toBe(true);
  const exposed = {...input, observations: [{...input.observations[0]!, exposure: {kind: 'exposed' as const, refs: []}}],
    canonicalEvidence: {...canonicalEvidence, events: [{...event, help_level: 'hinted' as const}]}};
  expect(retentionSlice(exposed, 'cognition@1').events[0]!.concept_ids).toEqual([]);
  expect(retentionSlice(exposed, 'cognition@2').events[0]!.concept_ids).toEqual(['frozen-item/p/2/q']);
  const ambiguous = { ...canonicalEvidence, events: [event, { ...event, outcome: 'incorrect' as const }] };
  expect(retentionSlice({ ...input, canonicalEvidence: ambiguous }).events.every(e => !e.concept_ids.length)).toBe(true);
});

it('distinguishes an authorized empty forecast inventory from missing coverage', () => {
  const at = '2026-11-21T00:00:00.000Z';
  expect(projectClassroomRadar(at, {forecasts: []})).toMatchObject({
    weakTop3: {kind: 'value', value: []}, forgetting24h: {kind: 'value', value: 0}});
  expect(projectClassroomRadar(at, {}).forgetting24h.kind).toBe('unknown');
});
