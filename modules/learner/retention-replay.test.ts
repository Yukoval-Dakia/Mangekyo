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
  expect(freezeCognition({ ...input, target: { ...input.target, condition: 'variant' } }, output).estimate.kind).toBe('unknown');
});
