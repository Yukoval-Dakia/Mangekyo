import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CodeSandboxExecutorError } from './validate.ts';
import { capText } from './shared.ts';
import type { SpawnedOutcome, OutcomeKind } from './shared.ts';

export type SpawnSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly input?: string;
  readonly signal?: AbortSignal;
};
const MEMORY_MARKER = /MGKYO_RSS_KB=(\d+)/g;

export function basePathParts(): readonly string[] {
  return [...new Set(['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', path.dirname(process.execPath)])];
}

let cachedPython: string | undefined;
export function pythonCommand(): string {
  if (cachedPython !== undefined) return cachedPython;
  const probe = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'],
    { encoding: 'utf8', timeout: 3000, env: { PATH: basePathParts().join(':') } });
  const resolved = typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
  if (probe.status === 0 && resolved.length > 0) {
    cachedPython = resolved;
    return resolved;
  }
  throw new CodeSandboxExecutorError('python3 解释器不可用，无法执行 python 沙盒。');
}

// Built from scratch: nothing is inherited from the host environment, so API keys,
// tokens and database URLs can never leak into the student process.
export function cleanEnv(scratchDir: string, pythonBinDir?: string): NodeJS.ProcessEnv {
  const parts = pythonBinDir === undefined ? basePathParts() : [pythonBinDir, ...basePathParts()];
  return {
    PATH: [...new Set(parts)].join(':'), HOME: scratchDir, TMPDIR: scratchDir, TEMP: scratchDir, TMP: scratchDir,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONSAFEPATH: '1', PYTHONUTF8: '1',
    NODE_OPTIONS: '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  };
}
export function dockerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: basePathParts().join(':'), HOME: process.env.HOME ?? tmpdir(),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  };
}

function killProcessGroup(pid: number): void {
  // Group kill first, then the lone pid as a fallback for platforms or races where
  // the negative-pid form cannot reach the child; ESRCH simply means it already exited.
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // ESRCH means the process already exited; nothing more to reap here.
    }
  }
}

// One child per case in a detached process group: timeouts, output floods and aborts
// escalate to a group-wide SIGKILL so orphaned grandchildren cannot survive the runner.
// stdout/stderr stay inside the student's maxOutputBytes budget while memory metrics
// travel on the out-of-band fd 3 pipe, and the promise only settles after the kernel
// reaps the child so scratch directories are never removed underneath a live process.
export function runIsolatedProcess(spec: SpawnSpec): Promise<SpawnedOutcome> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(spec.command, [...spec.args], {
      detached: true, cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const metaChunks: Buffer[] = [];
    let combinedBytes = 0;
    let settled = false;
    let pendingKind: OutcomeKind | undefined;
    let closeFallback: NodeJS.Timeout | undefined;
    const stopWatchers = (): void => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
    };
    const finalize = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      stopWatchers();
      clearTimeout(closeFallback);
      let rssKb = 0;
      const metaText = Buffer.concat(metaChunks).toString('utf8');
      for (const match of metaText.matchAll(MEMORY_MARKER)) {
        rssKb = Number.parseInt(match[1] ?? '0', 10);
      }
      const out = capText(Buffer.concat(stdoutChunks).toString('utf8'), spec.maxOutputBytes);
      const err = capText(Buffer.concat(stderrChunks).toString('utf8'), spec.maxOutputBytes);
      resolve({
        kind: pendingKind ?? 'exit', exitCode: pendingKind === undefined ? exitCode : null,
        stdout: out, stderr: err, durationMs: Date.now() - started, rssKb,
      });
    };
    const force = (kind: OutcomeKind): void => {
      if (pendingKind !== undefined || settled) return;
      pendingKind = kind;
      if (typeof child.pid === 'number') killProcessGroup(child.pid);
      closeFallback = setTimeout(() => finalize(null), 500);
      closeFallback.unref();
    };
    const onAbort = (): void => force('aborted');
    const timer = setTimeout(() => force('timeout'), spec.timeoutMs);
    child.on('error', error => {
      if (settled) return;
      settled = true;
      stopWatchers();
      reject(new CodeSandboxExecutorError(`无法启动沙盒子进程：${error.message}`));
    });
    const onData = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (pendingKind !== undefined) return;
      combinedBytes += chunk.length;
      chunks.push(chunk);
      if (combinedBytes > spec.maxOutputBytes) force('output_limit');
    };
    child.stdout.on('data', onData(stdoutChunks));
    child.stderr.on('data', onData(stderrChunks));
    const metaStream = child.stdio[3] as unknown as NodeJS.ReadableStream | null;
    if (metaStream !== null) metaStream.on('data', (chunk: Buffer) => metaChunks.push(chunk));
    child.on('close', code => finalize(code));
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });
    if (child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE when the student exits without reading stdin; close decides the outcome.
      });
      child.stdin.end(spec.input ?? '');
    }
  });
}
