import {
  stableId,
  type CommandId,
  type FactId,
  type FactSnapshot,
  type Json,
  type LearnerId,
  type Revision,
} from '@mangekyo/kernel';
import { RequestError } from './request.ts';
import { NotionSourceChanged, NotionSourceUnavailable, NotionTemporaryFailure } from './notion-api.ts';
import { NotionBlockUnavailable } from './notion-blocks.ts';
import { notionBlockDeriver, notionBlockSlot, parseNotionBlockWorkKey } from './notion-block-work.ts';
import { NotionSelectionUnavailable } from './notion-source.ts';
import type { CheckNotionRead } from './notion-read-plan.ts';
import type { sourceEnvelope } from './source.ts';
import type { NotionSelection } from './notion-selection.ts';

export class FetchRequired extends Error {}

export const staleNotionError = () => new RequestError(409, '选源或原件版本已变更，请刷新后重试。');

export function parseNotionSettings<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new RequestError(400, 'Notion 选源格式无效。');
  }
}

export function notionDenialOwner(id: string, epoch: string): string {
  return stableId('notion-access-denial', id, epoch);
}

export type NotionAccessPreset = {
  readonly id: string;
  readonly available: boolean;
  readonly allowedRecipients: readonly { readonly id: string; readonly purpose: string; readonly label?: string }[];
  readonly reason?: string;
};

export function notionAvailablePresets(
  learningReader: { readonly id: string; readonly purpose: string; readonly label: string },
  teachingRecipients: readonly { readonly id: string; readonly purpose: string }[],
): NotionAccessPreset[] {
  return [
    { id: 'storage', available: true, allowedRecipients: [] },
    { id: 'learning', available: true, allowedRecipients: [learningReader, ...teachingRecipients] },
    { id: 'turn-only', available: false, allowedRecipients: [], reason: '当前会话尚无能复验本轮接收人和留存策略的出口。' },
    { id: 'temporary', available: false, allowedRecipients: [], reason: '临时材料尚无独立密钥、到期销毁和接收人复核出口。' },
  ];
}

export type NotionProviderFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'temporary'; readonly error: NotionTemporaryFailure }
  | { readonly kind: 'passthrough'; readonly error: unknown }
  | { readonly kind: 'request'; readonly error: RequestError };

export function classifyNotionProviderError(
  error: unknown,
  rememberDenial: boolean,
  preserveTemporary: boolean,
  isLifecycle: (error: unknown) => boolean,
): NotionProviderFailure {
  if (error instanceof NotionSourceUnavailable && error.invalidated) {
    if (!rememberDenial) return { kind: 'passthrough', error };
    return { kind: 'denied' };
  }
  if (preserveTemporary && error instanceof NotionTemporaryFailure) return { kind: 'temporary', error };
  if (error instanceof RequestError || isLifecycle(error) || error instanceof NotionSourceChanged)
    return { kind: 'passthrough', error };
  return { kind: 'request', error: new RequestError(502, '未能完整核实 Notion 来源，请重试。') };
}

export function notionReadStatusOf(error: unknown, isLifecycle: (error: unknown) => boolean): 'withdrawn' | 'unconfirmed' | undefined {
  if (error instanceof RequestError) return error.status === 403 ? 'withdrawn' : 'unconfirmed';
  return isLifecycle(error) ? 'unconfirmed' : undefined;
}

export function notionReadErrorFor(deps: { readonly denied: () => Error; readonly unchecked: () => Error; readonly temporaryFailure: () => Error; readonly unconfirmed: () => Error }, status: 'authorized' | 'withdrawn' | 'unconfirmed' | 'temporary-failure' | undefined): Error {
  return status === undefined ? deps.unchecked()
    : status === 'withdrawn' ? deps.denied()
    : status === 'temporary-failure' ? deps.temporaryFailure()
    : deps.unconfirmed();
}

export type NotionWitnessBasis = { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string };

export function notionWitnessesOf(
  facts: readonly { readonly id: string; readonly rev: number; readonly accessEpoch: string }[],
  rows: readonly { readonly id: string; readonly rev: number }[],
  captureSourceTypeValue: string,
): NotionWitnessBasis[] {
  const ids = new Set(rows.map(row => row.id + ':' + row.rev));
  return facts
    .filter(fact => ids.has(fact.id + ':' + fact.rev))
    .map(fact => ({ id: fact.id, rev: fact.rev, epoch: fact.accessEpoch, type: captureSourceTypeValue }));
}

export type NotionSourceTargetFields = {
  readonly expectedRev: unknown;
  readonly accessEpoch: unknown;
  readonly preset: unknown;
  readonly selectionFields: Record<string, unknown>;
};

export function splitNotionSourceFields(fields: Record<string, unknown>): NotionSourceTargetFields {
  const { expectedRev, accessEpoch, preset, ...selectionFields } = fields;
  return { expectedRev, accessEpoch, preset, selectionFields };
}

export function validateNotionSourceAction(
  action: 'purpose' | 'retract',
  preset: unknown,
  recipient: unknown,
): void {
  if (recipient || (action === 'purpose' ? preset !== 'storage' : preset !== undefined))
    throw new RequestError(400, action === 'purpose' ? '此操作只将该原件收窄为本人存储。' : '此操作仅撤回单个原件。');
}

export function validateNotionSelectionAction(action: string, change: { readonly [k: string]: unknown }): void {
  if (action === 'sync') {
    if ('recipient' in change) throw new RequestError(400, '同步仅接受选源标识与代次。');
    return;
  }
  if (action !== 'revoke' && action !== 'grant') throw new RequestError(400, '无效的选源操作。');
}

export function checkNotionPresetRecipients(
  preset: NotionAccessPreset | undefined,
  recipients: readonly { readonly id: string; readonly purpose: string }[],
): void {
  if (!preset) return;
  if (!preset.available) throw new RequestError(422, preset.reason!);
  if (recipients.some(use => !preset.allowedRecipients.some(r => r.id === use.id && r.purpose === use.purpose)))
    throw new RequestError(400, '接收人或用途未在此宿主启用。');
}

export function notionSyncCheck(selection: NotionSelection): void {
  if (selection.preset !== 'storage' && selection.preset !== 'learning')
    throw new RequestError(422, '短期材料不能同步为长期原件。');
}

export function requireDeletionWatermarkField(raw: Record<string, unknown>): void {
  if (raw.deletionWatermark === undefined) throw new RequestError(400, '需要设备原始删除水位。');
}

export function staleIfMissing(current: { readonly selectionEpoch?: string } | null | undefined, expectedEpoch: string): void {
  if ((current?.selectionEpoch ?? '0') !== expectedEpoch) throw staleNotionError();
}

export function revokedSelectionMissing(action: string, current: unknown): void {
  if (!current && action === 'revoke') throw new RequestError(404, '没有该选源。');
}

export function savedRevOf(wrote: readonly { readonly rev: number }[], fallback: string): string {
  return String(wrote[0]?.rev ?? fallback);
}

export function checkRetractedRev(row: { readonly retracted_rev: number | null } | undefined, saved: string): void {
  if (!row || String(row.retracted_rev) !== saved) throw staleNotionError();
}

export function checkPurposeRev(fact: { readonly ref: { readonly rev: number }; readonly purpose: readonly string[] }, saved: string): void {
  if (String(fact.ref.rev) !== saved || fact.purpose.length !== 1 || fact.purpose[0] !== 'storage') throw staleNotionError();
}

export function checkEpochAdvanced(next: { readonly selectionEpoch: string } | null | undefined, epoch: string): void {
  if (next?.selectionEpoch !== epoch) throw staleNotionError();
}

export function checkSourceStale(
  fact: { readonly ref: { readonly rev: number }; readonly accessEpoch: string; readonly value: unknown },
  envelopeOf: (value: unknown) => { readonly sourceSelectionId?: string },
  selectionId: string,
  expectedRev: unknown,
  accessEpoch: unknown,
): void {
  if (envelopeOf(fact.value).sourceSelectionId !== selectionId || fact.ref.rev !== expectedRev || fact.accessEpoch !== accessEpoch)
    throw staleNotionError();
}

export function notionDeniedPages(rows: readonly { readonly step_key: string }[]): Set<string> {
  return new Set(rows.map(row => row.step_key));
}

export function translateWorkspaceReceiptError(error: unknown): never {
  if (error instanceof Error && error.message === 'Workspace read receipt does not match the request')
    throw staleNotionError();
  throw error;
}

export function translatePreparedSyncError(error: unknown): never {
  if (error instanceof NotionSourceChanged) throw staleNotionError();
  throw error;
}

export function translateSyncRowError(error: unknown): never {
  if (error instanceof Error && error.message === 'Notion 页面观测已过时或同一版本不一致。')
    throw staleNotionError();
  throw error;
}

export function isFetchRequired(error: unknown): boolean {
  return error instanceof FetchRequired;
}

export function notionSyncSourcePurpose(purposes: readonly string[]): string[] {
  return [...new Set(['storage', ...purposes])];
}

export function checkRevMatch(
  current: { readonly id: string; readonly rev: number } | undefined,
  before: readonly { readonly id: string; readonly rev: number }[],
  id: string,
): void {
  if (current?.rev !== before.find(item => item.id === id)?.rev) throw staleNotionError();
}

export function uniqueNotionPages<P extends { readonly selection: { readonly id: string }; readonly pageId: string }>(
  pages: readonly P[],
  pageKey: (page: P) => string,
): P[] {
  return [...new Map(pages.map(page => [pageKey(page), page])).values()];
}

export function sourceAuthorityOf(
  selection: NotionSelection,
  externalId: string,
  watermark: string,
): { readonly selection: NotionSelection; readonly pageId: string; readonly watermark: string } {
  return { selection, pageId: externalId, watermark };
}

export function liveSelectionOrStale(
  selection: NotionSelection | null | undefined,
  epoch: string,
): NotionSelection {
  if (!selection?.active || selection.selectionEpoch !== epoch) throw staleNotionError();
  return selection;
}

export type NotionMutateOutcome =
  | { readonly kind: 'source'; readonly action: 'purpose' | 'retract'; readonly requestId: string; readonly watermark: string; readonly fields: Record<string, unknown>; readonly sourceId: string }
  | { readonly kind: 'sync'; readonly requestId: string; readonly watermark: string; readonly selectionId: string; readonly expectedEpoch: string }
  | { readonly kind: 'choice'; readonly action: 'grant' | 'revoke'; readonly requestId: string; readonly watermark: string; readonly fields: Record<string, unknown>; readonly selectionId: string; readonly expectedEpoch: string };

export type NotionMutationPlan =
  | {
      readonly kind: 'source';
      readonly action: 'purpose' | 'retract';
      readonly requestId: string;
      readonly watermark: string;
      readonly target: unknown;
      readonly selectionId: string;
      readonly expectedEpoch: string;
      readonly expectedRev: unknown;
      readonly accessEpoch: unknown;
    }
  | { readonly kind: 'sync'; readonly requestId: string; readonly watermark: string; readonly selectionId: string; readonly expectedEpoch: string }
  | {
      readonly kind: 'choice';
      readonly action: 'grant' | 'revoke';
      readonly requestId: string;
      readonly watermark: string;
      readonly fields: Record<string, unknown>;
      readonly selectionId: string;
      readonly expectedEpoch: string;
      readonly presetSettings: { readonly preset: string; readonly recipients: readonly { readonly id: string; readonly purpose: string }[] } | undefined;
    };

export type NotionMutationDeps = {
  readonly clientRequest: (value: unknown) => string;
  readonly submittedWatermark: (input: unknown) => string;
  readonly selectionChange: (fields: Record<string, unknown>) => {
    readonly selectionId: string;
    readonly expectedEpoch: string;
    readonly recipient?: unknown;
    readonly settings?: { readonly preset: string; readonly recipients: readonly { readonly id: string; readonly purpose: string }[] };
  };
  readonly selectionGrant: (fields: Record<string, unknown>) => {
    readonly selectionId: string;
    readonly expectedEpoch: string;
    readonly settings?: { readonly preset: string; readonly recipients: readonly { readonly id: string; readonly purpose: string }[] };
  };
  readonly notionSourceTarget: (input: { readonly id: string; readonly selectionId: string; readonly expectedRev: unknown; readonly accessEpoch: unknown }) => { readonly id: string };
};


export function planNotionMutation(
  action: string,
  raw: Record<string, unknown>,
  sourceId: string | undefined,
  deps: NotionMutationDeps,
): NotionMutationPlan {
  const requestId = deps.clientRequest(raw.requestId);
  requireDeletionWatermarkField(raw);
  const watermark = deps.submittedWatermark(raw);
  const { requestId: _request, deletionWatermark: _watermark, ...fields } = raw;
  if ((action === 'purpose' || action === 'retract') && sourceId) {
    const { expectedRev, accessEpoch, preset, selectionFields } = splitNotionSourceFields(fields);
    const { selectionId, expectedEpoch, recipient } = parseNotionSettings(() => deps.selectionChange(selectionFields));
    validateNotionSourceAction(action as 'purpose' | 'retract', preset, recipient);
    return {
      kind: 'source',
      action: action as 'purpose' | 'retract',
      requestId,
      watermark,
      target: parseNotionSettings(() => deps.notionSourceTarget({ id: sourceId, selectionId, expectedRev, accessEpoch })),
      selectionId,
      expectedEpoch,
      expectedRev,
      accessEpoch,
    };
  }
  const change = parseNotionSettings(() => (action === 'grant' ? deps.selectionGrant(fields) : deps.selectionChange(fields)));
  const { selectionId, expectedEpoch } = change;
  if (action === 'sync') {
    validateNotionSelectionAction('sync', change as { readonly [k: string]: unknown });
    return { kind: 'sync', requestId, watermark, selectionId, expectedEpoch };
  }
  validateNotionSelectionAction(action, change as { readonly [k: string]: unknown });
  return {
    kind: 'choice',
    action: action as 'grant' | 'revoke',
    requestId,
    watermark,
    fields,
    selectionId,
    expectedEpoch,
    presetSettings: 'settings' in change ? change.settings : undefined,
  };
}

export type StudioNotionCommandRequest = {
  readonly deletionWatermark?: string;
  readonly learner: LearnerId;
  readonly id: CommandId;
  readonly type: string;
  readonly input: Json;
  readonly actor: 'learner' | 'companion';
  readonly purpose: string;
};

export type NotionSourceMutationHost<Tx> = {
  readonly openFollowing: (tx: Tx, id: FactId) => Promise<{ readonly ref: { readonly rev: number }; readonly accessEpoch: string; readonly value: unknown; readonly purpose: readonly string[] }>;
  readonly sourceEnvelope: (value: unknown) => { readonly sourceSelectionId?: string };
  readonly handle: (tx: Tx) => (command: StudioNotionCommandRequest) => Promise<{ readonly wrote: readonly { readonly id: string; readonly rev: number }[] }>;
  readonly record: (tx: Tx, requestId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) => Promise<string>;
  readonly live: (tx: Tx, id: string, epoch: string, watermark: string) => Promise<unknown>;
  readonly readRetractedRev: (tx: Tx, id: FactId) => Promise<{ readonly retracted_rev: number | null; readonly access_epoch: string } | undefined>;
  readonly setNotionPurposeCommand: string;
  readonly revokeNotionSourceCommand: string;
  readonly commandIdOf: (value: string) => unknown;
  readonly stableIdOf: (...parts: string[]) => string;
};

export async function runNotionSourceMutation<Tx>(
  host: NotionSourceMutationHost<Tx>,
  tx: Tx,
  plan: Extract<NotionMutationPlan, { readonly kind: 'source' }>,
): Promise<
  | { readonly id: string | undefined; readonly rev: number | null; readonly accessEpoch: string; readonly retracted: true }
  | { readonly id: string | undefined; readonly rev: number; readonly accessEpoch: string; readonly purpose: readonly string[] }
> {
  const target = plan.target as { readonly id: FactId } & Record<string, unknown>;
  const read = () => host.openFollowing(tx, target.id);
  const saved = await host.record(tx, plan.requestId,
    plan.action === 'purpose'
      ? ({ action: plan.action, target, preset: 'storage', expectedEpoch: plan.expectedEpoch, watermark: plan.watermark } as unknown as Json)
      : ({ action: plan.action, target, expectedEpoch: plan.expectedEpoch, watermark: plan.watermark } as unknown as Json),
    async () => {
      const fact = await read();
      checkSourceStale(fact, host.sourceEnvelope, plan.selectionId, plan.expectedRev, plan.accessEpoch);
      const receipt = await host.handle(tx)({
        learner: (tx as { learner: LearnerId }).learner,
        actor: 'learner',
        purpose: 'storage',
        deletionWatermark: plan.watermark,
        type: plan.action === 'purpose' ? host.setNotionPurposeCommand : host.revokeNotionSourceCommand,
        id: host.commandIdOf(host.stableIdOf(plan.action === 'purpose' ? 'notion-purpose' : 'notion-retract', plan.requestId)) as CommandId,
        input: (plan.action === 'purpose' ? { ...target, preset: 'storage' } : target) as unknown as Json,
      });
      return savedRevOf(receipt.wrote, String(plan.expectedRev));
    },
    async () => { await host.live(tx, plan.selectionId, plan.expectedEpoch, plan.watermark); });
  if (plan.action === 'retract') {
    const row = await host.readRetractedRev(tx, target.id);
    checkRetractedRev(row, saved);
    return { id: target.id as unknown as string, rev: row!.retracted_rev, accessEpoch: row!.access_epoch, retracted: true };
  }
  const fact = await read();
  checkPurposeRev(fact, saved);
  return { id: target.id as unknown as string, rev: fact.ref.rev, accessEpoch: fact.accessEpoch, purpose: fact.purpose };
}

export type NotionChoiceMutationHost<Tx> = {
  readonly selectionAt: (tx: Tx, id: string) => Promise<{ readonly selectionEpoch: string; readonly active?: boolean } | null | undefined>;
  readonly handle: (tx: Tx) => (command: StudioNotionCommandRequest) => Promise<{ readonly wrote: readonly { readonly rev: number }[] }>;
  readonly record: (tx: Tx, requestId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) => Promise<string>;
  readonly assertDeletionWatermark: (tx: Tx, watermark: string) => Promise<void>;
  readonly availablePresets: () => Promise<readonly NotionAccessPreset[]>;
  readonly grantNotionSelectionCommand: string;
  readonly revokeNotionSelectionCommand: string;
  readonly commandIdOf: (value: string) => unknown;
  readonly stableIdOf: (...parts: string[]) => string;
};

export async function runNotionChoiceMutation<Tx>(
  host: NotionChoiceMutationHost<Tx>,
  tx: Tx,
  plan: Extract<NotionMutationPlan, { readonly kind: 'choice' }>,
): Promise<{ readonly selectionId: string; readonly epoch: string; readonly active: boolean | undefined }> {
  const type = plan.action === 'grant' ? host.grantNotionSelectionCommand : host.revokeNotionSelectionCommand;
  const epoch = await host.record(tx, plan.requestId,
    { action: plan.action, fields: plan.fields, watermark: plan.watermark } as unknown as Json,
    async () => {
      if (plan.presetSettings) {
        const preset = (await host.availablePresets()).find(p => p.id === plan.presetSettings!.preset)!;
        checkNotionPresetRecipients(preset, plan.presetSettings.recipients);
      }
      const current = await host.selectionAt(tx, plan.selectionId);
      staleIfMissing(current, plan.expectedEpoch);
      revokedSelectionMissing(plan.action, current);
      const saved = await host.handle(tx)({
        learner: (tx as { learner: LearnerId }).learner,
        actor: 'learner',
        purpose: 'storage',
        deletionWatermark: plan.watermark,
        type,
        id: host.commandIdOf(host.stableIdOf('notion-choice', plan.requestId)) as CommandId,
        input: plan.fields as unknown as Json,
      });
      return savedRevOf(saved.wrote, plan.expectedEpoch);
    },
    () => host.assertDeletionWatermark(tx, plan.watermark));
  const next = await host.selectionAt(tx, plan.selectionId);
  checkEpochAdvanced(next, epoch);
  return { selectionId: plan.selectionId, epoch, active: next!.active };
}

export type NotionSyncRowItem = {
  readonly id: FactId;
  readonly envelope: { readonly externalId?: string };
} & Record<string, unknown>;

export type NotionSyncCommitHost<Tx> = {
  readonly sources: (tx: Tx, selection: NotionSelection) => Promise<readonly { readonly id: FactId; readonly rev: number }[]>;
  readonly checkDenial: (tx: Tx, id: string, epoch: string, page?: string) => Promise<void>;
  readonly openFollowing: (tx: Tx, id: FactId) => Promise<{ readonly ref: { readonly rev: number }; readonly accessEpoch: string; readonly value: unknown } | null | undefined>;
  readonly sourceEnvelope: (value: unknown) => unknown;
  readonly prepareNotionRefreshInput: (
    target: { readonly id: FactId; readonly expectedRev: number; readonly accessEpoch: string; readonly selectionId: string },
    before: never,
    envelope: never,
  ) => Promise<Record<string, unknown>>;
  readonly handle: (tx: Tx) => (command: StudioNotionCommandRequest) => Promise<{ readonly wrote: readonly { readonly id: string; readonly rev: number }[] }>;
  readonly refreshNotionSourceCommand: string;
  readonly captureSourceCommand: string;
  readonly commandIdOf: (value: string) => unknown;
  readonly stableIdOf: (...parts: string[]) => string;
};

export async function runNotionSyncRows<Tx>(
  host: NotionSyncCommitHost<Tx>,
  tx: Tx,
  args: {
    readonly selection: NotionSelection;
    readonly selectionId: string;
    readonly epoch: string;
    readonly watermark: string;
    readonly requestId: string;
    readonly before: readonly { readonly id: FactId; readonly rev: number }[];
    readonly prepared: readonly NotionSyncRowItem[];
  },
): Promise<{ readonly id: FactId; readonly rev: number }[]> {
  const refs: { id: FactId; rev: number }[] = [];
  const current = await host.sources(tx, args.selection);
  for (const item of args.prepared) {
    const prior = current.find(entry => entry.id === item.id);
    checkRevMatch(prior, args.before, item.id);
    await host.checkDenial(tx, args.selectionId, args.epoch, item.envelope.externalId);
    const fact = prior ? await host.openFollowing(tx, item.id) : null;
    const input = fact
      ? await host.prepareNotionRefreshInput(
          { id: item.id, expectedRev: fact.ref.rev, accessEpoch: fact.accessEpoch, selectionId: args.selectionId },
          host.sourceEnvelope(fact.value) as never, item.envelope as never)
      : { ...item, purpose: notionSyncSourcePurpose(args.selection.recipients.map(r => r.purpose)) };
    const saved = await host.handle(tx)({
      learner: (tx as { learner: LearnerId }).learner,
      actor: 'companion',
      purpose: 'storage',
      deletionWatermark: args.watermark,
      type: fact ? host.refreshNotionSourceCommand : host.captureSourceCommand,
      id: host.commandIdOf(host.stableIdOf('notion-sync-row', args.requestId, item.id)) as CommandId,
      input: input as Json,
    }).catch(translateSyncRowError);
    refs.push({ id: item.id, rev: saved.wrote.find(row => row.id === item.id)?.rev ?? fact!.ref.rev });
  }
  return refs;
}

export type NotionSyncReceiptHost<Tx> = {
  readonly record: (tx: Tx, requestId: string, input: Json, save: () => Promise<string>, authorize: () => Promise<void>) => Promise<string>;
  readonly live: (tx: Tx, id: string, epoch: string, watermark: string) => Promise<unknown>;
  readonly openFollowing: (tx: Tx, id: FactId) => Promise<unknown>;
};

export async function runNotionSyncReceipt<Tx, Receipt extends { readonly sources: readonly { readonly id: FactId; readonly rev: number }[] }>(
  host: NotionSyncReceiptHost<Tx>,
  tx: Tx,
  args: {
    readonly requestId: string;
    readonly selectionId: string;
    readonly epoch: string;
    readonly watermark: string;
    readonly save: () => Promise<Receipt>;
  },
): Promise<Receipt> {
  const encoded = await host.record(tx, args.requestId,
    { action: 'sync', selectionId: args.selectionId, epoch: args.epoch, watermark: args.watermark } as unknown as Json,
    async () => JSON.stringify(await args.save()),
    async () => { await host.live(tx, args.selectionId, args.epoch, args.watermark); });
  const result = JSON.parse(encoded) as Receipt;
  for (const ref of result.sources) await host.openFollowing(tx, ref.id);
  return result;
}

export type NotionSendBasisHost<Tx, Page> = {
  readonly reopen: (tx: Tx, purpose: string, recipient: (fact: FactSnapshot) => boolean, witness: { readonly id: FactId; readonly rev: number; readonly epoch: string }) => Promise<FactSnapshot>;
  readonly checkStudioNotionFact: (tx: Tx, fact: FactSnapshot, purpose: string, recipient: unknown) => Promise<unknown>;
  readonly notionPageAuthority: (tx: Tx, envelope: { readonly sourceSelectionId?: string; readonly externalId?: string }) => Promise<Page>;
  readonly sourceEnvelope: (value: unknown) => { readonly sourceSelectionId?: string; readonly externalId?: string };
  readonly captureSourceType: string;
  readonly isUnconfirmed: (error: unknown) => boolean;
};

export async function collectNotionSendBasis<Tx, Page>(
  host: NotionSendBasisHost<Tx, Page>,
  tx: Tx,
  witnesses: Iterable<{ readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string }>,
  recipient: (fact: FactSnapshot) => boolean,
  check?: CheckNotionRead,
): Promise<Page[]> {
  const pages: Page[] = [];
  let unconfirmed: unknown;
  for (const witness of witnesses) {
    if (witness.type !== host.captureSourceType) continue;
    const fact = await host.reopen(tx, 'teaching', recipient, {
      id: witness.id as FactId,
      rev: witness.rev,
      epoch: witness.epoch,
    });
    if (!await host.checkStudioNotionFact(tx, fact, 'teaching', recipient)) continue;
    if (!check) pages.push(await host.notionPageAuthority(tx, host.sourceEnvelope(fact.value)));
    else try {
      await check(fact);
    } catch (error) {
      if (!host.isUnconfirmed(error)) throw error;
      unconfirmed = error;
    }
  }
  if (unconfirmed) throw unconfirmed;
  return pages;
}

export async function checkStudioNotionFactBody<Tx>(
  host: {
    readonly captureSourceType: string;
    readonly sourceEnvelope: (value: unknown) => { readonly kind?: string };
    readonly readStudioNotionSource: (tx: Tx, sourceId: FactId, options: { readonly mode: 'pinned'; readonly rev: Revision }, access: {
      readonly purpose: string;
      readonly recipientId: string;
      readonly maySend: (fact: FactSnapshot) => boolean;
    }) => Promise<FactSnapshot | undefined>;
    readonly accessDenied: () => Error;
  },
  tx: Tx,
  fact: FactSnapshot,
  purpose: string,
  recipient: ((fact: FactSnapshot) => boolean) & { notionRecipientId?: string } | 'learner',
  reopen?: (fact: FactSnapshot) => Promise<FactSnapshot>,
): Promise<FactSnapshot | undefined> {
  if (fact.type !== host.captureSourceType || host.sourceEnvelope(fact.value).kind !== 'notion') return;
  if (reopen) return reopen(fact);
  try {
    return await host.readStudioNotionSource(tx, fact.ref.id, { mode: 'pinned', rev: fact.ref.rev },
      recipient === 'learner'
        ? { purpose, recipientId: (tx as { learner: LearnerId }).learner, maySend: () => true }
        : { purpose, recipientId: recipient.notionRecipientId ?? '', maySend: recipient });
  } catch {
    throw host.accessDenied();
  }
}

export type TeachingAuthorityHost<Tx, Turn extends { readonly providerId?: string; readonly baseUrl: string; readonly protocol?: string; readonly model: string; readonly workspaceRevision?: string; readonly learningToolsVersion?: number }, Manifest, Recipient> = {
  readonly parseManifest: (raw: unknown) => Manifest;
  readonly teachingPurpose: string;
  readonly teachingTurnAllowed: (tx: Tx, turn: Turn, grantCurrent: (turn: Turn) => Promise<boolean>, origin?: Turn) => Promise<boolean>;
  readonly notionModelRecipient: (id: string, endpoint: string, protocol: string, model: string, revision: string) => string;
  readonly teachingMemoryBasis: (tx: Tx, manifest: Manifest, turnId: string, recipient: Recipient) => Promise<{ readonly objects: readonly { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string }[] } | null | undefined>;
  readonly questionReceiptsCurrent: (tx: Tx, turnId: string, use: 'publish' | 'history') => Promise<boolean>;
  readonly savedNotionWitnesses: (tx: Tx, inputs: never) => Promise<readonly { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string }[]>;
  readonly notionSendBasis: (tx: Tx, witnesses: readonly { readonly id: string; readonly rev: number; readonly epoch: string; readonly type: string }[], recipient: Recipient, check: CheckNotionRead) => Promise<unknown>;
  readonly isUnconfirmed: (error: unknown) => boolean;
};

export async function teachingResultAuthorityBody<Tx, Turn extends { readonly providerId?: string; readonly baseUrl: string; readonly protocol?: string; readonly model: string; readonly workspaceRevision?: string; readonly learningToolsVersion?: number }, Manifest extends { readonly purpose: string; readonly inputs: readonly unknown[] }, Recipient extends { notionRecipientId?: string }>(
  host: TeachingAuthorityHost<Tx, Turn, Manifest, Recipient>,
  tx: Tx,
  turnId: string,
  turn: Turn,
  rawManifest: unknown,
  grantCurrent: (turn: Turn) => Promise<boolean>,
  check: CheckNotionRead,
  origin: Turn | undefined,
  use: 'publish' | 'history',
  makeRecipient: () => Recipient,
): Promise<
  | { readonly state: 'withdrawn' }
  | { readonly state: 'unconfirmed' }
  | { readonly state: 'authorized'; readonly memoryBasis: unknown }
> {
  try {
    const manifest = host.parseManifest(rawManifest);
    if (manifest.purpose !== host.teachingPurpose || !await host.teachingTurnAllowed(tx, turn, grantCurrent, origin))
      return { state: 'withdrawn' } as const;
    const recipient = makeRecipient();
    if (turn.providerId && turn.protocol && turn.workspaceRevision)
      recipient.notionRecipientId = host.notionModelRecipient(turn.providerId, turn.baseUrl, turn.protocol, turn.model, turn.workspaceRevision);
    const memoryBasis = await host.teachingMemoryBasis(tx, manifest, turnId, recipient);
    if (!memoryBasis || (turn.learningToolsVersion === 1 && !await host.questionReceiptsCurrent(tx, turnId, use)))
      return { state: 'withdrawn' } as const;
    await host.notionSendBasis(tx, [...await host.savedNotionWitnesses(tx, manifest.inputs as never), ...memoryBasis.objects], recipient, check);
    return { state: 'authorized', memoryBasis } as const;
  } catch (error) {
    return host.isUnconfirmed(error) ? { state: 'unconfirmed' } as const : { state: 'withdrawn' } as const;
  }
}

export type NotionBlockWorkHost<Tx, Work> = {
  readonly readReadyWork: (tx: Tx, ref: unknown) => Promise<Work | null | undefined>;
  readonly openCurrentNotionBlock: (access: unknown, parsed: unknown, check: CheckNotionRead) => Promise<unknown>;
  readonly blockAccess: (tx: Tx) => unknown;
  readonly cancelWork: (bound: unknown, ref: unknown) => Promise<void>;
  readonly withinLearnerTransaction: (tx: Tx) => unknown;
  readonly exhaustBlock: (bound: unknown, ref: unknown, remote: boolean) => Promise<void>;
  readonly gatherSnapshot: (bound: unknown, scope: unknown, gather: (ctx: unknown) => Promise<unknown>) => Promise<unknown>;
  readonly sealCandidate: (bound: unknown, ref: unknown, policy: unknown, snapshot: unknown) => Promise<{ readonly kind: string; readonly id?: string }>;
  readonly submitCandidate: (bound: unknown, ref: unknown, policy: unknown, id: string, failure: { readonly kind: 'failed'; readonly reason: string }, hooks: unknown) => Promise<void>;
  readonly gatherNotionBlock: (ctx: unknown, slotKey: string) => Promise<unknown>;
  readonly blockPolicy: { readonly slot: { readonly type: string }; readonly deriver: string; readonly purpose: string };
  readonly blockHooks: unknown;
  readonly isBlockWithdrawn: (error: unknown) => boolean;
  readonly isUnconfirmed: (error: unknown) => boolean;
  readonly isTemporaryFailure: (error: unknown) => boolean;
};

export async function prepareNotionBlockWork<Tx, Work extends { readonly slotType: string; readonly deriver: string; readonly slotKey: string }>(
  host: NotionBlockWorkHost<Tx, Work>,
  tx: Tx,
  ref: unknown,
  check: CheckNotionRead,
  terminal: boolean,
  cause: unknown,
): Promise<Work | undefined> {
  const work = await host.readReadyWork(tx, ref);
  if (!work || work.slotType !== notionBlockSlot || work.deriver !== notionBlockDeriver) return;
  try {
    await host.openCurrentNotionBlock(host.blockAccess(tx), parseNotionBlockWorkKey(work.slotKey), check);
    return work;
  } catch (error) {
    const bound = host.withinLearnerTransaction(tx);
    if (host.isBlockWithdrawn(error)) await host.cancelWork(bound, ref);
    else if (terminal && host.isUnconfirmed(error))
      await host.exhaustBlock(bound, ref, cause === 'remote-unavailable' && host.isTemporaryFailure(error));
    else throw error;
    return;
  }
}

export async function publishNotionBlockWork<Tx, Work extends { readonly slotKey: string }>(
  host: NotionBlockWorkHost<Tx, Work>,
  tx: Tx,
  work: Work | undefined,
  ref: unknown,
  terminal: boolean,
  cause: unknown,
): Promise<void> {
  if (!work) return;
  const bound = host.withinLearnerTransaction(tx);
  if (terminal) {
    await host.exhaustBlock(bound, ref, cause === 'remote-unavailable');
    return;
  }
  const snapshot = await host.gatherSnapshot(bound, { learner: (tx as { learner: LearnerId }).learner, purpose: host.blockPolicy.purpose },
    ctx => host.gatherNotionBlock(ctx, work.slotKey));
  const sealed = await host.sealCandidate(bound, ref, host.blockPolicy, snapshot);
  if (sealed.kind === 'sealed') await host.submitCandidate(bound, ref, host.blockPolicy, sealed.id!,
    { kind: 'failed', reason: '尚无获准的 Notion 概念解析器及连边核验回执。' }, host.blockHooks);
}

export type NotionLiveHost<Tx> = {
  readonly assertDeletionWatermark: (tx: Tx, watermark: string) => Promise<void>;
  readonly selectionAt: (tx: Tx, id: string) => Promise<NotionSelection | null | undefined>;
  readonly checkDenial: (tx: Tx, id: string, epoch: string, page?: string) => Promise<void>;
};

export async function notionLiveSelection<Tx>(
  host: NotionLiveHost<Tx>,
  tx: Tx,
  id: string,
  epoch: string,
  watermark: string,
  page?: string,
): Promise<NotionSelection> {
  await host.assertDeletionWatermark(tx, watermark);
  const selection = liveSelectionOrStale(await host.selectionAt(tx, id), epoch);
  await host.checkDenial(tx, id, epoch, page);
  return selection;
}

export type NotionProviderHost<Tx, Stream, Result> = {
  readonly connectionRead: (stream: Stream, authorize: () => Promise<unknown>, signal?: AbortSignal) => Promise<Result>;
  readonly snapshot: <T>(read: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly locked: <T>(action: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly recordLocalRead: (bound: unknown, witness: { readonly learner: unknown; readonly ownerKind: string; readonly ownerId: string; readonly stepKey: string; readonly label: string; readonly input: Record<string, unknown> }, run: () => Promise<string>, verify: () => Promise<void>) => Promise<unknown>;
  readonly withinLearnerTransaction: (tx: Tx) => unknown;
  readonly isLifecycle: (error: unknown) => boolean;
};

export async function runNotionProvider<Tx, Stream, Result>(
  host: NotionProviderHost<Tx, Stream, Result>,
  liveHost: NotionLiveHost<Tx>,
  args: {
    readonly selection: NotionSelection;
    readonly watermark: string;
    readonly stream: Stream;
    readonly page?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly rememberDenial?: boolean | undefined;
    readonly preserveTemporary?: boolean | undefined;
  },
): Promise<Result> {
  const { id, selectionEpoch: epoch } = args.selection;
  const rememberDenial = args.rememberDenial ?? true;
  const preserveTemporary = args.preserveTemporary ?? false;
  try {
    return await host.connectionRead(args.stream, () =>
      host.snapshot(tx => notionLiveSelection(liveHost, tx, id, epoch, args.watermark, args.page)), args.signal);
  } catch (error) {
    args.signal?.throwIfAborted();
    const failure = classifyNotionProviderError(error, rememberDenial, preserveTemporary, host.isLifecycle);
    if (failure.kind === 'denied' && error instanceof NotionSourceUnavailable && error.invalidated) {
      const key = error.invalidated.kind === 'selection' ? 'root' : error.invalidated.pageId;
      await host.locked(async tx => {
        await notionLiveSelection(liveHost, tx, id, epoch, args.watermark);
        await host.recordLocalRead(host.withinLearnerTransaction(tx), {
          learner: (tx as { learner: LearnerId }).learner,
          ownerKind: 'session',
          ownerId: notionDenialOwner(id, epoch),
          stepKey: key as string,
          label: 'notion-access-denial',
          input: {},
        }, async () => 'denied', async () => {});
      });
      throw new RequestError(403, 'Notion 已撤回该来源的访问。');
    }
    throw (failure as { error?: unknown }).error;
  }
}

export type SelectedNotionAccessHost<Tx, SelectionRead, SourceRead> = {
  readonly selectionRead: (tx: Tx) => SelectionRead;
  readonly sourceRead: (tx: Tx, purpose: string, maySend: (fact: FactSnapshot) => boolean) => SourceRead;
  readonly checkDenial: (tx: Tx, id: string, epoch: string, page: string | undefined, since: string | undefined) => Promise<void>;
};

export function selectedNotionAccess<Tx, SelectionRead, SourceRead>(
  host: SelectedNotionAccessHost<Tx, SelectionRead, SourceRead>,
  tx: Tx,
  access: { readonly purpose: string; readonly recipientId: string; readonly maySend: (fact: FactSnapshot) => boolean },
  requireCurrentSelection: boolean,
): {
  learner: LearnerId;
  purpose: string;
  recipientId: string;
  selectionRead: SelectionRead;
  sourceRead: SourceRead;
  checkSelection: (selection: NotionSelection, source: { readonly externalId?: string; readonly sourceSelectionEpoch?: string }) => Promise<void>;
} {
  return {
    learner: (tx as { learner: LearnerId }).learner,
    purpose: access.purpose,
    recipientId: access.recipientId,
    selectionRead: host.selectionRead(tx),
    sourceRead: host.sourceRead(tx, access.purpose, access.maySend),
    async checkSelection(selection: NotionSelection, source: { readonly externalId?: string; readonly sourceSelectionEpoch?: string }) {
      if (requireCurrentSelection && selection.selectionEpoch !== source.sourceSelectionEpoch) throw new NotionSelectionUnavailable();
      await host.checkDenial(tx, selection.id, selection.selectionEpoch, source.externalId, source.sourceSelectionEpoch);
    },
  };
}

export async function confirmNotionDispatchBody<P extends { readonly selection: NotionSelection; readonly pageId: string; readonly watermark: string }>(
  pages: readonly P[],
  pageKey: (page: P) => string,
  provider: (selection: NotionSelection, watermark: string, stream: unknown, page: string) => Promise<unknown>,
  confirmPageAccess: (root: NotionSelection['root'], pageId: string) => unknown,
): Promise<void> {
  for (const { selection, pageId, watermark } of uniqueNotionPages(pages, pageKey)) {
    await provider(selection, watermark, confirmPageAccess(selection.root, pageId), pageId);
  }
}

export async function runNotionSyncFinalize<Tx>(
  host: {
    readonly reconcileRoutedWork: (tx: Tx, recovery: unknown, plan: unknown) => Promise<void>;
    readonly blockRecovery: unknown;
    readonly planNotionBlockRecovery: (access: unknown, confirmed: ReadonlySet<FactId>, withdrawn: (error: unknown) => boolean) => unknown;
    readonly isBlockWithdrawn: (error: unknown) => boolean;
    readonly blockAccess: (tx: Tx) => unknown;
  },
  tx: Tx,
  refs: readonly { readonly id: FactId; readonly rev: number }[],
): Promise<void> {
  const confirmed = new Set(refs.map(ref => ref.id));
  await host.reconcileRoutedWork(tx, host.blockRecovery,
    host.planNotionBlockRecovery(host.blockAccess(tx), confirmed, host.isBlockWithdrawn));
}

export type NotionSyncSnapshotHost<Tx> = {
  readonly live: (tx: Tx, id: string, epoch: string, watermark: string) => Promise<NotionSelection>;
  readonly readDenied: (tx: Tx, ownerId: string) => Promise<readonly { readonly step_key: string }[]>;
  readonly sources: (tx: Tx, selection: NotionSelection) => Promise<readonly { readonly id: FactId; readonly rev: number }[]>;
  readonly readRoutedWorkForRecovery: (tx: Tx, recovery: unknown) => Promise<unknown>;
  readonly notionBlockRecoveryPages: (before: readonly unknown[], work: unknown) => readonly unknown[];
  readonly blockRecovery: unknown;
};

export async function runNotionSyncSnapshot<Tx>(
  host: NotionSyncSnapshotHost<Tx>,
  tx: Tx,
  args: { readonly selectionId: string; readonly epoch: string; readonly watermark: string },
): Promise<{
  readonly selection: NotionSelection;
  readonly before: readonly { readonly id: FactId; readonly rev: number }[];
  readonly deniedPages: ReadonlySet<string>;
  readonly recoveryPages: readonly unknown[];
}> {
  const selection = await host.live(tx, args.selectionId, args.epoch, args.watermark);
  notionSyncCheck(selection);
  const denied = await host.readDenied(tx, notionDenialOwner(args.selectionId, args.epoch));
  const before = await host.sources(tx, selection);
  return {
    selection,
    before,
    deniedPages: notionDeniedPages(denied),
    recoveryPages: selection.root.kind === 'data-source'
      ? host.notionBlockRecoveryPages(before, await host.readRoutedWorkForRecovery(tx, host.blockRecovery))
      : [],
  };
}

export async function notionOpenFollowing<Tx>(
  readStudioNotionSource: (tx: Tx, id: FactId, options: { readonly mode: 'following' }, access: unknown) => Promise<unknown>,
  tx: Tx,
  id: FactId,
  access: unknown,
): Promise<unknown> {
  try {
    return await readStudioNotionSource(tx, id, { mode: 'following' }, access);
  } catch {
    throw new RequestError(403, '这份 Notion 来源未获当前接收人授权。');
  }
}

export function notionLockedReadOnly<Tx>(
  readOnly: boolean,
  snapshot: <T>(project: (tx: Tx) => Promise<T>, options: { readonly lockLearner: boolean }) => Promise<T>,
): ((project: (tx: Tx) => Promise<unknown>) => Promise<unknown>) | undefined {
  return readOnly
    ? async project => {
        try {
          return await snapshot(project, { lockLearner: true });
        } catch (error) {
          if (error instanceof Error && 'code' in error && (error as { readonly code?: string }).code === '40001')
            throw new RequestError(503, '课堂依据正在更新，请重试。');
          throw error;
        }
      }
    : undefined;
}

export async function notionRecord<Tx>(
  recordLocalRead: (database: unknown, witness: { readonly learner: LearnerId; readonly ownerKind: string; readonly ownerId: string; readonly stepKey: string; readonly label: string; readonly input: Json }, run: () => Promise<string>, verify: () => Promise<void>) => Promise<string>,
  withinLearnerTransaction: (database: unknown, tx: Tx) => unknown,
  database: unknown,
  args: { readonly tx: Tx; readonly requestId: string; readonly input: Json; readonly save: () => Promise<string>; readonly authorize: () => Promise<void> },
): Promise<string> {
  try {
    return await recordLocalRead(withinLearnerTransaction(database, args.tx), {
      learner: (args.tx as { learner: LearnerId }).learner,
      ownerKind: 'session',
      ownerId: stableId('notion-request', args.requestId),
      stepKey: 'result',
      label: 'notion-request',
      input: args.input,
    }, args.save, args.authorize);
  } catch (error) {
    return translateWorkspaceReceiptError(error);
  }
}

export async function notionPageAuthorityFor<Tx>(
  selectionAt: (tx: Tx, id: string) => Promise<NotionSelection | null | undefined>,
  deletionWatermark: (tx: Tx) => Promise<string>,
  tx: Tx,
  source: { readonly sourceSelectionId?: string; readonly externalId?: string },
): Promise<{ readonly selection: NotionSelection; readonly pageId: string; readonly watermark: string }> {
  return {
    selection: (await selectionAt(tx, source.sourceSelectionId!))!,
    pageId: source.externalId!,
    watermark: await deletionWatermark(tx),
  };
}

export function notionSourcesFor<Tx>(
  notionSources: (deps: { readonly captureSourceType: string; readonly notionPageObservationType: string }, tx: Tx, selection: NotionSelection, allGenerations?: boolean) => Promise<unknown>,
  captureSourceType: string,
  notionPageObservationType: string,
  tx: Tx,
  selection: NotionSelection,
  allGenerations = false,
): Promise<unknown> {
  return notionSources({ captureSourceType, notionPageObservationType }, tx, selection, allGenerations);
}

export async function checkNotionDenialFor<Tx>(
  checkNotionDenial: (deps: { readonly RequestError: typeof RequestError; readonly stableId: (...parts: string[]) => string; readonly denialOwner: (id: string, epoch: string) => string }, tx: Tx, id: string, epoch: string, page?: string, since?: string) => Promise<unknown>,
  tx: Tx,
  id: string,
  epoch: string,
  page?: string,
): Promise<void> {
  await checkNotionDenial({ RequestError, stableId, denialOwner: notionDenialOwner }, tx, id, epoch, page, epoch);
}
