import {expect, it} from 'vitest';
import {runCompanionTurn} from './index.ts';
import {runStudyAgent} from './study-agent.ts';
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
