import { commandId, factId, learnerId, type BusWitness, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { storagePurpose } from './library-values.ts';
import { positiveRevision, recordParser, textValue, unknownFieldsParser } from './validation.ts';

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
  readonly kind: 'hint' | 'hint_l0' | 'hint_l1' | 'hint_l2' | 'explanation' | 'worked-example' | 'solution';
  readonly order: number;
};

export type HelpPresentation = {
  readonly mount: HelpTarget;
  readonly alsoAppliesTo: readonly HelpItem[];
  readonly content: HelpRef;
  readonly step: HelpStep;
  /** True only when the learner deliberately requested L0 self-help; defaults to system help. */
  readonly learnerRequested?: true;
  readonly controlledBasis?: readonly BusWitness[];
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

const record = recordParser(() => new Error('帮助事件须为对象。'));
const allowFields = unknownFieldsParser(() => new Error('帮助事件含有未声明字段。'));

function textId(value: unknown): string {
  return textValue(value, () => new Error('帮助事件缺少标识。'), { preserveWhitespace: true, storable: false });
}

function positiveInteger(value: unknown): number {
  return positiveRevision(value, () => new Error('帮助版本与阶次须为正整数。'));
}

function stepOrder(value: unknown, kind: unknown): number {
  if (kind === 'hint_l0') {
    if (value !== 0 && value !== 1 || typeof value !== 'number') throw new Error('帮助阶次类型无效。');
    return value;
  }
  return positiveInteger(value);
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
  if (kind !== 'hint' && kind !== 'hint_l0' && kind !== 'hint_l1' && kind !== 'hint_l2' &&
      kind !== 'explanation' && kind !== 'worked-example' && kind !== 'solution') {
    throw new Error('帮助阶次类型无效。');
  }
  const position = stepOrder(order, kind);
  if ((kind === 'hint_l1' && position !== 1) || (kind === 'hint_l2' && position !== 2)) {
    throw new Error('分级提示的档次与阶次不一致。');
  }
  return { kind, order: position };
}

function answer(input: unknown): HelpAnswer {
  const value = record(input);
  allowFields(value, ['submission', 'target']);
  return { submission: ref(value.submission), target: target(value.target) };
}

function controlledBasis(input: unknown): readonly BusWitness[] {
  if (!Array.isArray(input) || !input.length || input.length > 512) throw new Error('受控帮助见证无效。');
  return input.map(value => {
    const row = record(value);
    const { id, rev } = ref({ id: row.id, rev: row.rev });
    const { mode, accessEpoch } = row;
    if ((mode !== 'following' && mode !== 'pinned') || typeof accessEpoch !== 'string' || !/^\d+$/.test(accessEpoch))
      throw new Error('受控帮助见证无效。');
    return { id, rev, mode, learner:learnerId(textId(row.learner)), type:textId(row.type), accessEpoch:accessEpoch as Tick };
  });
}

export async function reopenControlledHelpBasis(read: {fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot>},
  learner: BusWitness['learner'], basis: readonly BusWitness[], teachingPurpose?: string) {
  for (const { id, rev, mode, type, accessEpoch, learner: owner } of basis) {
    if (owner !== learner) return false;
    const witness = await read.fact(id, mode === 'following' ? { mode } : { mode, rev });
    if (witness.type !== type || witness.ref.learner !== owner || witness.ref.rev !== rev || witness.accessEpoch !== accessEpoch)
      return false;
    if (teachingPurpose) {
      const permits = (fact: FactSnapshot) => fact.purpose.includes(teachingPurpose) || fact.purpose.includes('all');
      if (!permits(witness) || (mode === 'pinned' && !permits(await read.fact(id,{mode:'following'})))) return false;
    }
  }
  return true;
}

export function helpExposure(input: unknown): HelpExposureEvent {
  const value = record(input);
  const { kind } = value;
  switch (kind) {
    case 'prepared':
    case 'offered':
    case 'opened':
    case 'displayed':
      allowFields(value, ['kind', 'mount', 'alsoAppliesTo', 'content', 'step', 'learnerRequested', 'controlledBasis']);
      if (!Array.isArray(value.alsoAppliesTo)) throw new Error('帮助作用范围须为题项列表。');
      if (value.controlledBasis !== undefined && kind !== 'opened' && kind !== 'displayed')
        throw new Error('受控帮助只记录实际打开和显示。');
      if (value.learnerRequested !== undefined && value.learnerRequested !== true)
        throw new Error('本人触发标记无效。');
      return {
        kind,
        mount: target(value.mount),
        alsoAppliesTo: value.alsoAppliesTo.map(item),
        content: ref(value.content),
        step: step(value.step),
        ...(value.learnerRequested === undefined ? {} : { learnerRequested: true as const }),
        ...(value.controlledBasis === undefined ? {} : { controlledBasis: controlledBasis(value.controlledBasis) }),
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
