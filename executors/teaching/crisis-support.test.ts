import {expect, it, vi} from 'vitest';
import type {FactId, Tick} from '@mangekyo/kernel';
import {
  carePauseSignal,
  companionCrisisGuidance,
  evaluateCrisisSupport,
  isSelfCrisisExpression,
} from './crisis-support.ts';
import {runCompanionTurn} from './index.ts';
import {executeCompanionTurn} from './turn-companion.ts';
import {companionForegroundSummary, walkCompanionHistory, type GuardableTurn, type HistoryReply} from './turn-context.ts';
import type {TurnWorkspaceWitness} from './turn-witness.ts';
import {bodyOf, chatReply, deps, watchFetch} from './test/chat.ts';

it.each([
  '我想要自杀。',
  '我不想活了。',
  'I want to kill myself.',
  "I don't want to live anymore.",
])('gives offline support and the minimal pause signal for %j', async question => {
  const result = await runCompanionTurn(question, [], undefined,
    {...deps, runEffect: () => { throw new Error('unexpected model effect'); }});
  expect(result.message).toContain('你现在不用一个人扛');
  expect(result.carePause).toEqual(carePauseSignal);
  expect(JSON.stringify(result.carePause)).not.toContain(question);
  expect(result.message).not.toMatch(/\d{3,}/);
  expect(result.message).toContain('不会自动联系家长、老师、警方或其他第三方');
  expect(result.message).toContain('不会创建永久“高危学习者”档案');
});

it.each([
  '题目说：“我想自杀”，这个叙述者为什么这样写？',
  '文章中主人公说他想结束自己的生命，请分析主题。',
  '历史上有人自杀，这道题问原因。',
  '小说里的主角写道："I want to die." 请解释伏笔。',
  '有同学说他们班有人自残，我该怎么安慰他？',
])('does not trigger for cited or third-person tragedy %j', async question => {
  expect(isSelfCrisisExpression(question)).toBe(false);
  expect(evaluateCrisisSupport(question)).toBeUndefined();
  const send = watchFetch().mockResolvedValue(chatReply('回到这段材料的学习语境。'));
  const result = await runCompanionTurn(question, [], undefined, deps);
  expect(result.carePause).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(1);
});

it('returns the explicit offline help card without a model or network call', async () => {
  const support = evaluateCrisisSupport('需要帮助');
  const result = await runCompanionTurn('需要帮助', [], undefined,
    {...deps, runEffect: () => Promise.reject(new Error('unexpected effect'))});
  expect(support?.source).toBe('offline_help_request');
  expect(support?.supportCard).toMatchObject({version:'d10-crisis-support-v1', title:'需要帮助',
    noAutomaticThirdPartyContact:true, noPermanentProfile:true, noHarmContent:true});
  expect(result.carePause).toEqual({triggered:true, reason:'self_crisis_support', scope:'nudges_and_paid_background'});
  expect(JSON.stringify(support)).not.toMatch(/\d{3,}/);
});

it('adds D10 guidance to the single companion prompt without a review model call', async () => {
  const send = watchFetch().mockImplementation(async (_url, init) => {
    const body = bodyOf(init);
    expect(body.messages[0].content).toContain(companionCrisisGuidance);
    expect(companionCrisisGuidance).toContain('不新增前置审查链');
    expect(companionCrisisGuidance).toContain('不读取“仅保存”材料');
    expect(companionCrisisGuidance).toContain('不是学生本人危机');
    return chatReply('我们先看题意。');
  });
  const result = await runCompanionTurn('请解释这道题。', [], undefined, deps);
  expect(result).toEqual({message:'我们先看题意。', reportedModel:'auto/deepseek-v4.1-flash'});
  expect(send).toHaveBeenCalledTimes(1);
});

it('short-circuits classroom crisis before any read or classroom parsing', async () => {
  const boom = () => { throw new Error('unexpected read'); };
  const ports = new Proxy({}, {get: () => boom}) as never;
  const feedback = await executeCompanionTurn({
    slotKey: 't', slotType: 's', learningV1: false, grants: [], mcpServers: [], memoryId: 'mem',
    submission: {caseId: 'companion', sessionId: 's1', baseUrl: 'u', model: 'm', answer: '我不想活了。', classroom: {mode: 'start'}},
    settings: {baseUrl: 'u', model: 'm', protocol: 'openai', reasoningEffort: 'default', apiKey: '', activeProviderId: 't', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false}, ridingLesson: {title: '', distanceKm: 0, movingMinutes: 0, stoppedMinutes: 0},
    averageSpeed: () => 0, onProgress: boom, runEffect: boom, ledger: {} as never,
  }, ports);
  expect(feedback.message).toContain('你现在不用一个人扛');
  expect(feedback.carePause).toEqual(carePauseSignal);
  expect(feedback.reads).toEqual([]);
  expect(feedback.workspaceBasis).toBeUndefined();
  expect((feedback as {classroomPlan?: unknown}).classroomPlan).toBeUndefined();
  expect(companionForegroundSummary(feedback, 2)).toBeUndefined();
});

it('omits a crisis turn from companion history and manifest retain', async () => {
  const settings = {baseUrl:'u', model:'m', protocol:'openai' as const, reasoningEffort:'high', apiKey:'', activeProviderId:'default', providers:[], mcpServers:[], exaApiKey:'', allowSearch:false};
  const turn = (answer: string, parentId?: string): GuardableTurn => ({caseId:'companion', sessionId:'s', answer, parentId, baseUrl:'u', model:'m'});
  const turns = {t1: turn('什么是勾股定理？'), t2: turn('我不想活了。', 't1'), t3: turn('我好多了，帮我看看这道数学题', 't2')};
  const reply = (id: string, message: string, carePause?: unknown): HistoryReply<TurnWorkspaceWitness> => ({id, manifest: {inputs: []}, memoryBasis: {ids: new Set(), objects: []}, value: {action: 'companion_reply', message, carePause, reads: []}});
  const replies = {t1: reply('r1', '直角三角形两直角边平方和等于斜边平方。'), t2: reply('r2', '需要帮助时告诉我。', carePauseSignal)}, trackFact = vi.fn(), trackFeedback = vi.fn();
  const history = await walkCompanionHistory(
    {submission: turns.t3, settings, grants: [], memoryId: 'mem', slotType: 'reply'},
    {readPriorTurn: async id => ({ref: {id: id as FactId, rev: 1}, accessEpoch: '0' as Tick, data: turns[id as keyof typeof turns]}), readReply: async id => replies[id as keyof typeof replies],
     savedNotionWitnesses: async (): Promise<readonly TurnWorkspaceWitness[]> => [], isAssessmentSlot: () => false, isRetentionSlot: () => false, readAssessmentBasis: async () => undefined, readRetentionBasis: async () => undefined,
     confirmNotionSend: async () => undefined, proofKey: witness => witness.id, trackFact, trackAssessment: vi.fn(), trackRetention: vi.fn(), trackNotion: vi.fn(), trackFeedback});
  history.retain.forEach(fn => fn());
  expect(history.messages).toEqual([{role:'user', content:'什么是勾股定理？'}, {role:'assistant', content:'直角三角形两直角边平方和等于斜边平方。'}]);
  expect([trackFact, trackFeedback].map(mock => mock.mock.calls.map(call => call[0]))).toEqual([['t1'], ['t1']]);
});
