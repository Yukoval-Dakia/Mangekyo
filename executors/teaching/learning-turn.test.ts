import {execFileSync} from 'node:child_process';
import {afterEach, expect, it, vi} from 'vitest';
import {runCompanionTurn} from './index.ts';
import {hostedReads, hostedWrites, onDemandTools, toolFailure, type LearningTools} from './learning-tools.ts';
import type {FunctionCall} from './provider-stream.ts';

afterEach(() => vi.unstubAllGlobals());

const names = [...hostedReads, 'find_tools', ...hostedWrites, 'run_calculation'];
const model = 'auto/deepseek-v4.1-flash';
const evidence = {id:'01M7WXCJFCDRQA3J4WW4HKBB2W', rev:1, accessEpoch:'0', anchor:'q1', excerpt:'2/5', direction:'support'};
const hypothesis = {category:'hypothesis', action:'remember', scope:'general', text:'可能把分母相加', evidence_refs:[evidence]};
type Args = Record<string, unknown>;

function binding(execute: LearningTools['execute']): LearningTools {
  const definition = <N extends string>(name: N) => ({type:'function', function:{name, description:name, parameters:{type:'object'}}});
  return {
    definitions: {
      search_learning: definition('search_learning'),
      open_learning: definition('open_learning'),
      read_context: definition('read_context'),
      save_page: definition('save_page'),
      save_question: definition('save_question'),
      save_edge: definition('save_edge'),
      manage_activity: definition('manage_activity'),
      schedule_followup: definition('schedule_followup'),
      evolve_graph: definition('evolve_graph'),
      refresh_living_slots: definition('refresh_living_slots'),
      notion_read: definition('notion_read'),
    }, execute, writes: () => [],
    writeKeys: (_, args) => typeof args.ref === 'string' ? [args.ref.replace(/@\d+$/, '')] : [],
    preparePython: async reads => ({ok:true,values:reads.map(({method}) => method === 'attempts' ? [{id:'paper-a'}] : [])}),
    authorizeHandles: async () => ({ok:true}),
  };
}

function provider(plan: (body: {model: string; reasoning_effort: string; tools: {function:{name:string; parameters:Args}}[];
  messages: {role:string; content:string}[]}, round: number) => readonly (readonly [string, Args])[] | undefined) {
  let round = 0;
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const current = round++;
    const calls = plan(JSON.parse(String(init.body)), current);
    const tool_calls: FunctionCall[] | undefined = calls?.map(([name, args], i) =>
      ({type:'function', id:`call-${current}-${i}`, function:{name, arguments:JSON.stringify(args)}}));
    return Response.json({model, choices:[{message: tool_calls ? {role:'assistant', tool_calls, content:null}
      : {role:'assistant',content:'完成。'},finish_reason: tool_calls ? 'tool_calls' : 'stop'}]});
  });
}

const runEffect = (step: {index:number}, run: (id:string) => Promise<string>) => run(String(step.index));
const turn = (learningTools: LearningTools) => runCompanionTurn('请核对学习记录。', [], undefined,
  {provider:{baseUrl:'https://example.test/v1'}, runEffect, learningTools});

it.each([
  ['search_learning', 'not_found', {query:'分母'}, {query:'分数'}],
  ['open_learning', 'access_revoked', {refs:'old'}, {refs:'current_attempt'}],
  ['read_context', 'basis_stale', {intent:'tutoring',expand:'stale'}, {intent:'tutoring'}],
  ['save_page', 'version_conflict', {ref:'page',expected_rev:1}, {ref:'page',expected_rev:2}],
  ['save_question', 'invalid_args', {stem:''}, {stem:'比较两种方法'}],
  ['save_belief', 'evidence_not_opened', {...hypothesis,evidence_refs:[]}, hypothesis],
  ['save_edge', 'invalid_args', {from:'a',to:'a'}, {from:'a',to:'b'}],
  ['manage_activity', 'limit_exceeded', {items:['a','b','c']}, {items:['a']}],
] as const)('repairs %s in one model decision', async (name, code, first, retry) => {
  let executions = 0;
  const host = binding(async (_, args) => {
    if (executions++ === 0) {
      expect(args).toEqual(first);
      return toolFailure(code, '请按下一步重试。', {tool:name, args:retry});
    }
    expect(args).toEqual(retry);
    return {ok:true,data:{ref:'opened'}};
  });
  provider((body, round) => {
    expect(body.model).toBe(model);
    expect(body.reasoning_effort).toBe('high');
    expect(body.tools.map(tool => tool.function.name)).toEqual(names);
    if (!round) return [[name, first]];
    const value = JSON.parse(body.messages.at(-1)!.content);
    if (round === 1) {
      expect(value).toMatchObject({ok:false, code, next:{tool:name,args:retry}});
      if (code === 'not_found') expect(value.candidates).toEqual([]);
      return [[value.next.tool, value.next.args]];
    }
    expect(value).toEqual({ok:true,data:{ref:'opened'}});
    return undefined;
  });
  expect((await turn(host)).reportedModel).toBe(model);
  expect(executions).toBe(2);
});

it('runs up to four reads and serializes writes sharing a canonical ref', async () => {
  let activeReads = 0;
  let peakReads = 0;
  const activeRefs = new Set<string>();
  let peakWrites = 0;
  const host = binding(async (name, args, {priorRead}) => {
    if (name === 'open_learning') {
      peakReads = Math.max(peakReads, ++activeReads);
      await new Promise(resolve => setImmediate(resolve));
      activeReads--;
      await priorRead;
    } else {
      const key = String(args.ref).split('@')[0]!;
      expect(activeRefs.has(key)).toBe(false);
      activeRefs.add(key);
      peakWrites = Math.max(peakWrites, activeRefs.size);
      await new Promise(resolve => setImmediate(resolve));
      activeRefs.delete(key);
    }
    return {ok:true,data:args};
  });
  provider((body, round) => {
    if (round === 2) {
      const replies = body.messages.filter(message => message.role === 'tool');
      expect(replies.map(message => JSON.parse(message.content).data.ref)).toEqual(['a','b','c','d','page@1','page@2','other']);
      return undefined;
    }
    return round
      ? [['save_page',{ref:'page@1'}], ['save_page',{ref:'page@2'}], ['save_page',{ref:'other'}]]
      : ['a','b','c','d'].map(ref => ['open_learning',{ref}]);
  });
  await turn(host);
  expect(peakReads).toBe(4);
  expect(peakWrites).toBe(2);
});

it('stops a second recovery after the authorized prerequisite and original retry', async () => {
  const opened = {refs:'source'};
  const attempted = {ref:'page'};
  const seen: string[] = [];
  const host = binding(async name => {
    seen.push(name);
    if (name === 'open_learning') return {ok:true,data:{}};
    return toolFailure('evidence_not_opened','先打开原始依据。',{tool:'open_learning',args:opened});
  });
  provider((body, round) => {
    if (round === 4) {
      expect(JSON.parse(body.messages.at(-1)!.content)).toMatchObject({ok:false,code:'limit_exceeded',recovery_exhausted:true});
      return undefined;
    }
    return round % 2 ? [['open_learning',opened]] : [['save_page',attempted]];
  });
  await turn(host);
  expect(seen).toEqual(['save_page','open_learning','save_page']);
});

it('discovers and executes the four hosted tools on demand', async () => {
  const executed: string[] = [];
  const host = binding(async name => {
    executed.push(name);
    return {ok:true,data:{status:'scheduled'}};
  });
  provider((body, round) => {
    const offered = body.tools.map(tool => tool.function.name);
    if (round === 0) {
      expect(offered).toEqual(names);
      return onDemandTools.map(name => ['find_tools', {query:name}]);
    }
    if (round === 1) {
      expect(offered.slice(0, 10)).toEqual(names);
      expect(offered.slice(10).sort()).toEqual([...onDemandTools].sort());
      return onDemandTools.map(name => [name, {}]);
    }
    expect(offered).toEqual(names);
    return undefined;
  });
  await turn(host);
  expect(executed).toEqual(onDemandTools);
});

function sandboxReady() {
  try { execFileSync('docker', ['image', 'inspect', 'mangekyo-calculation:1'], {stdio:'ignore'}); return true; }
  catch { return false; }
}

it.skipIf(!sandboxReady())('calculates with the real read-only SDK and attaches a PNG by handle', async () => {
  let handle = '';
  const host = binding(async (name, _, {handles}) => {
    expect(name).toBe('save_page');
    expect(handles[handle]).toMatchObject({step:1, mediaType:'image/png'});
    expect(Buffer.from(handles[handle]!.value, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    return {ok:true,data:{status:'saved',undo_token:'undo'}};
  });
  const authorize = vi.spyOn(host, 'authorizeHandles');
  provider((body, round) => {
    if (!round) return [['run_calculation', {
      reads:[{method:'attempts',args:{subject:'math'}}],
      code:`import mangekyo as mk
import numpy as np
from sympy import factor
import matplotlib.pyplot as plt
rows = mk.attempts(subject='math')
rows.clear()
assert len(mk.attempts(subject='math')) == 1
try:
    mk.attempts(subject='history')
except ValueError:
    pass
else:
    raise RuntimeError("Undeclared read")
assert not hasattr(mk, "mutate")
print(factor(12), mk.attempts(subject='math')[0]['id'])
plt.plot(np.array([1, 2, 4]))
plt.savefig("chart.png")
`,
    }]];
    if (round === 1) {
      const result = JSON.parse(body.messages.at(-1)!.content);
      expect(result).toMatchObject({ok:true,data:{text:'12 paper-a'},artifacts:[{name:'chart.png',mediaType:'image/png'}]});
      handle = result.artifacts[0].handle;
      expect(handle).toMatch(/^@calc_/);
      return [['save_page', {ref:'page',patch:[{op:'insert_after',target:'intro',artifact:handle}]}]];
    }
    return undefined;
  });
  await turn(host);
  expect(authorize).toHaveBeenCalledWith([1], 17);
}, 15_000);

it('keeps the old provider catalog until the persisted belief flag switches', async () => {
  for (const beliefTools of [false, true]) {
    const memoryTools = vi.fn(async () => '{"ok":true}');
    provider((body, round) => {
      const definition = body.tools.find(tool => tool.function.name === 'save_belief');
      expect(Boolean(definition)).toBe(beliefTools);
      expect(body.tools.some(tool => tool.function.name === 'save_memory')).toBe(!beliefTools);
      expect(body.messages.some(message => message.role === 'system' &&
        message.content.includes(beliefTools ? '用 save_belief' : '调用 save_memory'))).toBe(true);
      if (!definition || round) return undefined;
      expect(definition.function.parameters.oneOf).toMatchObject([
        {properties:{category:{enum:['directive']},action:{enum:['remember','update','forget']}}},
        {properties:{category:{enum:['hypothesis']}, evidence_refs:{items:{required:['id','rev','accessEpoch','anchor','excerpt','direction']}}}},
      ]);
      return [['save_belief',hypothesis]];
    });
    await runCompanionTurn('请核对我的原答。', [], undefined,
      {provider:{baseUrl:'https://example.test/v1'},runEffect,tools:{},memoryTools,beliefTools});
    if (beliefTools) expect(memoryTools).toHaveBeenCalledWith('save_belief',hypothesis,1);
    else expect(memoryTools).not.toHaveBeenCalled();
  }
});
