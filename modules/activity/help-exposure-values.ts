import { commandId, factId, type FactId, type Revision } from '@mangekyo/kernel';
import { storagePurpose } from './library-values.ts';

export const helpExposureType = 'activity.helpExposure';
export const recordHelpExposureCommand = 'activity.recordHelpExposure';

export type HelpRef = { readonly id: FactId; readonly rev: Revision };
type HelpItem = { readonly itemId: string; readonly responseId?: string };

export type HelpTarget = {
  readonly activityId: FactId;
  readonly issuance: HelpRef;
  readonly item: HelpItem;
};

type HelpStep = {
  readonly kind: 'hint' | 'explanation' | 'worked-example' | 'solution';
  readonly order: number;
};

export type HelpPresentation = {
  readonly mount: HelpTarget;
  readonly alsoAppliesTo: readonly HelpItem[];
  readonly content: HelpRef;
  readonly step: HelpStep;
};

type HelpAnswer = { readonly submission: HelpRef; readonly target: HelpTarget };

export type HelpExposureEvent =
  | (HelpPresentation & { readonly kind: 'prepared' | 'offered' | 'opened' | 'displayed' })
  | {
    readonly kind: 'used';
    readonly display: HelpRef;
    readonly operation: HelpRef;
    readonly target: HelpTarget;
  }
  | { readonly kind: 'assisted-completion'; readonly use: HelpRef; readonly answer: HelpAnswer }
  | { readonly kind: 'follow-up'; readonly display: HelpRef; readonly answer: HelpAnswer };

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('帮助事件须为对象。');
  }
  return input as Record<string, unknown>;
}

function allowFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('帮助事件含有未声明字段。');
  }
}

function textId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('帮助事件缺少标识。');
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('帮助版本与阶次须为正整数。');
  }
  return value;
}

function ref(input: unknown): HelpRef {
  const value = record(input);
  allowFields(value, ['id', 'rev']);
  return { id: factId(textId(value.id)), rev: positiveInteger(value.rev) as Revision };
}
export { ref as helpRef };

function item(input: unknown): HelpItem {
  const value = record(input);
  allowFields(value, ['itemId', 'responseId']);
  return {
    itemId: textId(value.itemId),
    ...('responseId' in value ? { responseId: textId(value.responseId) } : {}),
  };
}

function target(input: unknown): HelpTarget {
  const value = record(input);
  allowFields(value, ['activityId', 'issuance', 'item']);
  return { activityId: factId(textId(value.activityId)), issuance: ref(value.issuance), item: item(value.item) };
}

function step(input: unknown): HelpStep {
  const value = record(input);
  allowFields(value, ['kind', 'order']);
  const { kind, order } = value;
  if (kind !== 'hint' && kind !== 'explanation' && kind !== 'worked-example' && kind !== 'solution') {
    throw new Error('帮助阶次类型无效。');
  }
  return { kind, order: positiveInteger(order) };
}

function answer(input: unknown): HelpAnswer {
  const value = record(input);
  allowFields(value, ['submission', 'target']);
  return { submission: ref(value.submission), target: target(value.target) };
}

export function helpExposure(input: unknown): HelpExposureEvent {
  const value = record(input);
  const { kind } = value;
  switch (kind) {
    case 'prepared':
    case 'offered':
    case 'opened':
    case 'displayed':
      allowFields(value, ['kind', 'mount', 'alsoAppliesTo', 'content', 'step']);
      if (!Array.isArray(value.alsoAppliesTo)) throw new Error('帮助作用范围须为题项列表。');
      return {
        kind,
        mount: target(value.mount),
        alsoAppliesTo: value.alsoAppliesTo.map(item),
        content: ref(value.content),
        step: step(value.step),
      };
    case 'used':
      allowFields(value, ['kind', 'display', 'operation', 'target']);
      return { kind, display: ref(value.display), operation: ref(value.operation), target: target(value.target) };
    case 'assisted-completion':
      allowFields(value, ['kind', 'use', 'answer']);
      return { kind, use: ref(value.use), answer: answer(value.answer) };
    case 'follow-up':
      allowFields(value, ['kind', 'display', 'answer']);
      return { kind, display: ref(value.display), answer: answer(value.answer) };
    default:
      throw new Error('帮助事件类型无效。');
  }
}

export function helpExposureInput(input: unknown) {
  const value = record(input);
  allowFields(value, ['id', 'data']);
  return { id: factId(textId(value.id)), data: helpExposure(value.data) };
}

/** 宿主核对权限、发放题项及实际事件后，为该事件分配一次 ID，并用同一请求重试。 */
export function helpExposureRequest(eventId: FactId, data: HelpExposureEvent) {
  return {
    id: commandId(eventId),
    type: recordHelpExposureCommand,
    input: { id: eventId, data },
    purpose: storagePurpose,
  };
}

export function sameHelpRef(first: HelpRef, second: HelpRef): boolean {
  return first.id === second.id && first.rev === second.rev;
}

function sameIssuance(first: HelpTarget, second: HelpTarget): boolean {
  return first.activityId === second.activityId && sameHelpRef(first.issuance, second.issuance);
}

export function sameHelpTarget(first: HelpTarget, second: HelpTarget): boolean {
  return sameIssuance(first, second) && first.item.itemId === second.item.itemId
    && first.item.responseId === second.item.responseId;
}

export function helpAppliesTo(help: HelpPresentation, target: HelpTarget): boolean {
  if (!sameIssuance(help.mount, target)) return false;
  return [help.mount.item, ...help.alsoAppliesTo].some(item => item.itemId === target.item.itemId
    && (item.responseId === undefined || target.item.responseId === undefined
      || item.responseId === target.item.responseId));
}
