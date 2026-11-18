import { expect, it, vi } from 'vitest';
import { runCompanionTurn, runTeachingTurn, type TeachingProgress } from './index.ts';

it('requests DeepSeek Flash at high effort for reading, repair and teaching', async () => {
  const decisions = [
    { type: 'read_evidence', id: 'work' },
    null,
    { type: 'teach', action: 'transfer_question', rationale: '已独立完成', nextStep: '换个条件试试。', evidenceIds: ['work'] },
  ];
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('auto/deepseek-v4.1-flash');
    expect(body.reasoning_effort).toBe('high');
    expect(body.stream).toBe(true);
    return Response.json({ model: 'raccoon/sn-deepseek-v4-1-flash-1017', choices: [{ message: { content: JSON.stringify(decisions.shift()) } }] });
  });
  try {
    const result = await runTeachingTurn({
      question: '平均速度？', answer: '45', evidenceCatalog: [{ id: 'work', title: '行程' }],
    }, {
      provider: { baseUrl: 'https://example.test/v1' },
      readEvidence: async () => '独立列式',
      runEffect: (step, invoke) => invoke(String(step.index)),
    });
    expect(result.action).toBe('transfer_question');
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    send.mockRestore();
  }
});

const providerModel = 'raccoon/sn-deepseek-v4-1-flash-1017';

function responseFrame(delta: object, model = providerModel, finishReason: string | null = null) {
  return 'data: ' + JSON.stringify({
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + '\r\n\r\n';
}

it('streams only public companion content before the provider completes', async () => {
  const visible: TeachingProgress[] = [];
  const encoder = new TextEncoder();
  let write!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => { write = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
  const requests = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  let sent!: () => void;
  const firstVisible = new Promise<void>(resolve => { sent = resolve; });
  try {
    const finished = runCompanionTurn('为什么？', [{ role: 'user', content: '昨天的问题' }], '公开题面。', {
      provider: { baseUrl: 'https://example.test/v1' },
      runEffect: (step, invoke) => invoke(String(step.index)),
      onProgress: async progress => {
        visible.push(progress);
        sent();
      },
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
    await firstVisible;
    expect(write.desiredSize).not.toBeNull();
    expect(visible).toEqual([{ phase: 'replying', message: '公开字' }]);
    write.enqueue(encoder.encode(responseFrame({ content: '逐步到达。' }, providerModel, 'stop') + 'data: [DONE]\r\n\r\n'));
    write.close();

    const result = await finished;
    expect(result).toEqual({ message: '公开字逐步到达。', reportedModel: providerModel });
    const init = requests.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      stream: true, model: 'auto/deepseek-v4.1-flash', reasoning_effort: 'high',
      messages: [{ role: 'system', content: expect.stringContaining('公开题面。') }, { role: 'user', content: '昨天的问题' }, { role: 'user', content: '为什么？' }],
    });
  } finally {
    requests.mockRestore();
  }
});

it.each([
  ['a different model', responseFrame({ content: '不能显示的正文' }, 'another-model')],
  ['a tool channel', responseFrame({ tool_calls: [{ function: { arguments: '{"secret":true}' } }], content: '不能显示的正文' })],
  ['a truncated reply', responseFrame({ content: '不能显示的截断正文' }, providerModel, 'length'), 'provider_incomplete'],
])('rejects %s before relaying its chunk', async (_name, chunk, code = 'provider_response') => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(chunk, {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  const onProgress = vi.fn(async () => {});
  try {
    await expect(runCompanionTurn('为什么？', [], undefined, {
      provider: { baseUrl: 'https://example.test/v1' },
      runEffect: (step, invoke) => invoke(String(step.index)),
      onProgress,
    })).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
