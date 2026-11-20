import { factId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆字段需要对象。');
  return value as Record<string, unknown>;
}

export function text(value: unknown, max = 600) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed() || value.includes('\0'))
    throw new Error('记忆文字无效。');
  return value;
}

export function instant(value: unknown) {
  const date = new Date(text(value, 24));
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('需要绝对 UTC 时间。');
  return value as string;
}

export function integer(value: unknown, min: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error('计数或版本无效。');
  return value;
}

export function witness(value: unknown) {
  const ref = record(value);
  if (typeof ref.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(ref.accessEpoch))
    throw new Error('记忆来源需要访问代次。');
  return { id: factId(text(ref.id, 26)), rev: integer(ref.rev, 1) as Revision, accessEpoch: ref.accessEpoch as Tick };
}
export type Witness = ReturnType<typeof witness>;

export function witnessList(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error('必须引用依据。');
  const refs = value.map(witness);
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error('重复依据。');
  return refs;
}

export function allows(purposes: readonly string[], required: string) {
  return purposes.includes(required) || purposes.includes('all');
}

export async function openWitness(read: ReadContext, ref: Witness, purpose: string): Promise<FactSnapshot> {
  const current = await read.fact(ref.id, { mode: 'following' });
  if (current.ref.rev !== ref.rev || current.accessEpoch !== ref.accessEpoch || !allows(current.purpose, purpose))
    throw new Error('来源修订或用途已变化。');
  return current;
}
