import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EffectRequest, Json } from '@mangekyo/kernel';

const limit = 256 * 1024;

async function runWasm(wasm: Buffer, input?: Buffer): Promise<string> {
  if (input && input.length > limit) throw new Error('核验输入超出本机执行限制。');
  const worker = new Worker(new URL('./iqdb-local-effect-worker.js', import.meta.url), {
    env: {}, execArgv: [], workerData: { wasm, input, limit },
  });
  try {
    const [result]: unknown[] = await once(worker, 'message', { signal: AbortSignal.timeout(10_000) });
    if (typeof result !== 'string') throw new Error('本机核验返回无效。');
    return result;
  } finally {
    await worker.terminate();
  }
}

/** Exclude custom sections, so adding metadata does not create another verifier. */
function executableDigest(wasm: Buffer) {
  const digest = createHash('sha256').update(wasm.subarray(0, 8));
  for (let offset = 8; offset < wasm.length;) {
    const start = offset;
    const kind = wasm[offset++]!;
    let size = 0;
    let length = 0;
    let byte: number;
    do {
      byte = wasm[offset++]!;
      size += (byte & 0x7f) * 128 ** length++;
    } while (byte & 0x80);
    const end = offset + size;
    if (kind !== 0) digest.update(wasm.subarray(start, end));
    offset = end;
  }
  return digest.digest('hex');
}

export async function openLocalQuestionVerifier(path: unknown) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.wasm'))
    throw new Error('核验模块须为本机 WASM 文件。');
  const file = await stat(path);
  if (!file.isFile() || file.size > 8 * 1024 * 1024) throw new Error('核验模块超出本机加载限制。');
  const wasm = await readFile(path);
  await runWasm(wasm);
  const execution = {
    kind: 'local_wasm', moduleDigest: createHash('sha256').update(wasm).digest('hex'),
    executableDigest: executableDigest(wasm), feeMicroUsd: 0,
  } as const;
  return {
    execution,
    async invoke(request: EffectRequest, invocationId: string): Promise<Json> {
      return JSON.parse(await runWasm(wasm, Buffer.from(JSON.stringify({ ...request, invocationId }))));
    },
  };
}
