import {afterEach, expect, it, vi} from 'vitest';
import {runStudyAgent} from './study-agent.ts';

afterEach(() => vi.unstubAllGlobals());

it.each(['continue', 'stop', 'empty'])('passes the tool error back and honors the next model decision: %s', async decision => {
  const continues = decision === 'continue';
  const model = 'auto/deepseek-v4.1-flash';
  const errors = ['kind="note" 只用于搜索已有笔记。保存方法笔记请用 kind="page"。', '请在 body 填写正文。'];
  const args = [{kind:'note',title:'方法'}, {kind:'page',title:'方法'}, {kind:'page',title:'方法',body:'先画时间线。'}];
  const final = decision === 'empty' ? '' : continues ? '方法笔记已保存。' : '笔记未保存。';
  const calls = continues ? args.length : 1;
  let requests = 0;
  vi.stubGlobal('fetch',vi.fn(async (_url,init) => {
    const {messages} = JSON.parse(init.body);
    expect(messages.filter((m:{role:string}) => m.role === 'system')).toHaveLength(0);
    if (requests > 0 && requests <= errors.length) {
      expect(JSON.parse(messages.at(-1).content)).toEqual({error:errors[requests-1]});
    }
    const index = requests++;
    if (index > calls) throw Error('额外的模型调用');
    const message = index === calls ? {role:'assistant',content:final} : {role:'assistant',tool_calls:[
      {type:'function',id:'call-'+index,function:{name:'save_workspace',arguments:JSON.stringify(args[index])}},
    ]};
    return Response.json({model,choices:[{message,finish_reason:index === calls ? 'stop' : 'tool_calls'}]});
  }));
  let attempts = 0;
  const result = runStudyAgent([{role:'user',content:'保存一页方法笔记。'}],{
    provider:{baseUrl:'https://example.test/v1'},runEffect:async (step,run) => run(String(step.index)),
    tools:{workspace:{writes:() => [],execute:async (_name,input) => {
      expect(input).toEqual(args[attempts]);
      const error = errors[attempts++];
      return JSON.stringify(error ? {error} : {state:'done',id:'page',rev:1});
    }}},
  });
  if (decision === 'empty') await expect(result).rejects.toThrow('模型没有返回可用的答复');
  else expect((await result).message).toBe(final);
  expect(requests).toBe(calls+1);
});
