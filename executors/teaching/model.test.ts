import { expect, it, vi } from 'vitest';
import { runCompanionTurn, runTeachingTurn, type TeachingProgress } from './index.ts';
import {bodyOf, deps, model, providerModel, responseFrame, sseResponse, watchFetch} from './test/chat.ts';

it('requests DeepSeek Flash at high effort for reading, repair and teaching', async () => {
  const decisions = [null,
    {type: 'teach', action: 'transfer_question', rationale: '已独立完成', nextStep: '换个条件试试。', evidenceIds: ['work']}];
  const usage = {prompt_tokens: 8, completion_tokens: 6, total_tokens: 14};
  const effects: object[] = [];
  const send = watchFetch().mockImplementation(async (_url, init) => {
    const body = bodyOf(init);
    expect(body.model).toBe(model); expect(body.reasoning_effort).toBe('high'); expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({include_usage: true});
    return Response.json({model: providerModel, usage, choices: [{message: {content: JSON.stringify(decisions.shift())}}]});
  });
  const readEvidence = vi.fn(async () => '独立列式');
  const result = await runTeachingTurn({question: '平均速度？', answer: '45',
    evidenceCatalog: [{id: 'work', title: '行程'}]}, {
      ...deps, readEvidence,
      runEffect: async (step, invoke) => {
        const raw = await invoke(String(step.index));
        effects.push(JSON.parse(raw));
        return raw;
      },
    });
  expect(result.action).toBe('transfer_question'); expect(send).toHaveBeenCalledTimes(2);
  expect(readEvidence).toHaveBeenCalledTimes(1);
  expect(readEvidence).toHaveBeenCalledWith('work');
  expect(result.reads).toEqual([{id: 'work', title: '行程'}]);
  expect(result.usage).toEqual(usage);
  expect(effects.map((effect: {usage?: unknown}) => effect.usage)).toEqual([usage, usage]);
});

it('pre-reads the single catalog entry and teaches in one model call', async () => {
  const send = watchFetch().mockImplementation(async (_url, init) => {
    const body = bodyOf(init);
    const user = JSON.parse(body.messages[1].content);
    expect(user.evidenceRead).toEqual([{id: 'work', title: '行程', body: '独立列式'}]);
    expect(user.readsRemaining).toBe(0);
    return Response.json({model: providerModel, usage: {prompt_tokens: 8, completion_tokens: 6, total_tokens: 14},
      choices: [{message: {content: JSON.stringify({type: 'teach', action: 'clarifying_question', rationale: '有歧义', nextStep: '先确认条件。', evidenceIds: ['work']})}}]});
  });
  const readEvidence = vi.fn(async () => '独立列式');
  const result = await runTeachingTurn({question: '平均速度？', answer: '45',
    evidenceCatalog: [{id: 'work', title: '行程'}]}, {...deps, readEvidence});
  expect(result.action).toBe('clarifying_question'); expect(send).toHaveBeenCalledTimes(1);
  expect(readEvidence).toHaveBeenCalledTimes(1);
});

it('keeps on-demand reads for multi-entry catalogs and rejects teach before any read', async () => {
  const decisions = [{type: 'teach', action: 'clarifying_question', rationale: '有歧义', nextStep: '先确认。', evidenceIds: []}];
  watchFetch().mockImplementation(async () => Response.json({model: providerModel,
    choices: [{message: {content: JSON.stringify(decisions.shift())}}]}));
  const readEvidence = vi.fn(async () => '正文');
  await expect(runTeachingTurn({question: '平均速度？', answer: '45',
    evidenceCatalog: [{id: 'a', title: '甲'}, {id: 'b', title: '乙'}]}, {...deps, readEvidence}))
    .rejects.toMatchObject({code: 'invalid_decision'});
  expect(readEvidence).not.toHaveBeenCalled();
});

it('ignores one redundant read_evidence for the preloaded entry, then still rejects the second', async () => {
  const decisions = [{type: 'read_evidence', id: 'work'}, {type: 'read_evidence', id: 'work'}];
  watchFetch().mockImplementation(async () => Response.json({model: providerModel,
    choices: [{message: {content: JSON.stringify(decisions.shift())}}]}));
  const readEvidence = vi.fn(async () => '独立列式');
  await expect(runTeachingTurn({question: '平均速度？', answer: '45',
    evidenceCatalog: [{id: 'work', title: '行程'}]}, {...deps, readEvidence}))
    .rejects.toMatchObject({code: 'evidence_limit'});
  expect(readEvidence).toHaveBeenCalledTimes(1);
});

it('streams only public companion content before the provider completes', async () => {
  const visible: TeachingProgress[] = [];
  const encoder = new TextEncoder();
  let write!: ReadableStreamDefaultController<Uint8Array>;
  const response = sseResponse(new ReadableStream({start(controller) {write = controller;}}));
  const requests = watchFetch().mockResolvedValue(response);
  const firstVisible = Promise.withResolvers<void>();
  const finished = runCompanionTurn('为什么？', [{role: 'user', content: '昨天的问题'}], '公开题面。', {
    ...deps, onProgress: async progress => {visible.push(progress); firstVisible.resolve();},
  });
  const first = encoder.encode(
    responseFrame({ role: 'assistant', reasoning_content: '秘密推理' }) +
    responseFrame({ content: '<analy' }) +
    responseFrame({ content: 'sis source=">' }) +
    responseFrame({ content: '"><thi' }) +
    responseFrame({ content: 'nk><think>秘密嵌套</think>仍私有</think>也私有</ana' }) +
    responseFrame({ content: 'lysis>公开字' }),
  );
  write.enqueue(first.slice(0, first.length - 7));
  write.enqueue(first.slice(first.length - 7, first.length - 1));
  write.enqueue(first.slice(first.length - 1));
  await firstVisible.promise;
  expect(write.desiredSize).not.toBeNull();
  expect(visible).toEqual([{phase: 'replying', message: '公开字'}]);
  write.enqueue(encoder.encode(responseFrame({content: '逐步到达。'}, providerModel, 'stop') + 'data: [DONE]\r\n\r\n'));
  write.close();
  const result = await finished;
  expect(result).toEqual({message: '公开字逐步到达。', reportedModel: providerModel});
  const init = requests.mock.calls[0]?.[1];
  expect(bodyOf(init)).toMatchObject({stream: true, model, reasoning_effort: 'high', messages: [
    {role: 'system', content: expect.stringContaining('学习同伴')},
    {role: 'system', content: expect.stringContaining('未挂载任何长期记忆或教材写入工具')},
    {role: 'user', content: expect.stringContaining('公开题面。')}, {role: 'user', content: '昨天的问题'},
    {role: 'user', content: '为什么？'},
  ]});
});

it('forbids claiming memory writes when no write tools are mounted', async () => {
  const requests = watchFetch().mockImplementation(async (_url, init) => {
    const system = bodyOf(init).messages.filter((m: {role: string}) => m.role === 'system').map((m: {content: string}) => m.content).join('\n');
    expect(system).toContain('未挂载任何长期记忆或教材写入工具');
    expect(system).toContain('绝不能声称');
    return Response.json({model: providerModel, choices: [{message: {content: '好的。'}}]});
  });
  await runCompanionTurn('请记住我偏好先听直觉。', [], undefined, {...deps});
  expect(requests).toHaveBeenCalledTimes(1);
});

it.each([
  ['a different model', responseFrame({content: '不能显示的正文'}, 'another-model')],
  ['a tool channel', responseFrame({tool_calls: [{function: {arguments: '{"secret":true}'}}], content: '不能显示的正文'})],
  ['a truncated reply', responseFrame({content: '不能显示的截断正文'}, providerModel, 'length'), 'provider_incomplete'],
])('rejects %s before relaying its chunk', async (_name, chunk, code = 'provider_response') => {
  const fetch = watchFetch().mockResolvedValue(sseResponse(chunk));
  const onProgress = vi.fn(async () => {});
  await expect(runCompanionTurn('为什么？', [], undefined, {...deps, onProgress})).rejects.toMatchObject({code});
  expect(fetch).toHaveBeenCalledTimes(1); expect(onProgress).not.toHaveBeenCalled();
});
