import { afterEach, expect, it, vi } from 'vitest';
import { assessWithAgent } from './assessment-agent.ts';

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['150÷3=45', 'partial'],
  ['150÷3=50', 'pending'],
])('checks the grader’s quotation %s against the original answer', async (quote, expected) => {
  const value = {verdict: 'partial', checks: [
    {criterion: '总量模型', status: 'correct', reference: '用总路程除以总时间', quote},
    {criterion: '除法', status: 'incorrect', reference: '150÷3=50', quote},
  ]};
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'auto/deepseek-v4.1-flash',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })));
  const result = await assessWithAgent({question:'求平均速度',answer:'150÷3=45',rubric:'看模型与数值'}, {
    provider:{baseUrl:'https://example.test/v1'}, runEffect: (s, call) => call(String(s.index)),
  });
  expect(result.verdict).toBe(expected);
  expect(result.evidence).toEqual(expected === 'pending' ? [] : ['150÷3=45']);
});

it('sends only the approved search topic and reuses the completed search on replay', async () => {
  const received: string[] = [];
  let round = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://api.exa.ai/search') {
      received.push(JSON.parse(String(init.body)).query);
      return Response.json({results: [{title: 'Gravity', url: 'https://example.test/reference', highlights: ['Earth attracts objects.']}]});
    }
    const message = round++ === 0 ? {role:'assistant', tool_calls: [{id:'first',type:'function',
      function:{name:'exa_search',arguments:JSON.stringify({query:'private student submission'})}}]} :
      {role:'assistant', content:JSON.stringify({verdict:'correct',checks:[{criterion:'力',status:'correct',reference:'重力',quote:'重力'}]})};
    return Response.json({model:'auto/deepseek-v4.1-flash',choices:[{message, finish_reason:round === 1 ? 'tool_calls' : 'stop'}]});
  }));
  const journal = new Map<string, string>();
  const run = () => assessWithAgent({question:'力的名称？',answer:'重力',rubric:'名称正确'}, {
    provider:{baseUrl:'https://example.test/v1'}, allowSearch:true, exaApiKey:'test-key', publicSearchQuery:'gravity',
    runEffect:async (s, call) => {
      if (!journal.has(s.requestDigest)) journal.set(s.requestDigest, await call(String(s.index)));
      return journal.get(s.requestDigest)!;
    },
  });
  const first = await run();
  expect(first.verdict).toBe('correct');
  expect(await run()).toEqual(first);
  expect(received).toEqual(['gravity']);
});

it('uses the explicit total when individual criteria also mention their maxima', async () => {
  const checks = [{criterion:'面积',status:'correct',reference:'面积为6',quote:'6',earned:2,possible:2},
    {criterion:'周长',status:'incorrect',reference:'周长为10',quote:'8',earned:0,possible:1}];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const messages = JSON.parse(String(init.body)).messages;
    expect(JSON.parse(messages.at(-1).content).maximum).toBe(3);
    return Response.json({model:'auto/deepseek-v4.1-flash',choices:[{finish_reason:'stop',
      message:{role:'assistant',content:JSON.stringify({verdict:'partial',checks})}}]});
  }));
  const result = await assessWithAgent({question:'2×3的矩形面积和周长？', answer:'6 和 8',rubric:'面积满分2分，周长满分1分，总分3分。'},
    {provider:{baseUrl:'https://example.test/v1'},runEffect:(s,call)=>call(String(s.index))});
  expect(result.score).toEqual({earned:2,maximum:3});
});
