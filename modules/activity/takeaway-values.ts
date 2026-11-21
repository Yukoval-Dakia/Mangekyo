import { commandId, factId, type CommandId, type FactId, type Tick } from '@mangekyo/kernel';
import { helpRef, type HelpRef } from './help-exposure-values.ts';
import { object } from './values.ts';

export const saveOwnWordsTakeawayCommand = 'activity.saveOwnWordsTakeaway';
export const withdrawOwnWordsTakeawayCommand = 'activity.withdrawOwnWordsTakeaway';
export const ownWordsClaimType = 'activity.ownWordsTakeaway';
export const takeawayTextLimit = 60;

export type OwnWordsTakeawayBinding = {
  readonly paperId: FactId;
  readonly attempt: HelpRef;
  readonly itemId: string;
  readonly requestId: string;
  readonly text: string;
};

export type OwnWordsConceptWitness = {
  readonly id: FactId;
  readonly rev: number;
  readonly accessEpoch: Tick;
};

export type SaveOwnWordsTakeawayInput = {
  readonly id: FactId;
  readonly binding: OwnWordsTakeawayBinding;
  readonly concept?: OwnWordsConceptWitness;
};

export type WithdrawOwnWordsTakeawayInput = {
  readonly id: FactId;
  readonly token: CommandId;
};

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > takeawayTextLimit) {
    throw new Error('口诀须为 60 字以内的文字。');
  }
  return value;
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw new Error('口诀请求标识无效。');
  return value;
}

function itemId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error('口诀题位无效。');
  return value;
}

function conceptWitness(value: unknown): OwnWordsConceptWitness {
  const row = object(value);
  const id = typeof row.id === 'string' ? factId(row.id) : undefined;
  if (!id || typeof row.rev !== 'number' || !Number.isSafeInteger(row.rev) || row.rev < 1 ||
      typeof row.accessEpoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.accessEpoch)) {
    throw new Error('口诀概念锚点无效。');
  }
  return {id, rev: row.rev, accessEpoch: row.accessEpoch as Tick};
}

export function ownWordsTakeawayBinding(input: unknown): OwnWordsTakeawayBinding {
  const row = object(input);
  return {
    paperId: factId(typeof row.paperId === 'string' ? row.paperId : ''),
    attempt: helpRef(row.attempt),
    itemId: itemId(row.itemId),
    requestId: requestId(row.requestId),
    text: text(row.text),
  };
}

export function saveOwnWordsTakeawayInput(input: unknown): SaveOwnWordsTakeawayInput {
  const row = object(input);
  return {
    id: factId(typeof row.id === 'string' ? row.id : ''),
    binding: ownWordsTakeawayBinding(row.binding),
    ...(row.concept === undefined ? {} : { concept: conceptWitness(row.concept) }),
  };
}

export function withdrawOwnWordsTakeawayInput(input: unknown): WithdrawOwnWordsTakeawayInput {
  const row = object(input);
  return {
    id: factId(typeof row.id === 'string' ? row.id : ''),
    token: commandId(typeof row.token === 'string' ? row.token : ''),
  };
}

export function ownWordsClaim(
  binding: OwnWordsTakeawayBinding,
  concept: OwnWordsConceptWitness | undefined,
  attemptAccessEpoch: Tick,
) {
  return {
    version: 1 as const,
    authority: 'directive' as const,
    category: 'claim' as const,
    origin: 'learner' as const,
    action: 'remember' as const,
    scope: {
      kind: 'object' as const,
      ...(concept ? { object: concept.id } : {}),
      anchor: { paperId: binding.paperId, itemId: binding.itemId },
      basis: concept
        ? [
          {id: concept.id, rev: concept.rev, accessEpoch: concept.accessEpoch},
          {id: binding.attempt.id, rev: binding.attempt.rev, accessEpoch: attemptAccessEpoch},
        ]
        : [{id: binding.attempt.id, rev: binding.attempt.rev, accessEpoch: attemptAccessEpoch}],
    },
    evidence_refs: [],
    supersedes: null,
    sticky: true as const,
    text: binding.text,
    valid_until: null,
  };
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isOwnWordsClaim(value: unknown, conceptId?: FactId, attemptId?: FactId,
  paperId?: FactId, itemId?: string): boolean {
  try {
    const row = object(value);
    const scope = object(row.scope);
    const basis = Array.isArray(scope.basis) ? scope.basis : [];
    const anchor = fields(scope.anchor);
    const objectId = scope.object === undefined || typeof scope.object === 'string' ? scope.object as string | undefined : undefined;
    if (scope.object !== undefined && objectId === undefined) return false;
    return row.version === 1 && row.authority === 'directive' && row.category === 'claim' &&
      row.origin === 'learner' && row.action === 'remember' && row.sticky === true &&
      row.valid_until === null && typeof row.text === 'string' && row.text.trim() !== '' &&
      row.text.length <= takeawayTextLimit && Array.isArray(row.evidence_refs) &&
      row.evidence_refs.length === 0 && row.supersedes === null && scope.kind === 'object' &&
      (!conceptId || objectId === conceptId) &&
      (itemId === undefined || (anchor?.itemId === itemId && anchor?.paperId === paperId)) &&
      (objectId === undefined || basis.some(item => fields(item)?.id === objectId)) &&
      (!attemptId || basis.some(item => object(item).id === attemptId));
  } catch {
    return false;
  }
}

/** Fact schema: a sticky learner-authored own-words takeaway bound to a frozen paper slot. */
export function ownWordsTakeawayValue(input: unknown) {
  if (!isOwnWordsClaim(input)) throw new Error('自留口诀记录无效。');
  return input;
}
