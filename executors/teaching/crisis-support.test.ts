import {expect, it} from 'vitest';
import {
  carePauseSignal,
  companionCrisisGuidance,
  evaluateCrisisSupport,
  isSelfCrisisExpression,
} from './crisis-support.ts';
import {runCompanionTurn} from './index.ts';
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
