import { describe, expect, it } from 'vitest';
import { selectQuestionsForConceptNode, type NodePracticeCandidate } from './node-practice.ts';

const baseNode = {
  id: 'concept-derivative',
  title: '导数与单调性',
  masteryState: 'weak' as const,
  directPrerequisiteIds: ['concept-limit'],
};

const q = (questionRef: string, overrides: Partial<NodePracticeCandidate> = {}): NodePracticeCandidate => ({
  questionRef,
  archetypeId: null,
  lastOutcome: null,
  helpLevel: null,
  lastAttemptedAt: null,
  isRedPenError: false,
  ...overrides,
});

describe('selectQuestionsForConceptNode (F4 知识图谱节点一键抽题自测)', () => {
  it('prioritizes red-pen/wrong > S11 hinted-correct > unverified high-info > oldest independent review', () => {
    const result = selectQuestionsForConceptNode({
      node: baseNode,
      now: '2026-11-22T02:00:00Z',
      limit: 5,
      candidates: [
        q('q-stale-recent', { lastOutcome: 'correct', helpLevel: 'independent', lastAttemptedAt: '2026-11-20T00:00:00Z' }),
        q('q-stale-old', { lastOutcome: 'correct', helpLevel: 'independent', lastAttemptedAt: '2026-10-01T00:00:00Z' }),
        q('q-unverified-low', { informationGain: 0.2 }),
        q('q-unverified-high', { informationGain: 0.92 }),
        q('q-hinted-ok', { lastOutcome: 'correct', helpLevel: 'hinted', lastAttemptedAt: '2026-11-21T00:00:00Z' }),
        q('q-wrong', { lastOutcome: 'incorrect', helpLevel: 'independent', lastAttemptedAt: '2026-11-19T00:00:00Z' }),
        q('q-red-pen', { lastOutcome: 'incorrect', helpLevel: 'independent', isRedPenError: true }),
      ],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.title).toBe('导数与单调性 · 节点自测');
    expect(result.questionRefs).toEqual(['q-red-pen', 'q-wrong', 'q-hinted-ok', 'q-unverified-high', 'q-unverified-low']);
    expect(result.basis.map(b => b.priority)).toEqual([
      'red-pen-error', 'unmastered-wrong', 'hinted-only-correct', 'unverified-high-info', 'unverified-high-info',
    ]);
    // Stale independent review fills when fewer urgent/unverified items exist, oldest first.
    const spaced = selectQuestionsForConceptNode({
      node: { ...baseNode, masteryState: 'solid' },
      candidates: [
        q('q-recent', { lastOutcome: 'correct', helpLevel: 'independent', lastAttemptedAt: '2026-11-20T00:00:00Z' }),
        q('q-oldest', { lastOutcome: 'correct', helpLevel: 'independent', lastAttemptedAt: '2026-10-01T00:00:00Z' }),
        q('q-mid', { lastOutcome: 'correct', helpLevel: 'independent', lastAttemptedAt: '2026-11-01T00:00:00Z' }),
      ],
    });
    expect(spaced.kind).toBe('ready');
    if (spaced.kind === 'ready') expect(spaced.questionRefs).toEqual(['q-oldest', 'q-mid', 'q-recent']);
  });

  it('folds duplicate Cap 21 archetypes, respects S11 hinted-correct, and includes direct prerequisites only', () => {
    const result = selectQuestionsForConceptNode({
      node: baseNode,
      candidates: [
        q('q-arch1-wrong', { archetypeId: 'arch-1', lastOutcome: 'incorrect', helpLevel: 'independent' }),
        q('q-arch1-variant', { archetypeId: 'arch-1', lastOutcome: 'partial', helpLevel: 'independent' }),
        q('q-arch2-hinted', { archetypeId: 'arch-2', lastOutcome: 'correct', helpLevel: 'hinted' }),
        q('q-prereq', { conceptId: 'concept-limit', archetypeId: 'arch-3', isRedPenError: true }),
        q('q-unrelated', { conceptId: 'concept-other', isRedPenError: true }),
      ],
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.questionRefs).toEqual(['q-prereq', 'q-arch1-wrong', 'q-arch2-hinted']);
    expect(result.basis.map(b => [b.questionRef, b.scope, b.priority])).toEqual([
      ['q-prereq', 'prerequisite', 'red-pen-error'],
      ['q-arch1-wrong', 'target', 'unmastered-wrong'],
      ['q-arch2-hinted', 'target', 'hinted-only-correct'],
    ]);
    expect(result.reason).toContain('折叠跳过 1 道同型变式');
  });

  it('returns honest empty fallback without fabricating questions and rejects invalid inputs', () => {
    const empty = selectQuestionsForConceptNode({
      node: baseNode,
      candidates: [q('q-unrelated', { conceptId: 'concept-other' })],
    });
    expect(empty).toEqual({
      kind: 'empty',
      suggestedAction: 'start_classroom',
      reason: '该知识点尚未收录可自测题，建议先开 10 分钟微课或拍入相关练习。',
    });
    expect(() => selectQuestionsForConceptNode({
      node: { ...baseNode, masteryState: 'invalid' as never },
      candidates: [],
    })).toThrow(/规划选项/);
    expect(() => selectQuestionsForConceptNode({
      node: baseNode,
      limit: 6,
      candidates: [],
    })).toThrow(/超出范围/);
  });
});
