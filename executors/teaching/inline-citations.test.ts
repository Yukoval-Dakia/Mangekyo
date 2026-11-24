import { describe, expect, it } from 'vitest';
import {
  collectAllowedCitationIds,
  sanitizeInlineCitations,
  stripIncompleteCiteSuffix,
} from './inline-citations.ts';
import { companionInlineCitationGuidance } from './prompt.ts';
import { runStudyAgent } from './study-agent.ts';
import { deps, providerModel, responseFrame, sseResponse, watchFetch } from './test/chat.ts';

const validA = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const validB = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const fakeId = '01HZYX1234567890ABCDEFGHJK';

describe('inline-citations helpers', () => {
  it('normalizes allowed citations and strips hallucinated or malformed tags cleanly', () => {
    const allowed = new Set([validA, validB]);
    expect(sanitizeInlineCitations(`判别式须满足条件 [[cite: ${validA} ]] 且结合图像[[cite:${validB}]]。`, allowed))
      .toBe(`判别式须满足条件 [[cite:${validA}]] 且结合图像[[cite:${validB}]]。`);
    expect(sanitizeInlineCitations(`你上次漏掉了边界 [[cite:${fakeId}]] [[cite:not-a-ulid]]。`, allowed))
      .toBe('你上次漏掉了边界。');
    expect(sanitizeInlineCitations(`word1 [[cite:${fakeId}]] word2\n[[cite:${fakeId}]] 下一行`, allowed))
      .toBe('word1 word2\n下一行');
    expect(sanitizeInlineCitations(`无工具时也剥离[[cite:${validA}]]。`, new Set()))
      .toBe('无工具时也剥离。');
  });

  it('strips incomplete trailing cite prefixes while keeping closed tags and ordinary brackets', () => {
    for (const suffix of ['[', '[[', '[[c', '[[cite', '[[cite:', `[[cite: ${validA.slice(0, 8)}`, `[[cite:${validA}]`]) {
      expect(stripIncompleteCiteSuffix(`结论成立${suffix}`)).toBe('结论成立');
    }
    expect(stripIncompleteCiteSuffix(`结论成立[[cite:${validA}]]`)).toBe(`结论成立[[cite:${validA}]]`);
    expect(stripIncompleteCiteSuffix('区间 [0, 1] 与 [[note]]')).toBe('区间 [0, 1] 与 [[note]]');
  });

  it('collects only standalone 26-char ULIDs and ignores 64-char digests', () => {
    const ids = new Set<string>();
    collectAllowedCitationIds(`{"id":"${validA}","ref":"${validB}@2","sha":"${'A'.repeat(64)}"}`, ids);
    expect([...ids]).toEqual([validA, validB]);
  });
});

describe('study-agent inline citation integration', () => {
  it('injects guidance, suppresses streaming cite flicker, keeps tool-read IDs, and strips fake IDs', async () => {
    const deltas: string[] = [];
    const seenSystems: string[] = [];
    const responses = [
      sseResponse(
        responseFrame({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_workspace', arguments: `{"id":"${validA}"}` } }] }, providerModel, 'tool_calls')
        + 'data: [DONE]\n\n',
      ),
      sseResponse(
        responseFrame({ content: '你上次在判别式题上漏了定义域[[' }, providerModel)
        + responseFrame({ content: `cite:${validA.slice(0, 10)}` }, providerModel)
        + responseFrame({ content: `${validA.slice(10)}]] [[cite:${fakeId}]]。` }, providerModel, 'stop')
        + 'data: [DONE]\n\n',
      ),
    ];
    watchFetch().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] };
      if (seenSystems.length === 0) {
        seenSystems.push(...(body.messages ?? []).filter(m => m.role === 'system').map(m => m.content));
      }
      return responses.shift()!;
    });

    const result = await runStudyAgent([{ role: 'user', content: '我上次错在哪？' }], {
      ...deps,
      onTextDelta: async delta => { deltas.push(delta); },
      tools: {
        workspace: {
          narrowSaves: true,
          writes: () => [],
          execute: async () => JSON.stringify({ ok: true, id: validA, title: '判别式错题' }),
        },
      },
    }, true);

    expect(seenSystems).toContain(companionInlineCitationGuidance);
    expect(deltas.some(chunk => chunk.includes('[[') && !chunk.includes(']]'))).toBe(false);
    expect(deltas.join('')).toBe(`你上次在判别式题上漏了定义域[[cite:${validA}]]。`);
    expect(result.message).toBe(`你上次在判别式题上漏了定义域[[cite:${validA}]]。`);
  });

  it('strips hallucinated citations when no workspace tools are mounted', async () => {
    watchFetch().mockResolvedValue(sseResponse(
      responseFrame({ content: `普通回答 [[cite:${fakeId}]]。` }, providerModel, 'stop') + 'data: [DONE]\n\n',
    ));
    const result = await runStudyAgent([{ role: 'user', content: '你好' }], { ...deps }, true);
    expect(result.message).toBe('普通回答。');
  });
});
