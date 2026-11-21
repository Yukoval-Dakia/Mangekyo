import {expect, it} from 'vitest';
import {createLearningTurn} from './learning-turn.ts';
import {learningHostDefinitions, learningToolFallback, toolFailure, type LearningTools} from './learning-tools.ts';
import {studyToolResults} from './study-tool-results.ts';
import {executeNotionRead, notionReadDefinition, notionReadWriteKeys, parseNotionReadArgs,
  type NotionReadHostPort, type NotionReadOutput} from './notion-read-tool.ts';

const refreshed: NotionReadOutput = {
  sourceId:'01M7WXCJFCDRQA3J4WW4HKBB2W', rev:2, accessEpoch:'1', title:'Notes', status:'refreshed',
  diff:{added:['b'],removed:[],edited:['a'],moved:[]}, blocks:[{id:'a',parentId:null,text:'one'}],
};
const port = (read: NotionReadHostPort['read']): NotionReadHostPort => ({read});

it('keeps notion_read on demand, read-only, validated and mapped', async () => {
  const host: LearningTools = {
    definitions: learningHostDefinitions(false, ['tutoring'], undefined, notionReadDefinition),
    execute: async () => ({ok:true, data:{}}),
    writeKeys: notionReadWriteKeys,
    preparePython: async reads => ({ok:true, values:[]}),
    authorizeHandles: async () => ({ok:true}),
    writes: () => [],
  };
  const learning = createLearningTurn(host, studyToolResults(), async (_, invoke) => invoke(String(0)), 'm');
  expect(learning.resident.map(definition => definition.function.name)).not.toContain('notion_read');
  expect(learning.discoverable.map(definition => definition.function.name)).toContain('notion_read');
  expect(notionReadWriteKeys()).toEqual([]);
  expect(parseNotionReadArgs({source_id:'s', extra:1})).toMatchObject({ok:false, error:{code:'invalid_args',field:'extra'}});
  expect(await executeNotionRead({source_id:'s', refresh:true, block_ids:['a']}, port(async () =>
    ({ok:true, data:refreshed})), {step:1})).toEqual({ok:true, data:refreshed});
});

it.each([
  ['withdrawn', 'access_revoked'],
  ['denied', 'access_revoked'],
  ['stale', 'basis_stale'],
  ['stale_watermark', 'basis_stale'],
  ['unconfirmed', 'basis_stale'],
  ['not_found', 'not_found'],
] as const)('normalizes host outcome %s to %s', async (kind, code) => {
  const result = await executeNotionRead({source_id:'s'}, port(async () => ({ok:false, kind, message:'x'})), {step:1});
  expect(result).toMatchObject({ok:false, code, field:'source_id'});
});

it('normalizes unchanged snapshots and safe fallback errors', async () => {
  const snapshot = {sourceId:'s', rev:1, accessEpoch:'1', title:'T', blocks:[]};
  expect(await executeNotionRead({source_id:'s'}, port(async () => ({ok:false, kind:'unchanged', snapshot})), {step:1}))
    .toEqual({ok:true, data:{...snapshot, status:'unchanged', diff:{added:[],removed:[],edited:[],moved:[]}}});
  const changed = Object.assign(new Error('changed'), {name:'NotionSourceChanged'});
  expect(await executeNotionRead({source_id:'s'}, port(async () => { throw changed; }), {step:1}))
    .toMatchObject({ok:false, code:'basis_stale'});
});

it('materializes a long read then rejects its handle after revocation', async () => {
  let revoked = false;
  const host: LearningTools = {
    definitions: learningHostDefinitions(false, ['tutoring'], undefined, notionReadDefinition),
    execute: async (name, args) => name === 'notion_read' ? {ok:true, data:{...refreshed,
      blocks:[{id:'long',parentId:null,text:`${args.block_ids}${'x'.repeat(3000)}`}]}}
      : toolFailure('invalid_args','unused',learningToolFallback(name)),
    writeKeys: notionReadWriteKeys,
    preparePython: async reads => ({ok:true, values:[]}),
    authorizeHandles: async () => revoked ? toolFailure('access_revoked','结果句柄已撤权。',
      learningToolFallback('open_tool_result')) : {ok:true},
    writes: () => [],
  };
  const learning = createLearningTurn(host, studyToolResults(), async (_, invoke) => invoke(String(0)), 'm');
  const read = await learning.execute('notion_read', {source_id:'s', block_ids:['p']}, 1, Promise.resolve()) as {content:string};
  const payload = JSON.parse(read.content);
  const handle = payload.handle as string;
  expect(handle).toMatch(/^@res_/);
  revoked = true;
  const opened = await learning.execute('open_tool_result', {handle}, 2, Promise.resolve()) as {content:string};
  const openedPayload = JSON.parse(opened.content);
  expect(openedPayload).toMatchObject({ok:false, code:'access_revoked'});
});
