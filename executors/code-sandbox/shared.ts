import { randomUUID } from 'node:crypto';
import type { CodeSandboxExecutorKindWire, CodeSandboxRunReportWire, CodeSandboxRunResultWire } from '@mangekyo/kernel';
import type { NormalizedRequest } from './validate.ts';
export const isolatedCodeSandboxKind: CodeSandboxExecutorKindWire = 'isolated-code-sandbox';
export type CaseResult = CodeSandboxRunResultWire;
export type OutcomeKind = 'exit' | 'timeout' | 'output_limit' | 'aborted';
export type SpawnedOutcome = {
  readonly kind: OutcomeKind;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly rssKb: number;
};

export function totalBudgetOf(input: NormalizedRequest): number {
  const slack = Math.min(input.limits.timeoutMs, 2000);
  const fallback = Math.min(input.limits.timeoutMs * input.cases.length + slack, 60_000);
  return Math.min(input.totalTimeoutMs ?? fallback, input.limits.timeoutMs * (input.cases.length + 1));
}
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('code sandbox run aborted'), { name: 'AbortError' });
}

// Byte-precise truncation that never splits a multi-byte UTF-8 sequence: trailing
// continuation bytes walk back to the lead byte, dropping the incomplete tail.
export function capText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function assembleReport(parts: {
  readonly input: NormalizedRequest;
  readonly startedAt: number;
  readonly results: readonly CaseResult[];
  readonly compileError?: string;
  readonly timedOut?: boolean;
  readonly peakRssKb?: number;
  readonly peakMemoryMb?: number;
}): CodeSandboxRunReportWire {
  const cap = parts.input.limits.timeoutMs * (parts.input.cases.length + 1);
  const totalDurationMs = Math.max(0, Math.min(Math.round(Date.now() - parts.startedAt), cap));
  let peakMemoryMb = parts.peakMemoryMb;
  if (peakMemoryMb === undefined && parts.peakRssKb !== undefined && parts.peakRssKb > 0) {
    const mb = Math.round((parts.peakRssKb / 1024) * 100) / 100;
    if (Number.isFinite(mb) && mb <= parts.input.limits.memoryMb * 2) peakMemoryMb = mb;
  }
  return {
    executorKind: isolatedCodeSandboxKind, language: parts.input.language,
    runId: randomUUID(), executedAtIso: new Date(parts.startedAt).toISOString(),
    totalDurationMs, results: parts.results,
    ...(parts.compileError === undefined ? {} : { compileError: parts.compileError }), ...(parts.timedOut ? { timedOut: true } : {}),
    ...(peakMemoryMb === undefined ? {} : { peakMemoryMb }),
  };
}
