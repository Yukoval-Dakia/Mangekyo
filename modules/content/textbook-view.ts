import type { CommandReceipt, FactSnapshot, LearnerId, ReadContext } from '@mangekyo/kernel';
import { key } from './parse.ts';
import { openTextbookReference, textbookPageFrom, type TextbookBlockBody } from './textbook-page.ts';

export type TextbookReadInput = {
  readonly learner: unknown;
  readonly purpose?: unknown;
};

export type TextbookGetInput = TextbookReadInput & {
  readonly id: unknown;
  readonly rev?: unknown;
};

export type TextbookOpenBlockInput = TextbookGetInput & {
  readonly blockId: unknown;
  readonly mode?: unknown;
};

export type TextbookCreateInput = TextbookReadInput & {
  readonly requestId: unknown;
  readonly id?: unknown;
  readonly clientEditSeq: unknown;
  readonly page: unknown;
};

export type TextbookReviseInput = TextbookReadInput & {
  readonly requestId: unknown;
  readonly id: unknown;
  readonly expectedRev: unknown;
  readonly clientEditSeq: unknown;
  readonly edits: unknown;
};

type ReferenceWitness = Awaited<ReturnType<typeof openTextbookReference>> & {
  readonly blockId: string;
};

export type TextbookPageView = {
  readonly kind: 'textbook';
  readonly id: string;
  readonly rev: number;
  readonly learner: LearnerId;
  readonly accessEpoch: string;
  readonly purpose: readonly string[];
  readonly title: string;
  readonly blocks: ReturnType<typeof textbookPageFrom>['blocks'];
  readonly references: readonly ReferenceWitness[];
};

export type TextbookSummary = {
  readonly kind: 'textbook' | 'legacyNote';
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly purpose: readonly string[];
  readonly readOnly: boolean;
};

export type TextbookWriteReceipt = CommandReceipt & {
  readonly requestId: string;
  readonly clientEditSeq: number;
  readonly id: string;
  readonly expectedRev: number | null;
  readonly rev: number;
};

export class TextbookConflictError extends Error {
  constructor(
    readonly code: 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'CLIENT_EDIT_SEQ_CONFLICT',
    readonly current: TextbookPageView,
    readonly originalEdit: import('./textbook-edits.ts').TextbookRevision,
    readonly requestId: string,
    readonly previousReceipt?: CommandReceipt,
  ) {
    super('教材已在别处更新，原编辑已保留，请核对当前版本。');
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

export function accessPurpose(value: unknown): string {
  if (value === undefined) return 'storage';
  if (typeof value !== 'string' || !value.trim()) throw new Error('读取用途无效。');
  return value;
}

export function creationPurposes(value: unknown): { readonly access: string; readonly fact: readonly string[] } {
  if (value === undefined || typeof value === 'string') {
    const access = accessPurpose(value);
    return { access, fact: [access] };
  }
  if (!Array.isArray(value) || !value.length || value.some(entry => typeof entry !== 'string' || !entry)
    || new Set(value).size !== value.length) {
    throw new Error('教材用途无效。');
  }
  return { access: value[0] as string, fact: [...value] as string[] };
}

export class TextbookReferenceScopeError extends Error {}

export async function checkBodyReference(read: ReadContext, learner: LearnerId, blockId: string, body: TextbookBlockBody) {
  const reference = body.kind === 'image' ? body.source : body.kind === 'reference' ? body.target : null;
  if (!reference) return null;
  if (reference.fact.learner !== learner) throw new TextbookReferenceScopeError('不能读取其他学习者的引用。');
  const witness = await openTextbookReference(read, reference);
  return { blockId, ...witness };
}

export async function pageView(read: ReadContext, fact: FactSnapshot): Promise<TextbookPageView> {
  const page = textbookPageFrom(fact);
  const references: ReferenceWitness[] = [];
  for (const block of page.blocks) {
    const witness = await checkBodyReference(read, fact.ref.learner, block.id, block.body);
    if (witness) references.push(witness);
  }
  return { kind: 'textbook', ...fact.ref, accessEpoch: fact.accessEpoch, purpose: fact.purpose, ...page, references };
}

export function textbookWriteReceipt(receipt: CommandReceipt, requestId: string, edit: {
  readonly id: string; readonly clientEditSeq: number; readonly expectedRev: number | null;
}): TextbookWriteReceipt {
  const written = receipt.wrote.find(ref => ref.id === edit.id);
  if (!written) throw new Error('Textbook command receipt has no page write');
  return { ...receipt, requestId, clientEditSeq: edit.clientEditSeq, id: edit.id,
    expectedRev: edit.expectedRev, rev: written.rev };
}

export function classifyTextbookWriteError(error: unknown): { readonly status: 400 | 403 | 404 | 409; readonly message: string } | null {
  if (!(error instanceof Error)) return null;
  const { message } = error;
  if (message === 'Command ID already used with a different command identity') return { status: 409, message: '同一个请求标识已经用于不同编辑。' };
  if (message.startsWith('Fact already exists: ')) return { status: 409, message: '教材标识已经存在。' };
  if (message.startsWith('Fact does not exist: ')) return { status: 404, message: '找不到要编辑的教材。' };
  if (message.startsWith('Fact is retracted: ')) return { status: 409, message: '这份教材已经撤回。' };
  if (message.startsWith('Fact purpose does not allow this write: ')) return { status: 403, message: '当前用途不能编辑这份教材。' };
  if (message === '教材依据已变更。') return { status: 403, message: '教材来源已变更。' };
  if (message === 'Proposal not found') return { status: 404, message: '找不到教材提议。' };
  if (message === 'Proposal already decided' || message.startsWith('Fact revision conflict: ') ||
      message === 'Only an unedited companion draft can be revised') return { status: 409, message: '教材或提议已变更，请刷新。' };
  if (/^(教材|引用|插入位置|来源)/.test(message)) return { status: 400, message };
  return null;
}

export function parseProposalBlockSelection(blockIds: unknown): string[] {
  if (!Array.isArray(blockIds) || blockIds.length > 24) throw new Error('请选择教材块。');
  const selected = blockIds.map(key).sort();
  if (new Set(selected).size !== selected.length) throw new Error('请勿重复选择教材块。');
  return selected;
}

export function projectTextbookProposalView<Base extends { readonly rev: number }, Item>(
  proposal: { readonly id: string; readonly state: string }, base: Base, items: Item,
  currentRev: number, receipt: CommandReceipt | undefined, undoToken: string,
) {
  const output = receipt?.output;
  const blockIds = output && typeof output === 'object' && 'selection' in output && Array.isArray(output.selection)
    ? output.selection as readonly string[] : [];
  const written = receipt?.wrote[0];
  const status = proposal.state === 'confirmed' ? 'applied' : proposal.state === 'rejected' ? 'rejected'
    : proposal.state === 'conflict' || currentRev !== base.rev ? 'conflict' : 'proposed';
  return { proposalId: proposal.id, status, base, items, blockIds,
    result: written ? { id: written.id, rev: written.rev, undo_token: undoToken } : null };
}
