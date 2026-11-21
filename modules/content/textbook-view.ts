import type { CommandReceipt, FactSnapshot, LearnerId, ReadContext } from '@mangekyo/kernel';
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
