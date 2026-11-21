import { factId, type FactId, type Revision, type Tick } from './ids.ts';

export type FactRevisionBasis = {
  readonly id: FactId;
  readonly rev: Revision;
  readonly epoch: Tick;
};

export function parseFactRevisionBasis(input: unknown): FactRevisionBasis {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('依据格式无效。');
  const { id, rev, epoch } = input as Record<string, unknown>;
  if (typeof id !== 'string') throw new Error('依据标识无效。');
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) throw new Error('依据版本无效。');
  const accessEpoch = typeof epoch === 'number' && Number.isSafeInteger(epoch) ? String(epoch) : epoch;
  if (typeof accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accessEpoch)) {
    throw new Error('依据访问代次无效。');
  }
  return { id: factId(id), rev: rev as Revision, epoch: accessEpoch as Tick };
}
