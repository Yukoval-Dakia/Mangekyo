import { factId, type Revision } from '@mangekyo/kernel';

export function captureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('交入记录格式无效。');
  return input as Record<string, unknown>;
}

export function captureText(input: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof input !== 'string' || input.length > limit || !input.isWellFormed() || input.includes('\u0000') ||
      (!allowEmpty && !input.trim())) throw new Error(`${label}无效。`);
  return input;
}

export function sha256(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) throw new Error('原件摘要无效。');
  return input;
}

export function captureRef(input: unknown) {
  const row = captureObject(input);
  if (typeof row.rev !== 'number' || !Number.isSafeInteger(row.rev) || row.rev < 1) throw new Error('原件版本无效。');
  return { id: factId(captureText(row.id, '原件标识', 26)), rev: row.rev as Revision };
}
