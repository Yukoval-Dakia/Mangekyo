import { expect, it } from 'vitest';
import { projectSessionClosure, type SessionClosureEvidence } from './session-closure.ts';

it('counts only same-session revisions, preserving missing evidence and hidden text', () => {
  const ref = { id: 'workbook-attempt', rev: 2 };
  const evidence: SessionClosureEvidence = { submissions: [{ ref, items: null }],
    refutations: [{ submission: ref, hypothesisId: 'one', oldStep: null },
      { submission: { ...ref, rev: 1 }, hypothesisId: 'two', oldStep: 'previous attempt' }],
    blockers: [], openThoughtIds: ['open', 'open'] };
  expect(projectSessionClosure(evidence)).toEqual({ stabilized: null, contradicted: 1,
    refutedSteps: null, blocker: null, blockerKnown: true, openThoughts: 1 });
  expect(projectSessionClosure({ ...evidence, submissions: [], refutations: [] }))
    .toMatchObject({ stabilized: 0, contradicted: 0, refutedSteps: [] });
});
