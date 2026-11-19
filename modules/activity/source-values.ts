import type {FactSnapshot} from '@mangekyo/kernel';

export type SourceAnchorV1 =
  | {readonly kind: 'whole'}
  | {readonly kind: 'text'; readonly field: string; readonly start: number; readonly end: number}
  | {readonly kind: 'answer-slot'; readonly itemId: string; readonly slotId: string; readonly path?: readonly (string | number)[]};

export type SourceRefV1 = {
  readonly v: 1;
  readonly fact: {readonly id: string; readonly rev: number; readonly type: string};
  readonly anchor: SourceAnchorV1;
};

export function sourceReference(fact: FactSnapshot, anchor: SourceAnchorV1): SourceRefV1 {
  return {v: 1, fact: {id: fact.ref.id, rev: fact.ref.rev, type: fact.type}, anchor};
}

export function isSourceFactId(input: unknown): input is string {
  return typeof input === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(input);
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined;
}

function offset(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
}

function identifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(input);
}

export function sourceRefV1(input: unknown): SourceRefV1 | undefined {
  const value = record(input);
  const fact = record(value?.fact);
  const anchor = record(value?.anchor);
  if (value?.v !== 1 || !fact || !anchor) return;
  const {id, rev, type} = fact;
  if (!isSourceFactId(id) || !offset(rev) || rev < 1 || rev > 2_147_483_647 || !identifier(type)) return;
  const header = {v: 1 as const, fact: {id, rev, type}};
  if (anchor.kind === 'whole') return {...header, anchor: {kind: 'whole'}};
  if (anchor.kind === 'text') {
    const {field, start, end} = anchor;
    if (identifier(field) && offset(start) && offset(end) && start <= end)
      return {...header, anchor: {kind: 'text', field, start, end}};
  }
  if (anchor.kind === 'answer-slot') {
    const {itemId, slotId, path} = anchor;
    if (!identifier(itemId) || !identifier(slotId)) return;
    if (path !== undefined && (!Array.isArray(path) || [...path].some(part => typeof part !== 'string' && !offset(part)))) return;
    return {...header, anchor: {kind: 'answer-slot', itemId, slotId, ...(path === undefined ? {} : {path: [...path]})}};
  }
  return undefined;
}
