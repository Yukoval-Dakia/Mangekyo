import {expect, it} from 'vitest';
import {runCompanionTurn, type TeachingActivity} from './index.ts';
import {learningHostDefinitions} from './learning-tools.ts';
import {createLearningTurn} from './learning-turn.ts';
import {runStudyAgent} from './study-agent.ts';
import {studyToolResults} from './study-tool-results.ts';
import {deps, model, mockChat, providerModel, responseFrame, sseResponse, watchFetch} from './test/chat.ts';
import {executeCompanionTurn} from './turn-companion.ts';
import type {GuardableTurn} from './turn-context.ts';
import {createTurnWitnessLedger} from './turn-witness.ts';

const providerModelPlaceholder = providerModel;
const settings = {
  baseUrl: 'http://127.0.0.1:3425/v1', model, protocol: 'openai' as const, reasoningEffort: 'high',
  apiKey: '', activeProviderId: 'test', providers: [], mcpServers: [], exaApiKey: '', allowSearch: false,
};
type Turn = GuardableTurn & {readonly classroom?: {readonly mode: string}};

it('streams visible deltas without requiring onProgress', async () => {
  const deltas: string[] = [];
  watchFetch().mockResolvedValue(sseResponse(
    responseFrame({content: '先看'}, providerModelPlaceholder) +
    responseFrame({content: '条件。'}, providerModelPlaceholder, 'stop') + 'data: [DONE]\n\n',
  ));
  const result = await runCompanionTurn('为什么？', [], undefined, {
    ...deps, onTextDelta: async delta => {deltas.push(delta);},
  });
  expect(result.message).toBe('先看条件。');
  expect(deltas).toEqual(['先看', '条件。']);
});

it('holds split private tags until public content is certain', async () => {
  const deltas: string[] = [];
  watchFetch().mockResolvedValue(sseResponse(
    responseFrame({content: '<th'}) +
    responseFrame({content: 'ink>秘密</th'}) +
    responseFrame({content: 'ink>正式回复'}, providerModelPlaceholder, 'stop') + 'data: [DONE]\n\n',
  ));
  const result = await runCompanionTurn('为什么？', [], undefined, {
    ...deps, onTextDelta: async delta => {deltas.push(delta);},
  });
  expect(result.message).toBe('正式回复');
  expect(deltas).toEqual(['正式回复']);
});

it('does not emit a tool-call round, then emits the next final round', async () => {
  const deltas: string[] = [];
  const responses = [
    sseResponse(responseFrame({tool_calls: [{index: 0, id: 'call-1', type: 'function', function: {name: 'save_page', arguments: '{"title":"页","content":"正文"}'}}]}, providerModelPlaceholder, 'tool_calls') + 'data: [DONE]\n\n'),
    sseResponse(responseFrame({content: '已保存。'}, providerModelPlaceholder, 'stop') + 'data: [DONE]\n\n'),
  ];
  watchFetch().mockImplementation(async () => responses.shift()!);
  const result = await runStudyAgent([{role: 'user', content: '保存一页。'}], {
    ...deps,
    onTextDelta: async delta => {deltas.push(delta);},
    tools: {workspace: {narrowSaves: true, writes: () => [], execute: async () => JSON.stringify({state: 'done', id: 'page', rev: 1})}},
  }, true);
  expect(result.message).toBe('已保存。');
  expect(deltas).toEqual(['已保存。']);
});

it('signals tool progress to clear transitional text and streams thinking plus tool steps', async () => {
  const deltas: string[] = [];
  const phases: string[] = [];
  const activities: TeachingActivity[] = [];
  const responses = [
    sseResponse(
      responseFrame({reasoning_content: '先核对讲义内容'}, providerModelPlaceholder) +
      responseFrame({content: '我先查一下记录'}, providerModelPlaceholder) +
      responseFrame({tool_calls: [{index: 0, id: 'call-1', type: 'function', function: {name: 'save_page', arguments: '{"title":"牛顿定律","content":"正文"}'}}]}, providerModelPlaceholder, 'tool_calls') +
      'data: [DONE]\n\n',
    ),
    sseResponse(responseFrame({content: '最终回答。'}, providerModelPlaceholder, 'stop') + 'data: [DONE]\n\n'),
  ];
  watchFetch().mockImplementation(async () => responses.shift()!);
  const result = await runStudyAgent([{role: 'user', content: '保存一页。'}], {
    ...deps,
    onProgress: async progress => {phases.push(progress.phase);},
    onTextDelta: async delta => {deltas.push(delta);},
    onActivity: async activity => {activities.push(activity);},
    tools: {workspace: {narrowSaves: true, writes: () => [], execute: async () => JSON.stringify({state: 'done', id: 'page', rev: 1})}},
  }, true);
  expect(result.message).toBe('最终回答。');
  expect(phases).toContain('checking');
  expect(deltas.at(-1)).toBe('最终回答。');
  expect(activities.some(a => a.kind === 'thinking' && a.delta.includes('先核对讲义内容'))).toBe(true);
  expect(activities.some(a => a.kind === 'tool' && a.step.name === 'save_page' && a.step.label === '整理学习讲义' && a.step.status === 'running')).toBe(true);
  expect(activities.some(a => a.kind === 'tool' && a.step.name === 'save_page' && a.step.summary === '牛顿定律' && a.step.status === 'done' && typeof a.step.durationMs === 'number')).toBe(true);
});

it('exposes mount_artifact as a resident tool for Generative UI turns', () => {
  const artifact = {type: 'function', function: {name: 'mount_artifact', description: 'mount', parameters: {type: 'object', properties: {}}}};
  const turn = createLearningTurn({
    definitions: learningHostDefinitions(false, ['tutoring'], artifact),
    execute: async () => ({ok: true, data: {}}),
    writeKeys: () => [],
    preparePython: async () => ({ok: true, values: []}),
    authorizeHandles: async () => ({ok: true}),
    writes: () => [],
  }, studyToolResults(), deps.runEffect, model);
  expect(turn.resident.map(t => t.function.name)).toContain('mount_artifact');
  expect(turn.discoverable.map(t => t.function.name)).not.toContain('mount_artifact');
});

it('suppresses prepare output and replies hidden by companion turn guards', async () => {
  const kit = JSON.stringify({title: '主题', lesson: '讲义', questions: [
    {prompt: '一？', answer: '一'}, {prompt: '二？', answer: '二'},
  ]});
  const prepareDeltas: string[] = [];
  mockChat(() => kit);
  await runCompanionTurn('备一课。', [], '材料。', {
    ...deps, onTextDelta: async delta => {prepareDeltas.push(delta);},
  }, true);
  expect(prepareDeltas).toEqual([]);

  for (const submission of [
    {baseUrl: settings.baseUrl, model, caseId: 'companion', sessionId: 'session', parentId: null, answer: '开课', classroom: {mode: 'start'}},
    {baseUrl: settings.baseUrl, model, caseId: 'companion', sessionId: 'session', parentId: null, answer: '继续', workspaceRevision: 'workspace'},
  ] satisfies readonly Turn[]) {
    const deltas: string[] = [];
    const content = submission.classroom
      ? JSON.stringify({message: '开课正文。', steps: ['一', '二']})
      : '不能转发。';
    watchFetch().mockResolvedValue(sseResponse(responseFrame({content}, providerModelPlaceholder, 'stop') + 'data: [DONE]\n\n'));
    await executeCompanionTurn({
      slotKey: 'slot', slotType: 'reply', submission, learningV1: false,
      settings, grants: [], mcpServers: [], memoryId: 'memory',
      ridingLesson: {title: '课', distanceKm: 1, movingMinutes: 1, stoppedMinutes: 1},
      averageSpeed: () => 1, onProgress: async () => {}, onTextDelta: async delta => {deltas.push(delta);},
      runEffect: (step, invoke) => invoke(String(step.index)),
      ledger: createTurnWitnessLedger({
        slotType: 'reply',
        toInput: witness => ({kind: 'fact', id: witness.id, rev: witness.rev, accessEpoch: witness.epoch, mode: 'following'}),
        proofKey: witness => witness.id,
        canonicalKey: input => input.kind === 'fact' ? input.id : JSON.stringify(input),
      }),
    }, {
      loadClassroomAdjust: async () => [], getJitCounter: () => undefined, prepareJit: async () => undefined,
      loadCurrentObject: async () => undefined, loadPreference: async () => undefined,
      loadLearningMemory: async () => undefined, expandLearningMemory: async () => undefined,
      withHistoryRead: async () => ({messages: [], historyNotice: '', retain: [], priorBasis: []}) as never,
      isAssessmentSlot: () => false, isRetentionSlot: () => false, proofKey: witness => witness.id,
      readToolContract: async () => 'none',
      openWorkspace: () => ({writes: () => [], execute: async () => '{}', basis: () => [], reads: () => [], publishedFormalArtifact: () => true}) as never,
      openTurnMemory: () => {throw Error('unused');}, recordLearningTracking: async () => {},
      openLearningTools: () => {throw Error('unused');},
      parseClassroomReply: raw => JSON.parse(raw), isMemoryConflict: () => false,
    });
    expect(deltas).toEqual([]);
  }
});
