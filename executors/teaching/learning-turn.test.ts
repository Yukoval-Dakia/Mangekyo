import {expect, it, vi} from 'vitest';
import {runCompanionTurn} from './index.ts';
import {hostedReads, hostedWrites, onDemandTools, toolFailure, type LearningTools, type ToolArgs} from './learning-tools.ts';
import {deps, mockChat, model, toolCall, type ChatRequest} from './test/chat.ts';
import {hasDockerImage} from './test/docker.ts';

const names = [...hostedReads, 'find_tools', ...hostedWrites, 'run_calculation'];
const evidence = {id:'01M7WXCJFCDRQA3J4WW4HKBB2W', rev:1, accessEpoch:'0', anchor:'q1', excerpt:'2/5', direction:'support'};
const hypothesis = {category:'hypothesis', action:'remember', scope:'general', text:'可能把分母相加', evidence_refs:[evidence]};

const discoverable = ['schedule_followup', 'evolve_graph', 'refresh_living_slots', 'notion_read'];

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
      ...Object.fromEntries(discoverable.map(name => [name, definition(name)])),
    }, execute, writes: () => [],
    writeKeys: (_, args) => typeof args.ref === 'string' ? [args.ref.replace(/@\d+$/, '')] : [],
    preparePython: async reads => ({ok:true,values:reads.map(({method}) => method === 'attempts' ? [{id:'paper-a'}] : [])}),
    authorizeHandles: async () => ({ok:true}),
  };
}

function provider(plan: (body: ChatRequest, round: number) =>
  readonly (readonly [string, ToolArgs])[] | undefined) {
  mockChat((body, round) => plan(body, round)?.map(([name, args], i) => toolCall(`call-${round}-${i}`, name, args)) ?? '完成。');
}

const turn = (learningTools: LearningTools) => runCompanionTurn('请核对学习记录。', [], undefined, {...deps, learningTools});

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
  expect(onDemandTools).toEqual(discoverable);
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

it.skipIf(!hasDockerImage('mangekyo-calculation:1'))('uses Python handles for a chart and a short radar result', async () => {
  const radar = {in_flight_todos:{state:'available',item:{kind:'personalized_extractor',state:'ready'}}};
  let handle = '';
  const host = binding(async (name, _, {handles}) => {
    if (name === 'read_context') return {ok:true,data:radar};
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
    if (round === 2) return [['read_context', {intent:'radar'}]];
    const result = JSON.parse(body.messages.at(-1)!.content);
    if (round === 3) {
      expect(result).toEqual({ok:true,data:radar,handle:expect.stringMatching(/^@res_/)});
      const code = "import json\nprint(json.loads(next(iter(inputs.values())))['data']['in_flight_todos']['item']['state'])";
      return [['run_calculation', {inputs:[result.handle], code}]];
    }
    expect(result.data.text.trim()).toBe('ready');
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
      {...deps,tools:{},memoryTools,beliefTools});
    if (beliefTools) expect(memoryTools).toHaveBeenCalledWith('save_belief',hypothesis,1);
    else expect(memoryTools).not.toHaveBeenCalled();
  }
});
