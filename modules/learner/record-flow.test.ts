import { describe, expect, it } from 'vitest';
import {
  describeBasisFact,
  indexRecordFlowSnapshot,
  projectAgentRecordFlow,
  projectRecordFlow,
  summarizeRecordFlowForList,
  type RawFlowDerivation,
  type RawFlowFact,
} from './record-flow.ts';
import { buildConceptAuthoringContext } from './authoring-context.ts';

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
    expect(flow!.nextActions.find((a) => a.kind === 'open_graph')?.href).toBe(`/materials?tab=graph&focus=${ID_CONCEPT}`);
    expect(flow!.nextActions.find((a) => a.kind === 'ask_companion')?.href).toBe(`/companion?about=${ID_CONCEPT}`);
    expect(projectRecordFlow(ID_ATTEMPT, snap)?.nextActions.find((a) => a.kind === 'ask_companion')?.href).toBe(`/companion?record=attempt&id=${ID_ATTEMPT}&rev=1`);
    expect(projectRecordFlow(ID_ISOLATED, snap)?.nextActions.find((a) => a.kind === 'ask_companion')?.href).toBe(`/companion?record=page&id=${ID_ISOLATED}&rev=1`);
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
    expect(filteredFlow?.misconceptions).toMatchObject([{ id: `error:${ID_ATTEMPT}:q1`, errorStage: 'modeling', summary: '力学摸底卷（题 q1）出现概念与建模阶段错因' }]);
    expect(filteredFlow?.graphNeighbors.some((n) => n.id === ID_PREREQ)).toBe(false);
    expect(filteredFlow?.witnessFactIds).not.toContain(ID_ASSERTION);
    expect(filteredFlow?.witnessFactIds).not.toContain(ID_PREREQ);
  });

  it('traces 1-2 hop upstream provenance, downstream derived assets, onboarding honesty, originLabel & witnessFactIds', () => {
    const ID_MATERIAL = '01ARZ3NDEKTSV4RRFFQ69G5FC1';
    const ID_DISCIPLINE = '01ARZ3NDEKTSV4RRFFQ69G5FC2';
    const ID_ONBOARD_CONCEPT = '01ARZ3NDEKTSV4RRFFQ69G5FC3';
    const ID_PAPER2 = '01ARZ3NDEKTSV4RRFFQ69G5FC4';
    const ID_ATTEMPT2 = '01ARZ3NDEKTSV4RRFFQ69G5FC5';
    const ID_NOTION = '01ARZ3NDEKTSV4RRFFQ69G5FC6';
    const ID_NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FC7';

    const snap = indexRecordFlowSnapshot([
      { id: ID_MATERIAL, type: 'activity.textMaterial', rev: 1, author: 'learner', createdTick: '1', data: { title: '高二物理月考原件' } },
      { id: ID_DISCIPLINE, type: 'content.asset', rev: 1, author: 'companion', createdTick: '2', data: { kind: 'discipline', title: '高中物理', discipline_context: { learningScope: '力学与电磁学' } } },
      { id: ID_ONBOARD_CONCEPT, type: 'content.asset', rev: 1, author: 'companion', createdTick: '3', data: { kind: 'concept', title: '动量守恒', basis: [{ id: ID_DISCIPLINE, rev: 1, type: 'content.asset' }] } },
      { id: ID_PAPER2, type: 'activity.workbookPaper', rev: 1, author: 'learner', createdTick: '4', data: { title: '月考真题卷', materialId: ID_MATERIAL, questions: [{ id: 'q1', prompt: '求速度' }] } },
      { id: ID_ATTEMPT2, type: 'activity.workbookAttempt', rev: 1, author: 'learner', createdTick: '5', data: { paperId: ID_PAPER2, submittedAt: '2026-11-24T01:00:00Z', feedback: [{ questionId: 'q1', result: 'correct' }] } },
      { id: ID_NOTION, type: 'capture.source', rev: 1, author: 'learner', createdTick: '6', data: { kind: 'notion', title: 'Notion 错题本' } },
      { id: ID_NOTE, type: 'activity.organizerNote', rev: 1, author: 'learner', createdTick: '7', data: { title: 'Notion 摘录笔记', basis: [{ id: ID_NOTION, rev: 1, type: 'capture.source' }] } },
    ], []);

    // 2-hop upstream trace: attempt -> paper -> material
    const attemptFlow = projectRecordFlow(ID_ATTEMPT2, snap)!;
    expect(attemptFlow.provenance.map((p) => [p.id, p.relation, p.originBadge, p.href])).toEqual([
      [ID_PAPER2, '对应试卷', '试卷', `/papers/${ID_PAPER2}`],
      [ID_MATERIAL, '来自原件', '原件', `/materials/saved/${ID_MATERIAL}`],
    ]);

    // Reverse downstream derived index: material -> derived paper
    const matFlow = projectRecordFlow(ID_MATERIAL, snap)!;
    expect(matFlow.derived).toMatchObject([{ id: ID_PAPER2, relation: '派生试卷', originBadge: '试卷', href: `/papers/${ID_PAPER2}` }]);

    // Onboarding concept honestly reports discipline + synthetic onboarding entry, and never leaks 'onboarding' into witnessFactIds.
    const onboardAgent = projectAgentRecordFlow(ID_ONBOARD_CONCEPT, snap)!;
    expect(onboardAgent.provenance.map((p) => [p.id, p.originBadge, p.href])).toEqual([
      [ID_DISCIPLINE, '学科', `/materials/records/${ID_DISCIPLINE}`],
      ['onboarding', '冷启动', '/onboarding'],
    ]);
    expect(onboardAgent.witnessFactIds).toContain(ID_DISCIPLINE);
    expect(onboardAgent.witnessFactIds).not.toContain('onboarding');

    // Notion provenance and list originLabel
    const summaries = summarizeRecordFlowForList([ID_PAPER2, ID_ONBOARD_CONCEPT, ID_NOTE], snap);
    expect(summaries[ID_PAPER2]?.originLabel).toBe('来自原件：高二物理月考原件');
    expect(summaries[ID_ONBOARD_CONCEPT]?.originLabel).toBe('所属学科：高中物理');
    expect(summaries[ID_NOTE]?.originLabel).toBe('来自 Notion：Notion 错题本');
  });

  it('describes workspaceBasis fact titles (clipped <= 48 chars) and semantic kinds', () => {
    expect(describeBasisFact('content.asset', { kind: 'concept', canonicalName: '链式法则' })).toEqual({ title: '链式法则', kind: 'concept' });
    expect(describeBasisFact('content.asset', { kind: 'discipline', title: '高等数学' })).toEqual({ title: '高等数学', kind: 'discipline' });
    expect(describeBasisFact('activity.workbookPaper', { title: '高二物理月考真题卷' })).toEqual({ title: '高二物理月考真题卷', kind: 'paper' });
    expect(describeBasisFact('activity.textMaterial', { title: '导数讲义 PDF' })).toEqual({ title: '导数讲义 PDF', kind: 'material' });
    expect(describeBasisFact('companion.memoryAssertion', { text: '经常在复合函数求导时漏乘内层导数，需要反复练习'.repeat(3) })).toEqual({
      title: `${'经常在复合函数求导时漏乘内层导数，需要反复练习'.repeat(3).slice(0, 47)}…`,
      kind: 'misconception',
    });
    expect(describeBasisFact('unknown.type', {})).toEqual({});
  });

  it('excludes D10 carePause crisis turns from record discussions, provenance, and direct projection', () => {
    const ID_CRISIS = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
    const snap = indexRecordFlowSnapshot(
      [...sampleFacts, { id: ID_CRISIS, type: 'activity.studyTurn', rev: 1, author: 'learner', createdTick: '99',
        data: { sessionId: ID_CRISIS, answer: '绝不外泄的危机原话', currentObject: { kind: 'concept', id: ID_CONCEPT } } }],
      [...sampleDerivations, { id: 'd-crisis', slotType: 'activity.teachingFeedback', slotKey: ID_CRISIS,
        value: { message: '危机转介卡片', carePause: { active: true, scope: 'nudges_and_paid_background' } } }],
    );
    expect(projectRecordFlow(ID_CRISIS, snap)).toBeNull();
    expect(projectRecordFlow(ID_CONCEPT, snap)!.discussions.map((d) => d.turnId)).toEqual([ID_TURN]);
    expect(projectAgentRecordFlow(ID_CONCEPT, snap)?.witnessFactIds).not.toContain(ID_CRISIS);
    const authoring = buildConceptAuthoringContext({ conceptId: ID_CONCEPT }, snap);
    expect([...authoring.stickingPoints, ...authoring.sourceSnippets].map(item => item.id)).not.toContain(ID_CRISIS); expect(authoring.witnessFactIds).not.toContain(ID_CRISIS);
  });
  it('builds bounded Chinese authoring context from an attempt and rejects missing sources', () => {
    const context = buildConceptAuthoringContext({ attemptId: ID_ATTEMPT }, indexRecordFlowSnapshot(sampleFacts, sampleDerivations));
    expect(context).toMatchObject({ mode: 'mistake_variant', hasSufficientBasis: true, concept: { id: ID_CONCEPT }, mastery: { forgettingTrend: 'urgent' }, sourceQuestion: { id: ID_QUESTION, prompt: '求加速度', attemptId: ID_ATTEMPT, errorStageLabel: '概念与建模' }, mistakes: [{ questionPrompt: '求加速度', errorStageLabel: '概念与建模' }], existingQuestionPrompts: ['求加速度'] });
    expect(context.witnessFactIds).toEqual(expect.arrayContaining([ID_CONCEPT, ID_QUESTION, ID_PAPER, ID_ATTEMPT]));
    expect(context.witnessFactIds).not.toContain('onboarding');
    expect(buildConceptAuthoringContext({ attemptId: 'missing' }, indexRecordFlowSnapshot(sampleFacts, sampleDerivations))).toMatchObject({ hasSufficientBasis: false, emptyReason: 'source_question_not_found' });
  });
});

it('邻接概念不污染掌握度、独立卷面行不串入概念视图、冻结卷回退且正式评卷新字段生效', () => {
  const f = (id: string, type: string, tick: string, data: unknown): RawFlowFact => ({ id, type, rev: 1, author: 'test', createdTick: tick, data });
  const facts2 = [f('ca', 'content.asset', '1', { kind: 'concept', title: '概念A' }), f('cb', 'content.asset', '1', { kind: 'concept', title: '概念B' }), f('qa', 'content.asset', '1', { kind: 'question', title: '源题' }), f('e1', 'content.knowledgeEdge', '1', { kind: 'targets_concept', from: { kind: 'question', sourceUse: { id: 'qa' } }, to: { kind: 'concept', sourceUse: { id: 'ca' } } }), f('e2', 'content.knowledgeEdge', '1', { kind: 'prereq_of', from: { kind: 'concept', sourceUse: { id: 'cb' } }, to: { kind: 'concept', sourceUse: { id: 'ca' } } }), f('pp', 'activity.workbookPaper', '2', { title: '卷', questions: [{ id: 'qq1', prompt: 'p', sourceQuestionRef: { id: 'qa', rev: 1 } }, { id: 'qq2', prompt: '独立题' }] }), f('aa', 'activity.workbookAttempt', '3', { paperId: 'pp', submittedAt: '2026-11-20T10:00:00Z', feedback: [{ questionId: 'qq1', result: 'correct' }, { questionId: 'qq2', result: 'incorrect' }] }), f('ae', 'activity.workbookAttempt', '4', { submittedAt: '2026-11-20T11:00:00Z', paper: { questions: [{ id: 'qe1', prompt: 'p', sourceQuestionRef: { id: 'qa', rev: 1 } }] }, feedback: [{ questionId: 'qe1', result: 'correct' }] })];
  const snap2 = indexRecordFlowSnapshot(facts2, [{ id: 'fa1', slotType: 'activity.workbookFormalAssessment', slotKey: 'ae', value: { result: { submissionRef: { id: 'ae' }, outcomes: [{ questionId: 'qe1', verdict: 'incorrect', errorStage: 'execution' }] } } }]);
  const flow = projectRecordFlow('ca', snap2)!;
  expect([flow.attempts.map(a => a.itemId), flow.attempts.map(a => a.verdict), flow.mastery.evidenceCount, flow.attempts[0]?.errorStage]).toEqual([['qe1', 'qq1'], ['incorrect', 'correct'], 2, 'execution']);
});

it('错题变式上下文按源题精确命中对应题项并从 blocks 提取答案解析', () => {
  const f = (id: string, type: string, tick: string, data: unknown): RawFlowFact => ({ id, type, rev: 1, author: 'test', createdTick: tick, data });
  const facts3 = [f('qs', 'content.asset', '1', { kind: 'question', title: '目标题', promptBlockId: 'p', blocks: [{ id: 'p', body: { text: '题干' } }, { id: 'ans', body: { text: '参考答案：42\n解析：先拆分条件' } }] }), f('qo', 'content.asset', '1', { kind: 'question', title: '其它题' }), f('p2', 'activity.workbookPaper', '2', { title: '多题卷', questions: [{ id: 'i1', prompt: '其它', sourceQuestionRef: { id: 'qo', rev: 1 } }, { id: 'i2', prompt: '目标', sourceQuestionRef: { id: 'qs', rev: 1 } }] }), f('ax', 'activity.workbookAttempt', '3', { paperId: 'p2', submittedAt: '2026-11-20T10:00:00+08:00', feedback: [{ questionId: 'i1', result: 'incorrect' }, { questionId: 'i2', result: 'incorrect' }] })];
  const ctx = buildConceptAuthoringContext({ attemptId: 'ax', sourceQuestionId: 'qs' }, indexRecordFlowSnapshot(facts3, []));
  expect([ctx.sourceQuestion?.itemId, ctx.sourceQuestion?.answer, ctx.sourceQuestion?.explanation, ctx.sourceQuestion?.verdict]).toEqual(['i2', '42', '先拆分条件', 'incorrect']);
});
