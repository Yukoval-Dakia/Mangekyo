import { describe, expect, it } from 'vitest';
import {
  indexRecordFlowSnapshot,
  projectAgentRecordFlow,
  projectRecordFlow,
  summarizeRecordFlowForList,
  type RawFlowDerivation,
  type RawFlowFact,
} from './record-flow.ts';

const ID_CONCEPT = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_PREREQ = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ID_QUESTION = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const ID_PAPER = '01ARZ3NDEKTSV4RRFFQ69G5FAY';
const ID_ATTEMPT = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
const ID_ASSERTION = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const ID_TURN = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const ID_SESSION = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const ID_ISOLATED = '01ARZ3NDEKTSV4RRFFQ69G5FB3';

const sampleFacts: RawFlowFact[] = [
  { id: ID_CONCEPT, type: 'content.asset', rev: 2, author: 'companion', createdTick: '10', data: { kind: 'concept', title: '牛顿第二定律', subject: '物理', updatedAt: '2026-11-23T10:00:00Z' } },
  { id: ID_PREREQ, type: 'content.asset', rev: 1, author: 'learner', createdTick: '9', data: { kind: 'concept', title: '受力分析', subject: '物理' } },
  { id: ID_QUESTION, type: 'content.asset', rev: 1, author: 'learner', createdTick: '11', data: { kind: 'question', title: '斜面受力加速度', subject: '物理' } },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FB4', type: 'content.knowledgeEdge', rev: 1, author: 'companion', createdTick: '12', data: { kind: 'prereq_of', from: { kind: 'concept', sourceUse: { id: ID_PREREQ } }, to: { kind: 'concept', sourceUse: { id: ID_CONCEPT } } } },
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FB5', type: 'content.knowledgeEdge', rev: 1, author: 'companion', createdTick: '13', data: { kind: 'targets_concept', from: { kind: 'question', sourceUse: { id: ID_QUESTION } }, to: { kind: 'concept', sourceUse: { id: ID_CONCEPT } } } },
  { id: ID_PAPER, type: 'activity.workbookPaper', rev: 1, author: 'learner', createdTick: '14', data: { title: '力学摸底卷', materialId: null, savedAt: '2026-11-23T11:00:00Z', questions: [{ id: 'q1', prompt: '求加速度', sourceQuestionRef: { id: ID_QUESTION, rev: 1 } }] } },
  { id: ID_ATTEMPT, type: 'activity.workbookAttempt', rev: 1, author: 'learner', createdTick: '15', data: { paperId: ID_PAPER, submittedAt: '2026-11-23T11:30:00Z', feedback: [{ questionId: 'q1', result: 'incorrect' }] } },
  { id: ID_ASSERTION, type: 'companion.memoryAssertion', rev: 1, author: 'companion', createdTick: '16', data: { text: '斜面受力分解时容易漏掉正压力方向', scope: { subject: '物理' }, links: [{ kind: 'concept', id: ID_CONCEPT }], evidence: [{ id: ID_ATTEMPT, rev: 1, itemId: 'q1', direction: 'support' }] } },
  { id: ID_TURN, type: 'activity.studyTurn', rev: 1, author: 'learner', createdTick: '17', data: { sessionId: ID_SESSION, answer: '这道斜面题摩擦力方向怎么判断？', attachment: { id: ID_CONCEPT, title: '牛顿第二定律' } } },
  { id: ID_ISOLATED, type: 'activity.organizerNote', rev: 1, author: 'learner', createdTick: '18', data: { title: '零证据随手记', tags: ['计划'] } },
];

const sampleDerivations: RawFlowDerivation[] = [
  { id: 'd1', slotType: 'activity.workbookRubricAssessment', slotKey: `${ID_ATTEMPT}:q1`, value: { attemptId: ID_ATTEMPT, paperId: ID_PAPER, questionId: 'q1', verdict: 'incorrect', errorStage: 'modeling', score: { earned: 2, maximum: 10 } } },
  { id: 'd2', slotType: 'activity.teachingFeedback', slotKey: ID_TURN, value: { message: '先建立沿斜面与垂直斜面的正交坐标系，再逐一画重力、支持力与摩擦力。', evidenceIds: [ID_CONCEPT] } },
  { id: 'd3', slotType: 'predict.forecast', slotKey: `${ID_PAPER}:q1`, effectiveTick: '20', value: { target: { paper: { id: ID_PAPER }, itemId: 'q1', dimensions: { kcId: ID_CONCEPT } }, prediction: { probability: 0.42 } } },
];

describe('modules/learner/record-flow (Track FLOW-1)', () => {
  it('aggregates mastery, misconceptions, attempts, discussions, graph neighbors, and next actions across facts', () => {
    const snap = indexRecordFlowSnapshot(sampleFacts, sampleDerivations);
    const flow = projectRecordFlow(ID_CONCEPT, snap);
    expect(flow).not.toBeNull();
    expect(flow!.identity).toMatchObject({ id: ID_CONCEPT, rev: 2, kind: 'concept', title: '牛顿第二定律', subject: '物理', author: 'companion' });
    expect(flow!.mastery).toEqual({ level: 'fragile', score: 0, retrievability: 0.42, evidenceCount: 2 });
    expect(flow!.misconceptions).toHaveLength(1);
    expect(flow!.misconceptions[0]).toMatchObject({
      id: ID_ASSERTION,
      errorStage: 'modeling',
      status: 'active',
      supportCount: 1,
      contradictCount: 0,
      evidenceHref: `/papers/${ID_PAPER}?attempt=${ID_ATTEMPT}#q1`,
    });
    expect(flow!.attempts).toHaveLength(1);
    expect(flow!.attempts[0]).toMatchObject({
      paperId: ID_PAPER,
      paperTitle: '力学摸底卷',
      attemptId: ID_ATTEMPT,
      itemId: 'q1',
      verdict: 'incorrect',
      errorStage: 'modeling',
      scoreText: '2/10',
      href: `/papers/${ID_PAPER}?attempt=${ID_ATTEMPT}#q1`,
    });
    expect(flow!.discussions).toHaveLength(1);
    expect(flow!.discussions[0]).toMatchObject({
      sessionId: ID_SESSION,
      turnId: ID_TURN,
      href: `/companion?session=${ID_SESSION}`,
    });
    expect(flow!.graphNeighbors.map((n) => `${n.direction}:${n.relation}:${n.title}`).sort()).toEqual([
      'in:prereq_of:受力分析',
      'in:targets_concept:斜面受力加速度',
    ]);
    expect(flow!.nextActions.map((a) => a.kind)).toEqual(['review_mistake', 'practice', 'ask_companion', 'open_graph']);
  });

  it('stays honest with unknown/null mastery when no graded evidence exists and produces list summaries', () => {
    const snap = indexRecordFlowSnapshot(sampleFacts, sampleDerivations);
    const isolated = projectRecordFlow(ID_ISOLATED, snap);
    expect(isolated!.mastery).toEqual({ level: 'unknown', score: null, retrievability: null, evidenceCount: 0 });
    expect(isolated!.misconceptions).toEqual([]);
    expect(isolated!.attempts).toEqual([]);

    const summaries = summarizeRecordFlowForList([ID_CONCEPT, ID_ISOLATED], snap);
    expect(summaries[ID_CONCEPT]).toEqual({
      masteryLevel: 'fragile',
      errorStageCount: 1,
      attemptCount: 1,
      discussionCount: 1,
      neighborCount: 2,
      conceptTags: ['受力分析', '物理'],
    });
    expect(summaries[ID_ISOLATED]).toEqual({
      errorStageCount: 0,
      attemptCount: 0,
      discussionCount: 0,
      neighborCount: 0,
      conceptTags: ['计划'],
    });
  });

  it('outputs full witnessFactIds on projectAgentRecordFlow and never leaks excluded/unauthorized facts', () => {
    const fullSnap = indexRecordFlowSnapshot(sampleFacts, sampleDerivations);
    const fullFlow = projectAgentRecordFlow(ID_CONCEPT, fullSnap);
    expect(fullFlow?.witnessFactIds).toEqual(expect.arrayContaining([
      ID_CONCEPT, ID_PREREQ, ID_QUESTION, ID_PAPER, ID_ATTEMPT, ID_ASSERTION, ID_TURN,
      '01ARZ3NDEKTSV4RRFFQ69G5FB4', '01ARZ3NDEKTSV4RRFFQ69G5FB5',
    ]));

    // Simulate Notion/purpose filter excluding the assertion and prereq neighbor from authorized snapshot.
    const filteredSnap = indexRecordFlowSnapshot(
      sampleFacts.filter((f) => f.id !== ID_ASSERTION && f.id !== ID_PREREQ),
      sampleDerivations,
    );
    const filteredFlow = projectAgentRecordFlow(ID_CONCEPT, filteredSnap);
    expect(filteredFlow?.misconceptions.some((m) => m.id === ID_ASSERTION)).toBe(false);
    expect(filteredFlow?.graphNeighbors.some((n) => n.id === ID_PREREQ)).toBe(false);
    expect(filteredFlow?.witnessFactIds).not.toContain(ID_ASSERTION);
    expect(filteredFlow?.witnessFactIds).not.toContain(ID_PREREQ);
  });
});
