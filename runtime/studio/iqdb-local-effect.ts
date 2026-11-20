import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EffectRequest, Json } from '../../kernel/src/declarations/types.ts';

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

export async function openLocalQuestionEffect(path?: string) {
  if (!path) return undefined;
  try {
    if (!isAbsolute(path) || !path.endsWith('.wasm')) throw new Error('核验模块须为本机 WASM 文件。');
    const file = await stat(path);
    if (!file.isFile() || file.size > 8 * 1024 * 1024) throw new Error('核验模块超出本机加载限制。');
    const wasm = await readFile(path);
    await runWasm(wasm);
    return {
      execution: { kind: 'local_wasm', moduleDigest: createHash('sha256').update(wasm).digest('hex'), feeMicroUsd: 0 } as const,
      async invoke(request: EffectRequest, invocationId: string): Promise<Json> {
        return JSON.parse(await runWasm(wasm, Buffer.from(JSON.stringify({ ...request, invocationId }))));
      },
    };
  } catch {
    console.error('题库独立核验不可用。请配置有效的本机核验模块。');
    return undefined;
  }
}
