import type {FactSnapshot} from '@mangekyo/kernel';
import { optionalRecord } from './validation.ts';

export type SourceAnchorV1 =
  | {readonly kind: 'whole'}
  | {readonly kind: 'question'; readonly itemId: string}
  | {readonly kind: 'block'; readonly blockId: string}
  | {readonly kind: 'text'; readonly field: string; readonly start: number; readonly end: number}
  | {readonly kind: 'answer-slot'; readonly itemId: string; readonly slotId: string; readonly path?: readonly (string | number)[]};

type SourceFactRef = {readonly id: string; readonly rev: number; readonly type: string};
export type SourceRefV1 = {
  readonly v: 1;
  readonly fact: SourceFactRef;
  readonly textFact?: SourceFactRef;
  readonly anchor: SourceAnchorV1;
};

export function sourceReference(fact: FactSnapshot, anchor: SourceAnchorV1): SourceRefV1 {
  return {v: 1, fact: {id: fact.ref.id, rev: fact.ref.rev, type: fact.type}, anchor};
}

export function isSourceFactId(input: unknown): input is string {
  return typeof input === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(input);
}

const record = optionalRecord;

function offset(input: unknown): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
}

function identifier(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(input);
}

function sourceFactRef(input: unknown): SourceFactRef | undefined {
  const value = record(input);
  if (!value) return;
  const {id, rev, type} = value;
  if (!isSourceFactId(id) || !offset(rev) || rev < 1 || rev > 2_147_483_647 || !identifier(type)) return;
  return {id, rev, type};
}

export function sourceRefV1(input: unknown): SourceRefV1 | undefined {
  const value = record(input);
  if (value?.v !== 1) return;
  const fact = sourceFactRef(value.fact);
  const textFact = sourceFactRef(value.textFact);
  const anchor = record(value.anchor);
  if (!fact || !anchor || ('textFact' in value && !textFact)) return;
  const header = {v: 1 as const, fact, ...(textFact ? {textFact} : {})};
  if (anchor.kind === 'whole') return {...header, anchor: {kind: 'whole'}};
  if (anchor.kind === 'question' && identifier(anchor.itemId))
    return {...header, anchor: {kind: 'question', itemId: anchor.itemId}};
  if (anchor.kind === 'block' && identifier(anchor.blockId))
    return {...header, anchor: {kind: 'block', blockId: anchor.blockId}};
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

export function parseLearningReference(input: string): string | SourceRefV1 | undefined {
  if (isSourceFactId(input)) return input;
  try { return sourceRefV1(JSON.parse(input)); }
  catch { return undefined; }
}
