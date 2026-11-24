import { describe, expect, it } from 'vitest';
import {
  collectGraphConceptSources,
  indexRecordFlowSnapshot,
  projectAgentRecordFlow,
  projectLearnerModelFlowSignals,
  projectRecordFlow,
  type RawFlowDerivation,
  type RawFlowFact,
} from '../learner/record-flow.ts';
import { projectGraphAndBankCandidates } from './graph-candidates.ts';
import type { PlanRule } from './rules.ts';
import { planToday } from './today.ts';

const ID_CONCEPT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_PREREQ = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ID_QUESTION = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const ID_PAPER = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const ID_ATTEMPT = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
const ID_ASSERTION = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const ID_TURN = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const ID_SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const ID_NEW_CONCEPT = '01ARZ3NDEKTSV4RRFFQ69G5FB3';

const facts: RawFlowFact[] = [
  { id: ID_CONCEPT, type: 'content.asset', rev: 2, author: 'companion', createdTick: '10', data: { kind: 'concept', title: '电磁感应定律', subject: '物理' } },
  { id: ID_PREREQ, type: 'content.asset', rev: 1, author: 'learner', createdTick: '9', data: { kind: 'concept', title: '磁通量变化', subject: '物理' } },
  { id: ID_NEW_CONCEPT, type: 'content.asset', rev: 1, author: 'companion', createdTick: '11', data: { kind: 'concept', title: '化学平衡移动', subject: '化学' } },
  { id: ID_QUESTION, type: 'content.asset', rev: 1, author: 'learner', createdTick: '12', data: { kind: 'question', title: '导轨切割磁感线', subject: '物理' } },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FB4', type: 'content.knowledgeEdge', rev: 1, author: 'companion', createdTick: '13', data: { kind: 'prereq_of', from: { kind: 'concept', sourceUse: { id: ID_PREREQ } }, to: { kind: 'concept', sourceUse: { id: ID_CONCEPT } } } },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FB5', type: 'content.knowledgeEdge', rev: 1, author: 'companion', createdTick: '14', data: { kind: 'targets_concept', from: { kind: 'question', sourceUse: { id: ID_QUESTION } }, to: { kind: 'concept', sourceUse: { id: ID_CONCEPT } } } },
  { id: ID_PAPER, type: 'activity.workbookPaper', rev: 1, author: 'learner', createdTick: '15', data: { title: '电磁专题卷', materialId: null, savedAt: '2026-11-23T11:00:00Z', questions: [{ id: 'q1', prompt: '求感应电动势', sourceQuestionRef: { id: ID_QUESTION, rev: 1 } }] } },
  { id: ID_ATTEMPT, type: 'activity.workbookAttempt', rev: 1, author: 'learner', createdTick: '16', data: { paperId: ID_PAPER, submittedAt: '2026-11-23T11:30:00Z', feedback: [{ questionId: 'q1', result: 'incorrect' }] } },
  { id: ID_ASSERTION, type: 'companion.memoryAssertion', rev: 1, author: 'companion', createdTick: '17', data: { text: '应用楞次定律时容易把阻碍变化当成阻止变化', scope: { subject: '物理' }, links: [{ kind: 'concept', id: ID_CONCEPT }], evidence: [{ id: ID_ATTEMPT, rev: 1, itemId: 'q1', direction: 'support' }] } },
  { id: ID_TURN, type: 'activity.studyTurn', rev: 1, author: 'learner', createdTick: '18', data: { sessionId: ID_SESSION, answer: '感应电流方向还是容易判反', attachment: { id: ID_CONCEPT, title: '电磁感应定律' } } },
];

const derivations: RawFlowDerivation[] = [
  { id: 'd1', slotType: 'activity.workbookRubricAssessment', slotKey: `${ID_ATTEMPT}:q1`, value: { attemptId: ID_ATTEMPT, paperId: ID_PAPER, questionId: 'q1', verdict: 'incorrect', errorStage: 'concept', score: { earned: 2, maximum: 10 } } },
  { id: 'd2', slotType: 'activity.teachingFeedback', slotKey: ID_TURN, value: { message: '先判断原磁通量增减，再用增反减同确定感应磁场方向。', evidenceIds: [ID_CONCEPT] } },
  { id: 'd3', slotType: 'predict.forecast', slotKey: `${ID_PAPER}:q1`, effectiveTick: '20', value: { target: { paper: { id: ID_PAPER }, itemId: 'q1', dimensions: { kcId: ID_CONCEPT } }, prediction: { probability: 0.38 } } },
];

describe('Track CHAIN-1 end-to-end event chain: RecordFlow -> Agent flow -> /today scheduler', () => {
  it('propagates wrong attempt + concept edges + companion turn into Agent open_learning/read_context and /today candidates', () => {
    const snap = indexRecordFlowSnapshot(facts, derivations);

    // 1. RecordFlowView chains all surfaces together.
    const view = projectRecordFlow(ID_CONCEPT, snap);
    expect(view?.mastery).toEqual({ level: 'fragile', score: 0, retrievability: 0.38, evidenceCount: 2 });

    // 2. Agent `open_learning` receives compact structured `flow` block.
    const agentFlow = projectAgentRecordFlow(ID_CONCEPT, snap);
    expect(agentFlow).not.toBeNull();
    expect(agentFlow!.misconceptions[0]?.errorStage).toBe('concept');
    expect(agentFlow!.recentAttempts[0]?.verdict).toBe('incorrect');
    expect(agentFlow!.graphNeighbors.map((n) => n.title)).toContain('磁通量变化');
    expect(agentFlow!.relatedDiscussions[0]?.href).toBe(`/companion?session=${ID_SESSION}`);

    // 3. Agent `read_context` `learner_model` receives focus & fragile flow signals with real witness IDs.
    const signals = projectLearnerModelFlowSignals([], snap, 3);
    expect(signals[0]?.id).toBe(ID_CONCEPT);
    expect(signals[0]?.witnessFactIds).toEqual(expect.arrayContaining([ID_CONCEPT, ID_ASSERTION, ID_ATTEMPT, ID_TURN]));

    // 4. `/today` scheduler consumes concept graph + bank questions + exam scope rules.
    const rules: PlanRule[] = [
      { kind: 'exam', date: '2026-12-01', scope: ['物理', '化学'], weights: [{ topic: '物理', weight: 60 }, { topic: '化学', weight: 40 }] },
      { kind: 'progress', topic: '电磁感应定律', stage: 'current' },
    ];
    const conceptCandidates = projectGraphAndBankCandidates(collectGraphConceptSources(snap), rules);
    expect(conceptCandidates[0]).toMatchObject({
      id: `concept:${ID_CONCEPT}@2`,
      kind: 'review',
      open: { kind: 'activity', id: ID_CONCEPT, rev: 2 },
    });
    expect(conceptCandidates.some((c) => c.id === `concept:${ID_NEW_CONCEPT}@1` && c.kind === 'probe')).toBe(true);

    const planned = planToday({
      now: '2026-11-24T01:00:00Z',
      timeZone: 'Asia/Shanghai',
      constraints: { budget_min: 20, locks: [], deadlines: [] },
      rules,
      candidates: conceptCandidates,
      includeBuiltinPacks: false,
    });
    expect(planned.items[0]?.candidate.id).toBe(`concept:${ID_CONCEPT}@2`);
    expect(planned.shortlist.every((id) => !id.startsWith('pack/'))).toBe(true);

    const empty = planToday({
      now: '2026-11-24T01:00:00Z',
      timeZone: 'Asia/Shanghai',
      constraints: { budget_min: 20, locks: [], deadlines: [] },
      rules: [],
      candidates: [],
      includeBuiltinPacks: false,
    });
    expect(empty.items).toEqual([]);
    expect(empty.shortlist).toEqual([]);
  });
});
