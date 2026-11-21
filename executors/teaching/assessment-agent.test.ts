import {expect, it} from 'vitest';
import {assessWithAgent} from './assessment-agent.ts';
import {bodyOf, chatReply, deps, mockChat, toolCall, watchFetch} from './test/chat.ts';

it.each([
  ['150÷3=45', 'partial'], ['150÷3=50', 'pending'],
])('checks the grader’s quotation %s against the original answer', async (quote, expected) => {
  const value = {verdict: 'partial', checks: [
    {criterion: '总量模型', status: 'correct', reference: '用总路程除以总时间', quote},
    {criterion: '除法', status: 'incorrect', reference: '150÷3=50', quote}]};
  mockChat(() => JSON.stringify(value));
  const result = await assessWithAgent({question:'求平均速度', answer:'150÷3=45', rubric:'看模型与数值'}, deps);
  expect(result.verdict).toBe(expected);
  expect(result.evidence).toEqual(expected === 'pending' ? [] : ['150÷3=45']);
});

it('sends only the approved search topic and reuses the completed search on replay', async () => {
  const received: string[] = []; let round = 0;
  watchFetch().mockImplementation(async (url, init) => {
    if (url === 'https://api.exa.ai/search') {received.push(bodyOf(init).query);
      return Response.json({results: [{title: 'Gravity', url: 'https://example.test/reference', highlights: ['Earth attracts objects.']}]});
    }
    if (round++ === 0) return chatReply([toolCall('first', 'exa_search', {query:'private student submission'})]);
    return chatReply(JSON.stringify({verdict:'correct', checks:[{criterion:'力', status:'correct', reference:'重力', quote:'重力'}]}));
  });
  const journal = new Map<string, string>();
  const run = () => assessWithAgent({question:'力的名称？', answer:'重力', rubric:'名称正确'}, {
    ...deps, allowSearch:true, exaApiKey:'test-key', publicSearchQuery:'gravity',
    runEffect:async (step, invoke) => {
      if (!journal.has(step.requestDigest)) journal.set(step.requestDigest, await invoke(String(step.index)));
      return journal.get(step.requestDigest)!;
    }});
  const first = await run();
  expect(first.verdict).toBe('correct');
  expect(await run()).toEqual(first);
  expect(received).toEqual(['gravity']);
});

it('uses the explicit total when individual criteria also mention their maxima', async () => {
  const checks = [{criterion:'面积', status:'correct', reference:'面积为6', quote:'6', earned:2, possible:2},
    {criterion:'周长', status:'incorrect', reference:'周长为10', quote:'8', earned:0, possible:1}];
  mockChat(({messages}) => {
    expect(JSON.parse(messages.at(-1)!.content).maximum).toBe(3);
    return JSON.stringify({verdict:'partial', checks});
  });
  const result = await assessWithAgent({question:'2×3的矩形面积和周长？', answer:'6 和 8',
    rubric:'面积满分2分，周长满分1分，总分3分。'}, deps);
  expect(result.score).toEqual({earned:2, maximum:3});
});

it('keeps ordinary rubric grading to one model round', async () => {
  const fetch = mockChat(() => JSON.stringify({verdict: 'correct', checks: [
    {criterion: '除法', status: 'correct', reference: '150÷3=50', quote: '50'},
  ]}));
  const result = await assessWithAgent({question: '150÷3？', answer: '50', rubric: '商正确'}, deps);
  expect(result.verdict).toBe('correct');
  expect(fetch).toHaveBeenCalledTimes(1);
  const body = bodyOf(fetch.mock.calls[0]?.[1]);
  expect(body.messages[0].content).toContain('常规文字或数学 Rubric 不需要多余工具探测');
  expect(body.tools.map((tool: {function: {name: string}}) => tool.function.name)).toEqual(['python', 'open_tool_result']);
});

it('admits witnessed 5-value error_stage and rejects invalid or full-credit values', async () => {
  const checks = [{criterion:'除法', status:'incorrect', reference:'150÷3=50', quote:'150÷3=45'}];
  const run = (reply: object, answer = '150÷3=45') => (mockChat(() => JSON.stringify(reply)), assessWithAgent({question:'平均速度', answer, rubric:'看算式'}, deps));
  expect((await run({verdict:'partial', error_stage:'execution', checks})).errorStage).toBe('execution');
  expect((await run({verdict:'partial', checks})).errorStage).toBeUndefined();
  expect((await run({verdict:'correct', error_stage:'execution', checks:[{criterion:'答案', status:'correct', reference:'50', quote:'50'}]}, '50')).errorStage).toBeUndefined();
  expect(await run({verdict:'partial', error_stage:'guessing', checks})).toMatchObject({verdict:'pending'});
});
