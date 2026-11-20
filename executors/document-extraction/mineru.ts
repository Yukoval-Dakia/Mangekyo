import { unzipSync } from 'fflate';

export type MineruMediaType = 'application/pdf' | 'image/png' | 'image/jpeg';

export function mineruSupports(mediaType: string): mediaType is MineruMediaType {
  return mediaType === 'application/pdf' || mediaType === 'image/png' || mediaType === 'image/jpeg';
}

export type MineruReadResult =
  | { readonly state: 'pending'; readonly pages: number | null }
  | { readonly state: 'done'; readonly text: string; readonly pages: number | null }
  | { readonly state: 'failed'; readonly message: string };

type SubmitInput = {
  readonly token: string;
  readonly bytes: Buffer;
  readonly mediaType: MineruMediaType;
  readonly dataId: string;
  readonly beforeUpload?: (() => Promise<void>) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
};

type ReadInput = {
  readonly token: string;
  readonly batchId: string;
  readonly dataId: string;
  readonly beforeDownload?: () => Promise<void>;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
};

type ApiPayload = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

const apiOrigin = 'https://mineru.net';
const uploadHost = 'mineru.oss-cn-shanghai.aliyuncs.com';
const cdnHost = 'cdn-mineru.openxlab.org.cn';
const dataIdPattern = /^[A-Za-z0-9_.-]{1,128}$/;
const batchPattern = /^[A-Za-z0-9-]{1,128}$/;
const sourceLimit = 200 * 1024 * 1024;
const zipLimit = 100 * 1024 * 1024;
const markdownLimit = 20 * 1024 * 1024;
const processingStates = new Set(['waiting-file', 'pending', 'running', 'converting']);

class MineruError extends Error {}

function extensionOf(mediaType: MineruMediaType) {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'image/png') return 'png';
  return 'jpg';
}

function validateDataId(dataId: string) {
  if (!dataIdPattern.test(dataId)) throw new MineruError('MinerU 数据标识无效。');
}

function validateBatchId(batchId: string) {
  if (!batchPattern.test(batchId)) throw new MineruError('MinerU 批次标识无效。');
}

function hasUserInfo(url: URL) {
  return Boolean(url.username || url.password);
}

function validateUploadUrl(value: unknown) {
  if (typeof value !== 'string') throw new MineruError('MinerU 上传地址无效。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MineruError('MinerU 上传地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== uploadHost ||
    hasUserInfo(url) ||
    url.port !== '' ||
    !url.pathname.startsWith('/api-upload/')
  )
    throw new MineruError('MinerU 上传地址无效。');
  return url;
}

function validateZipUrl(value: unknown) {
  if (typeof value !== 'string') throw new MineruError('MinerU 结果地址无效。');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MineruError('MinerU 结果地址无效。');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== cdnHost ||
    hasUserInfo(url) ||
    url.port !== '' ||
    url.pathname === '/'
  )
    throw new MineruError('MinerU 结果地址无效。');
  return url;
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MineruError('MinerU 响应无效。');
  return value as JsonRecord;
}

async function readJson(response: Response): Promise<JsonRecord> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new MineruError('MinerU 响应无效。');
  }
  return asRecord(value);
}

async function apiRequest(
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetcher(new URL(path, apiOrigin), {
      ...init,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof MineruError) throw error;
    if (signal?.aborted) throw error;
    throw new MineruError('无法连接 MinerU。');
  }
  if (!response.ok) throw new MineruError('MinerU 请求失败。');
  const payload = await readJson(response);
  if (payload.code !== 0) throw new MineruError('MinerU 请求失败。');
  return asRecord(payload.data);
}

function pagesOf(result: JsonRecord) {
  const progress = result.extract_progress;
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const pages = (progress as JsonRecord).total_pages;
  return typeof pages === 'number' && Number.isSafeInteger(pages) && pages >= 0 && pages <= 1000 ? pages : null;
}

function failedMessage(value: unknown) {
  return 'MinerU 解析失败。';
}

function selectedResult(data: JsonRecord, dataId: string): JsonRecord | null {
  const value = data.extract_result;
  if (!Array.isArray(value)) throw new MineruError('MinerU 批次结果无效。');
  if (value.length !== 1 || !value[0] || typeof value[0] !== 'object' || Array.isArray(value[0]))
    throw new MineruError('MinerU 批次结果无效。');
  const result = value[0] as JsonRecord;
  if (result.data_id === undefined && processingStates.has(String(result.state))) return null;
  if (result.data_id !== dataId) throw new MineruError('MinerU 批次结果无效。');
  return result;
}

async function downloadZip(
  fetcher: typeof fetch,
  url: URL,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MineruError('无法下载 MinerU 结果。');
  }
  if (!response.ok) throw new MineruError('无法下载 MinerU 结果。');
  if (!response.body) throw new MineruError('无法下载 MinerU 结果。');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declared) && declared > zipLimit)
    throw new MineruError('MinerU 结果过大。');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > zipLimit) {
        await reader.cancel().catch(() => undefined);
        throw new MineruError('MinerU 结果过大。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof MineruError) throw error;
    throw new MineruError('无法下载 MinerU 结果。');
  }
  const zip = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    zip.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return zip;
}

function readMarkdown(zip: Uint8Array): string {
  let selected = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter(file) {
        if (file.name !== 'full.md') return false;
        if (
          selected ||
          (file.compression !== 0 && file.compression !== 8) ||
          file.size > zipLimit ||
          file.originalSize === 0 ||
          file.originalSize > markdownLimit
        )
          throw new MineruError('MinerU 结果包无效。');
        selected = true;
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MineruError) throw error;
    throw new MineruError('MinerU 结果包无效。');
  }
  const markdown = files['full.md'];
  if (!markdown) throw new MineruError('MinerU 结果缺少 full.md。');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(markdown);
  } catch {
    throw new MineruError('MinerU 结果不是有效的 UTF-8。');
  }
}

export async function submitMineru(input: SubmitInput): Promise<string> {
  const { token, bytes, mediaType, dataId, beforeUpload, signal, fetch: providedFetch } = input;
  validateDataId(dataId);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > sourceLimit)
    throw new MineruError('MinerU 文件无效或超过大小限制。');
  const filename = `document.${extensionOf(mediaType)}`;
  const fetcher = providedFetch ?? fetch;
  const data = await apiRequest(
    fetcher,
    '/api/v4/file-urls/batch',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: filename, data_id: dataId, is_ocr: true }],
        model_version: 'vlm',
      }),
    },
    signal,
  );
  const batchId = data.batch_id;
  if (typeof batchId !== 'string') throw new MineruError('MinerU 批次标识无效。');
  validateBatchId(batchId);
  const fileUrls = data.file_urls;
  if (!Array.isArray(fileUrls) || fileUrls.length !== 1)
    throw new MineruError('MinerU 上传响应无效。');
  const uploadUrl = validateUploadUrl(fileUrls[0]);
  if (beforeUpload) await beforeUpload();

  let response: Response;
  try {
    response = await fetcher(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(bytes),
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MineruError('MinerU 文件上传失败。');
  }
  if (!response.ok) throw new MineruError('MinerU 文件上传失败。');
  return batchId;
}

export async function readMineru(input: ReadInput): Promise<MineruReadResult> {
  const { token, batchId, dataId, signal, fetch: providedFetch } = input;
  validateBatchId(batchId);
  validateDataId(dataId);
  const fetcher = providedFetch ?? fetch;
  const data = await apiRequest(
    fetcher,
    `/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    signal,
  );
  if (data.batch_id !== batchId) throw new MineruError('MinerU 批次结果无效。');
  const result = selectedResult(data, dataId);
  if (!result) return { state: 'pending', pages: null };
  const pages = pagesOf(result);
  if (processingStates.has(String(result.state))) return { state: 'pending', pages };
  if (result.state === 'failed') return { state: 'failed', message: failedMessage(result.err_msg) };
  if (result.state !== 'done') throw new MineruError('MinerU 批次状态无效。');
  const zipUrl = validateZipUrl(result.full_zip_url);
  await input.beforeDownload?.();
  const zip = await downloadZip(fetcher, zipUrl, signal);
  if (zip.byteLength === 0 || zip.byteLength > zipLimit) throw new MineruError('MinerU 结果过大。');
  const text = readMarkdown(zip);
  if (text.length > markdownLimit) throw new MineruError('MinerU 结果过大。');
  return { state: 'done', text, pages };
}

export { MineruError };
