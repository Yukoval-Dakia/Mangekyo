import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { readMineru, submitMineru } from '@mangekyo/executor-document-extraction/mineru';

const token = 'test-token';
const dataId = 'intake-001';
const batchId = '2bb2f0ec-a336-4a0a-b61a-241afaf9cc87';
const uploadUrl = 'https://mineru.oss-cn-shanghai.aliyuncs.com/api-upload/synthetic.pdf';
const zipUrl = 'https://cdn-mineru.openxlab.org.cn/pdf/result.zip';
const original = { token, dataId, bytes: Buffer.from('%PDF-1.4\n'), mediaType: 'application/pdf' } as const;
const query = { token, dataId, batchId };
const api = (data: unknown) => Response.json({ code: 0, data });
const prepared = (url: string) => api({ batch_id: batchId, file_urls: [url] });
const result = (url: string, id = dataId) =>
  api({ batch_id: batchId, extract_result: [{ data_id: id, state: 'done', full_zip_url: url }] });

function transport(...responses: Response[]) {
  const calls: { url: string; method: string | undefined; authorization: string | null; redirect: RequestInit['redirect'] }[] = [];
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method,
      authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected fetch');
    return next;
  };
  return { fetch, calls };
}

it('uploads once and sends the token only to the prepare API', async () => {
  const { fetch, calls } = transport(prepared(uploadUrl), new Response(null));
  await expect(submitMineru({ ...original, fetch })).resolves.toBe(batchId);
  expect(calls).toEqual([
    { url: 'https://mineru.net/api/v4/file-urls/batch', method: 'POST', authorization: 'Bearer test-token', redirect: 'error' },
    { url: uploadUrl, method: 'PUT', authorization: null, redirect: 'error' },
  ]);
});

it('returns full.md for the requested batch without sending the token to the CDN', async () => {
  const zip = zipSync({ 'full.md': strToU8('# 中文\n'), 'layout.json': strToU8('{}') });
  const { fetch, calls } = transport(result(zipUrl), new Response(new Uint8Array(zip)));
  await expect(readMineru({ ...query, fetch })).resolves.toEqual({ state: 'done', text: '# 中文\n', pages: null });
  expect(calls.at(-1)).toMatchObject({ url: zipUrl, authorization: null, redirect: 'error' });
});

it('stops when the destination, batch contents or upload authorization are invalid', async () => {
  const invalid = transport(prepared('https://outside.example/api-upload/file.pdf'));
  await expect(submitMineru({ ...original, fetch: invalid.fetch })).rejects.toThrow('上传地址无效');
  expect(invalid.calls).toHaveLength(1);
  const stale = transport(prepared(uploadUrl));
  await expect(submitMineru({ ...original, fetch: stale.fetch, beforeUpload: async () => {
    throw new Error('stale work');
  } })).rejects.toThrow('stale work');
  expect(stale.calls).toHaveLength(1);
  const unrelated = transport(result(zipUrl, 'other-intake'));
  await expect(readMineru({ ...query, fetch: unrelated.fetch })).rejects.toThrow('批次结果无效');
  expect(unrelated.calls).toHaveLength(1);
});
