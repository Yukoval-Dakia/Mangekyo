import { zipSync, strToU8 } from 'fflate';
import { describe, expect, test } from 'vitest';
import { readMineru, submitMineru } from '../mineru.ts';

type Call = { url: URL; init: RequestInit };

const token = 'secret-token';
const dataId = 'intake-001';
const batchId = '2bb2f0ec-a336-4a0a-b61a-241afaf9cc87';
const uploadPath = `/api-upload/extract/2026-08-13/agent/${batchId}/7fd1c164-fbda-489b-af3a-8a37a1072b8e.pdf`;
const uploadUrl = `https://mineru.oss-cn-shanghai.aliyuncs.com${uploadPath}?Expires=1&Signature=x`;
const zipUrl = `https://cdn-mineru.openxlab.org.cn/pdf/${batchId}.zip`;
const bytes = Buffer.from('%PDF-1.4\n');

function response(body: Uint8Array | string | null, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function queue(calls: Call[], responses: Response[]): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
}

function api(payload: unknown) {
  return response(JSON.stringify({ code: 0, msg: 'ok', data: payload }));
}

function streamResponse(body: Uint8Array) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-length': String(body.byteLength), 'content-type': 'application/zip' },
  });
}

describe('MinerU API adapter', () => {
  test('submits, gates upload, and keeps bearer off the signed PUT', async () => {
    const calls: Call[] = [];
    const fetch = queue(calls, [
      api({ batch_id: batchId, file_urls: [uploadUrl] }),
      response(null),
    ]);

    let gateRuns = 0;
    const beforeUpload = () => {
      gateRuns += 1;
      expect(calls.length).toBe(1);
      return Promise.resolve();
    };
    await expect(
      submitMineru({ token, bytes, mediaType: 'application/pdf', dataId, beforeUpload, fetch }),
    ).resolves.toBe(batchId);
    expect(gateRuns).toBe(1);

    const [submission, upload] = calls;
    expect(submission?.url.href).toBe('https://mineru.net/api/v4/file-urls/batch');
    expect(submission?.init.method).toBe('POST');
    expect(new Headers(submission?.init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(submission?.init.body))).toEqual({
      files: [{ name: 'document.pdf', data_id: dataId, is_ocr: true }],
      model_version: 'vlm',
    });
    expect(upload?.url.href).toBe(uploadUrl);
    expect(upload?.init.method).toBe('PUT');
    expect(upload?.init.headers).toBeUndefined();
    expect(upload?.init.redirect).toBe('error');

    const gate = () => Promise.reject(new Error('stale work'));
    const retryFetch = queue(calls, [
      api({ batch_id: batchId, file_urls: [uploadUrl] }),
    ]);
    await expect(
      submitMineru({ token, bytes, mediaType: 'application/pdf', dataId, beforeUpload: gate, fetch: retryFetch }),
    ).rejects.toThrow('stale work');
    expect(calls.filter((call) => call.init.method === 'PUT')).toHaveLength(1);
  });

  test('returns pending with known and unknown page counts', async () => {
    const calls: Call[] = [];
    const fetch = queue(calls, [
      api({ batch_id: batchId, extract_result: [{ data_id: dataId, state: 'waiting-file' }] }),
      api({
        batch_id: batchId,
        extract_result: [{ data_id: dataId, state: 'running', extract_progress: { total_pages: 2 } }],
      }),
    ]);

    await expect(readMineru({ token, batchId, dataId, fetch })).resolves.toEqual({
      state: 'pending',
      pages: null,
    });
    await expect(readMineru({ token, batchId, dataId, fetch })).resolves.toEqual({
      state: 'pending',
      pages: 2,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      `/api/v4/extract-results/batch/${batchId}`,
      `/api/v4/extract-results/batch/${batchId}`,
    ]);
  });

  test('downloads a valid archive and reads only full.md', async () => {
    const zip = zipSync({
      'full.md': strToU8('# 中文\n'),
      'layout.json': strToU8('{}'),
      'images/a.png': new Uint8Array([1, 2, 3]),
    });
    const calls: Call[] = [];
    const fetch = queue(calls, [
      api({
        batch_id: batchId,
        extract_result: [{ data_id: dataId, state: 'done', full_zip_url: zipUrl }],
      }),
      streamResponse(zip),
    ]);

    await expect(readMineru({ token, batchId, dataId, fetch })).resolves.toEqual({
      state: 'done',
      text: '# 中文\n',
      pages: null,
    });
    expect(calls[0]?.init.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(calls[1]?.init.headers).toBeUndefined();
    expect(calls[1]?.init.redirect).toBe('error');
  });

  test('returns a short displayable failure from a confirmed failed state', async () => {
    const calls: Call[] = [];
    const fetch = queue(calls, [
      api({
        batch_id: batchId,
        extract_result: [{ data_id: dataId, state: 'failed', err_msg: ' 文件格式不支持。 ' }],
      }),
    ]);

    await expect(readMineru({ token, batchId, dataId, fetch })).resolves.toEqual({
      state: 'failed',
      message: 'MinerU 解析失败。',
    });
  });

  test('rejects wrong batch, data id, forged upload URL, and forged result URL', async () => {
    const calls: Call[] = [];
    const forgedUpload = queue(calls, [
      api({
        batch_id: batchId,
        file_urls: [`https://evil.example${uploadPath}`],
      }),
    ]);
    await expect(
      submitMineru({ token, bytes, mediaType: 'application/pdf', dataId, fetch: forgedUpload }),
    ).rejects.toThrow('MinerU 上传地址无效。');

    const wrongPrefix = queue(calls, [
      api({
        batch_id: batchId,
        file_urls: [`https://mineru.oss-cn-shanghai.aliyuncs.com/other/path${uploadPath}`],
      }),
    ]);
    await expect(
      submitMineru({ token, bytes, mediaType: 'application/pdf', dataId, fetch: wrongPrefix }),
    ).rejects.toThrow('MinerU 上传地址无效。');

    const wrongBatch = 'other-batch';
    const wrongBatchResult = queue(calls, [api({ batch_id: wrongBatch, extract_result: [] })]);
    await expect(readMineru({ token, batchId, dataId, fetch: wrongBatchResult })).rejects.toThrow(
      'MinerU 批次结果无效。',
    );

    const wrongDataId = queue(calls, [
      api({ batch_id: batchId, extract_result: [{ data_id: 'other', state: 'pending' }] }),
    ]);
    await expect(readMineru({ token, batchId, dataId, fetch: wrongDataId })).rejects.toThrow(
      'MinerU 批次结果无效。',
    );

    const forgedZip = queue(calls, [
      api({
        batch_id: batchId,
        extract_result: [{ data_id: dataId, state: 'done', full_zip_url: 'https://evil.example/a.zip' }],
      }),
    ]);
    await expect(readMineru({ token, batchId, dataId, fetch: forgedZip })).rejects.toThrow(
      'MinerU 结果地址无效。',
    );
  });

  test('uses fixed short errors for non-success responses without echoing remote bodies', async () => {
    const calls: Call[] = [];
    const secret = 'remote-secret-token';
    const remote = `Bearer ${token} ${secret}`;
    const fetch = queue(calls, [response(`untrusted ${remote}`, { status: 500 })]);

    await expect(
      submitMineru({ token, bytes, mediaType: 'application/pdf', dataId, fetch }),
    ).rejects.toThrow('MinerU 请求失败。');
    expect(String(fetch)).not.toContain(secret);
  });

  test('rejects malformed, empty, oversized, and invalid UTF-8 archives', async () => {
    const cases: readonly Uint8Array[] = [
      new Uint8Array([1, 2, 3]),
      zipSync({ 'other.md': strToU8('x') }),
      zipSync({ 'full.md': new Uint8Array(0) }),
      zipSync({ 'full.md': new Uint8Array([0xff]) }),
    ];
    for (const zip of cases) {
      const calls: Call[] = [];
      const fetch = queue(calls, [
        api({
          batch_id: batchId,
          extract_result: [{ data_id: dataId, state: 'done', full_zip_url: zipUrl }],
        }),
        streamResponse(zip),
      ]);
      await expect(readMineru({ token, batchId, dataId, fetch })).rejects.toThrow(/无效|缺少|UTF-8/);
    }
  });
});
