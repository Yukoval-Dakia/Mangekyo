import {expect, it} from 'vitest';
import {runStudyAgent} from './study-agent.ts';
import {deps, mockChat, toolCall} from './test/chat.ts';

it.each(['continue', 'stop', 'empty'])('passes the tool error back and honors the next model decision: %s', async decision => {
  const continues = decision === 'continue';
  const errors = ['kind="note" 只用于搜索已有笔记。保存方法笔记请用 kind="page"。', '请在 body 填写正文。'];
  const args = [{kind:'note',title:'方法'}, {kind:'page',title:'方法'}, {kind:'page',title:'方法',body:'先画时间线。'}];
  const final = decision === 'empty' ? '' : continues ? '方法笔记已保存。' : '笔记未保存。';
  const calls = continues ? args.length : 1;
  const send = mockChat(({messages}, index) => {
    expect(messages.filter(message => message.role === 'system')).toHaveLength(0);
    if (index > 0 && index <= errors.length) {
      expect(JSON.parse(messages.at(-1)!.content)).toEqual({ok:false, code:'invalid_args', message:errors[index-1]});
    }
    if (index > calls) throw Error('额外的模型调用');
    return index === calls ? final : [toolCall('call-' + index, 'save_workspace', args[index]!)];
  });
  let attempts = 0;
  const result = runStudyAgent([{role:'user',content:'保存一页方法笔记。'}],{
    ...deps,
    tools:{workspace:{writes:() => [],execute:async (_name,input) => {
      expect(input).toEqual(args[attempts]);
      const error = errors[attempts++];
      return JSON.stringify(error ? {ok:false, code:'invalid_args', message:error} : {state:'done',id:'page',rev:1});
    }}},
  });
  if (decision === 'empty') await expect(result).rejects.toThrow('模型没有返回可用的答复');
  else expect((await result).message).toBe(final);
  expect(send).toHaveBeenCalledTimes(calls+1);
});
