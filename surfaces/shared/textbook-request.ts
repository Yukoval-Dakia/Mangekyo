import { learnerId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt } from '../../kernel/src/declarations/types.ts';
import type { TextbookPageView } from '../../modules/content/textbook-view.ts';
import type { TextbookRevision } from '../../modules/content/textbook-edits.ts';
import { RequestError } from './request-error.ts';

export class TextbookConflictError extends RequestError {
  constructor(
    readonly code: 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'CLIENT_EDIT_SEQ_CONFLICT',
    readonly current: TextbookPageView,
    readonly originalEdit: TextbookRevision,
    readonly requestId: string,
    readonly previousReceipt?: CommandReceipt,
  ) {
    super(409, '教材已在别处更新，原编辑已保留，请核对当前版本。');
    this.name = 'TextbookConflictError';
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      current: this.current,
      originalEdit: this.originalEdit,
      requestId: this.requestId,
      ...(this.previousReceipt ? { previousReceipt: this.previousReceipt } : {}),
    };
  }
}

export function invalid(message: string): never {
  throw new RequestError(400, message);
}

export function parseInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { return invalid(error instanceof Error ? error.message : '教材数据无效。'); }
}

export function scopedLearner(value: unknown): LearnerId {
  if (typeof value !== 'string') return invalid('学习者标识无效。');
  try { return learnerId(value); } catch { return invalid('学习者标识无效。'); }
}

export function selectedBlockIds(blockIds: unknown, parseKey: (value:unknown) => string) {
  if (!Array.isArray(blockIds) || blockIds.length > 24) invalid('请选择教材块。');
  const selected = parseInput(() => blockIds.map(parseKey).sort());
  if (new Set(selected).size !== selected.length) invalid('请勿重复选择教材块。');
  return selected;
}

export type TurnPagePreview = {confirmationId:string; answer:string; page:string; rev:number; title:string};
export type TurnPageReceipt = {status:'applied'; ref:{id:string;rev:number}; undo_token:string};
