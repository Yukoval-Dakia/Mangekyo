import { type CommandId, type FactId, type Json, type LearnerId, type Revision } from '@mangekyo/kernel';
import { RequestError } from './request.ts';
import type { IntakeOriginal } from './intake-values.ts';
import { paperReturnView, paperRun } from './paper.ts';
import type { PaperIssuance } from './paper.ts';
import { sourceEnvelope } from './source.ts';

export const paperConflictMessage = '卷面、题目发放状态或回收依据已变化。';

export const previewLayout = { lines: 60, columns: 80 } as const;

export type PaperPrintKind = 'workbook' | 'posttest' | 'question' | 'textbook';

export function buildPrintKinds(deps: {
  readonly workbookPaperType: string;
  readonly posttestIssuanceType: string;
  readonly assetType: string;
  readonly textbookPageType: string;
}): ReadonlyMap<string, PaperPrintKind> {
  return new Map<string, PaperPrintKind>([
    [deps.workbookPaperType, 'workbook'],
    [deps.posttestIssuanceType, 'posttest'],
    [deps.assetType, 'question'],
    [deps.textbookPageType, 'textbook'],
  ]);
}

export function parsePaperInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new RequestError(400, '纸面请求格式无效。');
  }
}

export type PaperErrorDeps = {
  readonly WorkbookPresentationError: new (...args: never[]) => Error;
  readonly AssetBasisError: new (...args: never[]) => Error;
  readonly isLifecycle: (error: unknown) => boolean;
  readonly isDenied: (error: unknown) => boolean;
  readonly isNotFound: (error: unknown) => boolean;
};

export function translatePaperRequestError(deps: PaperErrorDeps, error: unknown): never {
  if (deps.isLifecycle(error)) throw error;
  if (deps.isDenied(error) || deps.isNotFound(error))
    throw new RequestError(404, '找不到当前可读取的纸面依据。');
  if (error instanceof deps.AssetBasisError || error instanceof deps.WorkbookPresentationError ||
      (error instanceof Error && error.constructor === Error)) throw new RequestError(409, paperConflictMessage);
  throw error;
}

export function paperUnavailable(error: unknown): boolean {
  return error instanceof RequestError && [404, 409, 422].includes(error.status);
}

export function learnerMismatch(): RequestError {
  return new RequestError(409, paperConflictMessage);
}

export function checkIssuanceStored(stored: { readonly type: string; readonly ref: { readonly rev: number } }, paperIssuanceType: string): void {
  if (stored.type !== paperIssuanceType || stored.ref.rev !== 1) throw new RequestError(404, '找不到已发行纸卷。');
}

export function checkPosttestReleased(releasedRev: number, expectedRev: number): void {
  if (releasedRev !== expectedRev) throw new RequestError(409, paperConflictMessage);
}

export function retentionNotReady(): RequestError {
  return new RequestError(404, '后测卷尚无可用的发放题项。');
}

export function checkPaperWrites(length: number): void {
  if (length) throw new RequestError(409, paperConflictMessage);
}

export function checkRunMatches(
  run: { readonly type: string; readonly value: unknown },
  paperRunType: string,
  issuanceId: unknown,
): void {
  if (run.type !== paperRunType || paperRun(run.value).issuanceId !== issuanceId) throw new RequestError(409, paperConflictMessage);
}

export function checkAssignmentMatch(
  row: { readonly assignment: unknown } | undefined,
  assignment: unknown,
  canonicalJsonString: (value: unknown) => string,
): void {
  if (row?.assignment && canonicalJsonString(row.assignment) !== canonicalJsonString(assignment))
    throw new RequestError(409, '回收页归属与本人上传时的选择不符。');
}

export function checkPriorUpload(prior: { readonly type: string } | null | undefined, captureSourceCommand: string): void {
  if (prior && prior.type !== captureSourceCommand) throw new RequestError(409, '同一个请求标识已用于普通交入。');
}

export function paperReturnEnvelope(recordedAt: string | null, original: IntakeOriginal, id: FactId, title: string) {
  return {
    kind: 'paper-return' as const,
    retentionPolicy: 'retained' as const,
    occurredAt: null,
    recordedAt,
    originals: [{ ...original, blobRef: id }],
    unit: { kind: 'capture' as const, title, blocks: [] },
  };
}

export function paperReturnPurposes(selectedPurpose: string, storagePurpose: string): string[] {
  return selectedPurpose === storagePurpose ? [storagePurpose] : [storagePurpose, selectedPurpose];
}

export function uploadReceiptOf(
  receipt: unknown,
  id: FactId,
  rev: Revision,
  title: string,
  source: { readonly id: FactId; readonly rev: Revision },
  prior: unknown,
) {
  return {
    ...(receipt as Record<string, unknown>),
    intent: 'paper-return' as const,
    id,
    revision: rev,
    title,
    source,
    original: 0,
    created: !prior,
  };
}

export function checkPageReturned(
  target: { readonly source: { readonly id: FactId; readonly rev: Revision } } | undefined,
  id: FactId,
  rev: Revision,
): void {
  if (target?.source.id !== id || target.source.rev !== rev)
    throw new RequestError(409, '这页已回收。请使用原请求或另起一次作答。');
}

export function translateUploadInstallError(): never {
  throw new RequestError(500, '拍回原件未能保存。');
}

export function checkReceiptDone(state: string): void {
  if (state !== 'done') throw new RequestError(409, paperConflictMessage);
}

export function invalidReturnIndices(): RequestError {
  return new RequestError(400, '回收页码或原图索引无效。');
}

export function checkPermitForNonWorkbook(sourceType: string, workbookPaperType: string, permit: unknown): void {
  if (sourceType !== workbookPaperType && permit) throw new RequestError(409, paperConflictMessage);
}

export function capturedKindOf(
  envelope: { readonly kind?: string } | undefined,
  factType: string,
  printKinds: ReadonlyMap<string, PaperPrintKind>,
): PaperPrintKind | 'photo' | 'pdf' | undefined {
  if (envelope?.kind === 'photo' || envelope?.kind === 'pdf') return envelope.kind;
  return printKinds.get(factType);
}

export function paperPrintDefinition(fact: { readonly ref: { readonly id: FactId; readonly rev: Revision }; readonly accessEpoch: string }) {
  return { source: { id: fact.ref.id, rev: fact.ref.rev }, epoch: fact.accessEpoch, layout: previewLayout };
}

import { bindPaperCommandRead, type PaperExtractionReader } from './paper.ts';
import { layeredExtractionDeriver, layeredExtractionSlot, type LayeredExtractionValue } from './extraction.ts';
import { questionVerificationKey, questionVerificationType, type QuestionVerification } from '@mangekyo/module-content/facts/question-state';
import type { DerivationSnapshot, ReadContext, SlotRef } from '@mangekyo/kernel';
import type { ReadTransaction } from '@mangekyo/kernel';

type EffectiveSlotVersionRow<Value> = {
  readonly manifest: {
    readonly learner: LearnerId;
    readonly inputs: readonly unknown[];
  };
  readonly deriver: string;
  readonly snapshot: DerivationSnapshot<Value>;
};

export type StudioPaperBindDeps = {
  readonly readEffectiveSlotVersion: <Value>(
    tx: ReadTransaction,
    slot: SlotRef,
    deriver: string,
    use: string,
    pinnedId?: string,
  ) => Promise<EffectiveSlotVersionRow<Value> | undefined>;
};

export function bindStudioPaperRead(
  tx: ReadTransaction,
  base: ReadContext,
  use: string,
  deps: StudioPaperBindDeps,
) {
  const readExtraction: PaperExtractionReader = async ({ learner, source, extraction }, mode) => {
    if (learner !== tx.learner) throw learnerMismatch();
    const row = await deps.readEffectiveSlotVersion<LayeredExtractionValue>(tx, { learner, type: layeredExtractionSlot, key: source.id },
      layeredExtractionDeriver, use, mode === 'pinned' ? extraction.derivationId : undefined);
    if (!row || row.snapshot.id !== extraction.derivationId) throw learnerMismatch();
    return row;
  };
  const readQuestionSlot: ReadContext['slot'] = async <Value = Json>(
    slot: SlotRef, options: Parameters<ReadContext['slot']>[1],
  ) => {
    if (slot.learner !== tx.learner || slot.type !== questionVerificationType || options.mode !== 'following')
      throw learnerMismatch();
    const result = await deps.readEffectiveSlotVersion<QuestionVerification>(tx, slot, 'content/question-verification', use);
    if (!result) throw learnerMismatch();
    const { manifest, snapshot } = result;
    const outcome = snapshot.outcome as { readonly value?: { readonly basis?: { readonly id: string; readonly rev: number; readonly accessEpoch: string } } };
    const basis = outcome.value?.basis;
    if (!basis || questionVerificationKey(basis as Parameters<typeof questionVerificationKey>[0]) !== slot.key || !manifest.inputs.some((input: unknown) => {
      const entry = input as { readonly kind?: string; readonly mode?: string; readonly id?: string; readonly rev?: number; readonly accessEpoch?: string };
      return entry.kind === 'fact' && entry.mode === 'following' && entry.id === basis.id &&
        entry.rev === basis.rev && entry.accessEpoch === basis.accessEpoch;
    })) throw learnerMismatch();
    return snapshot as DerivationSnapshot<Value>;
  };
  return bindPaperCommandRead(base, { readExtraction, readQuestionSlot });
}

export function isPaperReturnEnvelope(envelope: { readonly kind?: string } | undefined): boolean {
  return envelope?.kind === 'paper-return';
}

export function skipPrintCandidate(envelope: { readonly workbookAttachment?: unknown } | undefined): boolean {
  return Boolean(envelope?.workbookAttachment);
}

export function paperReturnCommandInput(
  id: FactId,
  assignment: Record<string, unknown>,
  envelope: Record<string, unknown>,
  purposes: readonly string[],
): Record<string, unknown> {
  return { id, paperReturn: assignment, envelope, purpose: purposes };
}

export function presentationIdFor(
  commandIdOf: (value: string) => CommandId,
  stableIdOf: (...parts: string[]) => string,
  command: string,
  canonical: string,
): CommandId {
  return commandIdOf(stableIdOf(command, canonical));
}

export type StudioPaperListItem =
  | { readonly kind: 'issued'; readonly issuanceId: FactId; readonly title: string; readonly pageCount: number }
  | { readonly kind: 'return'; readonly entry: ReturnType<typeof paperReturnView> }
  | { readonly kind: 'source'; readonly candidate: unknown }
  | { readonly kind: 'skip' };

export type StudioPaperListDeps = {
  readonly paperIssuanceType: string;
  readonly captureSourceType: string;
  readonly printKinds: ReadonlyMap<string, PaperPrintKind>;
};

export function paperListEntryKind(
  factType: string,
  deps: StudioPaperListDeps,
): 'issuance' | 'source' {
  return factType === deps.paperIssuanceType ? 'issuance' : 'source';
}

export function capturedEnvelopeOf(
  fact: { readonly type: string; readonly value: unknown },
  captureSourceType: string,
): { readonly kind?: string; readonly workbookAttachment?: unknown } | undefined {
  return fact.type === captureSourceType ? (sourceEnvelope(fact.value) as { kind?: string; workbookAttachment?: unknown }) : undefined;
}

export function classifyCapturedEntry(
  captured: { readonly kind?: string; readonly workbookAttachment?: unknown } | undefined,
  factType: string,
  deps: StudioPaperListDeps,
): { readonly action: 'return' | 'candidate' | 'skip'; readonly printKind?: PaperPrintKind | 'photo' | 'pdf' } {
  if (isPaperReturnEnvelope(captured)) return { action: 'return' };
  if (skipPrintCandidate(captured)) return { action: 'skip' };
  const printKind = capturedKindOf(captured, factType, deps.printKinds);
  return printKind ? { action: 'candidate', printKind } : { action: 'skip' };
}

export type StudioPapersWriteHost<ReadCtx, Command, Tx> = {
  readonly transact: <T>(run: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly learnerRead: (tx: Tx) => ReadCtx;
  readonly command: (tx: Tx) => Command;
  readonly paperRequest: <T>(work: () => Promise<T>) => Promise<T>;
};

export async function runPaperWrite<ReadCtx, Command, Tx, T>(
  host: StudioPapersWriteHost<ReadCtx, Command, Tx>,
  run: (read: ReadCtx, command: Command, tx: Tx) => Promise<T>,
): Promise<T> {
  return host.paperRequest(() => host.transact(async tx => {
    const read = host.learnerRead(tx);
    return run(read, host.command(tx), tx);
  }));
}

export type PaperCollectHost<ReadCtx, Data extends { readonly retryId?: FactId; readonly issuanceId: FactId }> = {
  readonly collectPaperWrites: (read: ReadCtx, data: Data) => Promise<readonly unknown[]>;
  readonly defaultPaperRunId: (issuanceId: FactId) => Promise<FactId>;
  readonly paperRunType: string;
  readonly paperCollectionReceipt: (data: Data, runId: FactId, rev: number) => unknown;
};

export async function runPaperCollect<ReadCtx, Data extends { readonly retryId?: FactId; readonly issuanceId: FactId }>(
  host: PaperCollectHost<ReadCtx, Data>,
  read: ReadCtx,
  command: (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>,
  data: Data,
): Promise<{ readonly run: { readonly value: unknown }; readonly receipt: unknown }> {
  const runId = data.retryId ?? await host.defaultPaperRunId(data.issuanceId);
  await command('capture.collectPaper', data as Json);
  checkPaperWrites((await host.collectPaperWrites(read, data)).length);
  const run = await (read as { fact: (id: FactId, options: { mode: string }) => Promise<{ type: string; value: unknown; ref: { rev: number } }> }).fact(runId, { mode: 'following' });
  checkRunMatches(run, host.paperRunType, data.issuanceId);
  return { run, receipt: host.paperCollectionReceipt(data, runId, run.ref.rev) };
}

export type PaperPresentHost<ReadCtx, Source, Printed extends Record<string, unknown>, Data extends { readonly paper: unknown; readonly items: unknown }> = {
  readonly openIssuedPaper: (read: ReadCtx, id: FactId) => Promise<Printed>;
  readonly printedWorkbookPresentation: (source: Source, printed: Printed, permit?: FactId) => Data;
  readonly workbookPaperType: string;
  readonly recordWorkbookPresentationCommand: string;
  readonly commandIdOf: (value: string) => CommandId;
  readonly stableIdOf: (...parts: string[]) => string;
  readonly canonicalJsonString: (value: unknown) => string;
};

export async function runPaperPresent<ReadCtx, Source, Printed extends Record<string, unknown>, Data extends { readonly paper: unknown; readonly items: unknown }>(
  host: PaperPresentHost<ReadCtx, Source, Printed, Data>,
  read: ReadCtx,
  command: (type: string, data: Json, id?: CommandId) => Promise<void>,
  args: { readonly id: FactId; readonly issue: { readonly source: Source }; readonly source: { readonly type: string } },
  permit?: FactId,
): Promise<Record<string, unknown>> {
  const printed = await host.openIssuedPaper(read, args.id);
  checkPermitForNonWorkbook(args.source.type, host.workbookPaperType, permit);
  if (args.source.type !== host.workbookPaperType) return { ...printed, presentation: null };
  const data = host.printedWorkbookPresentation(args.issue.source, printed, permit);
  const presentationId = presentationIdFor(host.commandIdOf, host.stableIdOf, host.recordWorkbookPresentationCommand, host.canonicalJsonString(data));
  await command(host.recordWorkbookPresentationCommand, { id: presentationId, data } as unknown as Json, presentationId);
  return { ...printed, presentation: { paper: data.paper, items: data.items, permit: presentationId } };
}

export type PaperUploadHost<ReadCtx, Tx> = {
  readonly assertUnburned: (tx: Tx, kind: 'fact' | 'command', ids: readonly string[]) => Promise<void>;
  readonly assertDeletionWatermark: (tx: Tx, watermark: string) => Promise<void>;
  readonly readRecordedCommand: (tx: Tx, id: CommandId) => Promise<{ readonly type: string } | null | undefined>;
  readonly readFact: (read: ReadCtx, id: FactId, options: { readonly mode: 'pinned'; readonly rev: Revision }) => Promise<{ readonly value: unknown }>;
  readonly sourceEnvelopeOf: (value: unknown) => { readonly recordedAt: string | null };
  readonly readIssuance: (tx: Tx, read: ReadCtx, id: FactId) => Promise<unknown>;
  readonly collect: (read: ReadCtx, command: (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>, data: never) => Promise<{ readonly run: { readonly value: unknown }; readonly receipt: unknown }>;
  readonly paperRunPages: (value: unknown) => readonly { readonly number: number; readonly source: { readonly id: FactId; readonly rev: Revision } }[];
  readonly captureSourceCommand: string;
};

export async function runPaperUpload<ReadCtx, Tx>(
  host: PaperUploadHost<ReadCtx, Tx>,
  tx: Tx,
  read: ReadCtx,
  command: (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>,
  args: {
    readonly selection: { readonly source: { readonly id: FactId; readonly rev: Revision }; readonly purpose: string } & Record<string, unknown>;
    readonly upload: { readonly command: CommandId; readonly deletionWatermark: string; readonly title: string; readonly original: IntakeOriginal; readonly install: () => Promise<void> };
    readonly storagePurpose: string;
  },
): Promise<Record<string, unknown>> {
  const { source, purpose: selectedPurpose, ...assignment } = args.selection;
  const { id, rev } = source;
  await host.assertUnburned(tx, 'fact', [id as string]);
  await host.assertUnburned(tx, 'command', [args.upload.command as string]);
  await host.assertDeletionWatermark(tx, args.upload.deletionWatermark);
  const prior = await host.readRecordedCommand(tx, args.upload.command);
  checkPriorUpload(prior, host.captureSourceCommand);
  const recordedAt = prior
    ? host.sourceEnvelopeOf((await host.readFact(read, id, { mode: 'pinned', rev })).value).recordedAt
    : new Date().toISOString();
  await command(host.captureSourceCommand,
    paperReturnCommandInput(id, assignment,
      paperReturnEnvelope(recordedAt, args.upload.original, id, args.upload.title) as Record<string, unknown>,
      paperReturnPurposes(selectedPurpose, args.storagePurpose)) as Json,
    args.upload.command, args.upload.deletionWatermark);
  await host.readIssuance(tx, read, assignment.issuanceId as FactId);
  const { run, receipt } = await host.collect(read, command, { ...assignment, source } as never);
  const target = host.paperRunPages(run.value).find(page => page.number === assignment.page);
  checkPageReturned(target, id, rev);
  if (!prior) {
    try {
      await args.upload.install();
    } catch {
      return translateUploadInstallError();
    }
  }
  return uploadReceiptOf(receipt, id, rev, args.upload.title, source, prior);
}

export async function paperCommandDone<Tx extends { readonly learner: LearnerId }>(
  handle: (request: { readonly learner: LearnerId; readonly actor: 'learner' | 'companion'; readonly purpose: string; readonly type: string; readonly id: CommandId; readonly input: Json; readonly deletionWatermark?: string }) => Promise<{ readonly state: string }>,
  tx: Tx,
  type: string,
  data: Json,
  id: CommandId,
  deletionWatermark: string | undefined,
): Promise<void> {
  const receipt = await handle({
    learner: tx.learner,
    actor: 'learner',
    purpose: 'storage',
    type,
    id,
    input: data,
    ...(deletionWatermark === undefined ? {} : { deletionWatermark }),
  });
  checkReceiptDone(receipt.state);
}

export type PaperIssueHost<ReadCtx, Tx> = {
  readonly admitSource: (tx: Tx, read: ReadCtx, issue: unknown) => Promise<unknown>;
  readonly resolvePaperIssue: (read: ReadCtx, issue: never) => Promise<{ readonly printed: { readonly issuanceId: FactId }; readonly existing: boolean }>;
  readonly readIssuance: (tx: Tx, read: ReadCtx, id: FactId) => Promise<unknown>;
  readonly present: (read: ReadCtx, command: (type: string, data: Json, id?: CommandId) => Promise<void>, issuance: never, permit?: FactId) => Promise<Record<string, unknown>>;
  readonly commandIdOf: (value: string) => CommandId;
  readonly stableIdOf: (...parts: string[]) => string;
  readonly learner: LearnerId;
  readonly purpose: string;
};

export async function runPaperIssue<ReadCtx, Tx>(
  host: PaperIssueHost<ReadCtx, Tx>,
  tx: Tx,
  read: ReadCtx,
  command: (type: string, data: Json, id?: CommandId) => Promise<void>,
  issue: { readonly source: { readonly id: FactId; readonly rev: Revision } },
): Promise<Record<string, unknown>> {
  await host.admitSource(tx, read, issue);
  const { printed: { issuanceId: id }, existing } = await host.resolvePaperIssue(read, issue as never);
  if (!existing) await command('capture.issuePaper', issue as Json, host.commandIdOf(host.stableIdOf('capture.issuePaper', id)));
  return host.present(read, command, await host.readIssuance(tx, read, id) as never);
}

export async function runPaperCollectBody<ReadCtx, Tx>(
  host: {
    readonly assertUnburned: (tx: Tx, kind: 'fact' | 'command', ids: readonly string[]) => Promise<void>;
    readonly readIssuance: (tx: Tx, read: ReadCtx, id: FactId) => Promise<unknown>;
    readonly readAssignment: (tx: Tx, sourceId: FactId) => Promise<{ readonly assignment: unknown } | undefined>;
    readonly collect: (read: ReadCtx, command: (type: string, data: Json, id?: CommandId) => Promise<void>, data: never) => Promise<{ readonly receipt: unknown }>;
    readonly canonicalJsonString: (value: unknown) => string;
  },
  tx: Tx,
  read: ReadCtx,
  command: (type: string, data: Json, id?: CommandId) => Promise<void>,
  data: { readonly issuanceId: FactId; readonly source: { readonly id: FactId } } & Record<string, unknown>,
): Promise<unknown> {
  await host.assertUnburned(tx, 'fact', [data.source.id as string]);
  await host.readIssuance(tx, read, data.issuanceId);
  const row = await host.readAssignment(tx, data.source.id);
  const { source: _, ...assignment } = data;
  checkAssignmentMatch(row, assignment, host.canonicalJsonString);
  return (await host.collect(read, command, data as never)).receipt;
}

export function paperReprintId(
  readPaperReprintInput: (body: Record<string, unknown>) => FactId,
  body: Record<string, unknown>,
): FactId {
  return parsePaperInput(() => readPaperReprintInput(body));
}

export function paperDisplayInput(
  readPaperDisplayInput: (body: Record<string, unknown>) => readonly [FactId, FactId | undefined],
  body: Record<string, unknown>,
): readonly [FactId, FactId | undefined] {
  return parsePaperInput(() => readPaperDisplayInput(body));
}

export type PaperListRowHost<ReadCtx, Tx> = {
  readonly ifAvailable: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  readonly readFact: (read: ReadCtx, id: FactId) => Promise<FactSnapshotForList>;
  readonly readIssuance: (tx: Tx, read: ReadCtx, id: FactId, fact: FactSnapshotForList) => Promise<unknown>;
  readonly openIssuedPaper: (read: ReadCtx, id: FactId) => Promise<{ readonly issuanceId: FactId; readonly title: string; readonly pages: readonly unknown[] }>;
  readonly sourceEnvelopeOf: (value: unknown) => { readonly kind?: string; readonly workbookAttachment?: unknown };
  readonly printCandidate: (tx: Tx, read: ReadCtx, fact: FactSnapshotForList, kind: PaperPrintKind | 'photo' | 'pdf') => Promise<unknown>;
  readonly paperIssuanceType: string;
  readonly captureSourceType: string;
  readonly printKinds: ReadonlyMap<string, PaperPrintKind>;
};

export type FactSnapshotForList = {
  readonly type: string;
  readonly value: unknown;
  readonly ref: { readonly id: FactId; readonly rev: Revision };
};

export type PaperListRowOutcome =
  | { readonly issued: { readonly issuanceId: FactId; readonly title: string; readonly pageCount: number } }
  | { readonly returned: ReturnType<typeof paperReturnView> }
  | { readonly sourced: unknown }
  | null;

export async function paperListRow<ReadCtx, Tx>(
  host: PaperListRowHost<ReadCtx, Tx>,
  tx: Tx,
  read: ReadCtx,
  id: FactId,
): Promise<PaperListRowOutcome> {
  const fact = await host.ifAvailable(() => host.readFact(read, id));
  if (!fact) return null;
  if (fact.type === host.paperIssuanceType) {
    const paper = await host.ifAvailable(async () => {
      await host.readIssuance(tx, read, id, fact);
      return host.openIssuedPaper(read, id);
    });
    return paper ? { issued: { issuanceId: paper.issuanceId, title: paper.title, pageCount: paper.pages.length } } : null;
  }
  const captured = fact.type === host.captureSourceType
    ? await host.ifAvailable(async () => host.sourceEnvelopeOf(fact.value))
    : undefined;
  const plan = classifyCapturedEntry(captured, fact.type, host);
  if (plan.action === 'return') {
    return { returned: paperReturnView(id, fact.ref.rev, captured as Parameters<typeof paperReturnView>[2]) };
  }
  if (plan.action === 'candidate' && plan.printKind) {
    const candidate = await host.ifAvailable(() => host.printCandidate(tx, read, fact, plan.printKind!));
    return candidate === undefined ? null : { sourced: candidate };
  }
  return null;
}

export type PaperAdmitHost<ReadCtx, Tx> = {
  readonly retentionPaperType: string;
  readonly posttestIssuanceType: string;
  readonly readPosttestIssuance: (tx: Tx, read: ReadCtx, id: FactId) => Promise<{ readonly issuance: unknown; readonly fact: { readonly ref: { readonly rev: number } } }>;
  readonly issuedPosttestPaper: (read: ReadCtx, issuance: unknown) => Promise<void>;
  readonly retentionTeachingPurpose: string;
  readonly readContext: (tx: Tx, purpose: string) => ReadCtx;
};

export async function admitPaperSource<ReadCtx, Tx>(
  host: PaperAdmitHost<ReadCtx, Tx>,
  tx: Tx,
  read: ReadCtx,
  issuance: { readonly source: { readonly id: FactId; readonly rev: Revision } },
): Promise<{ readonly type: string }> {
  const fact = await (read as { fact: (id: FactId, options: { mode: string; rev: Revision }) => Promise<{ type: string }> })
    .fact(issuance.source.id, { mode: 'pinned', rev: issuance.source.rev });
  if (fact.type === host.retentionPaperType) throw retentionNotReady();
  if (fact.type === host.posttestIssuanceType) {
    const { issuance: inner, fact: released } = await host.readPosttestIssuance(tx, read, issuance.source.id);
    checkPosttestReleased(released.ref.rev, issuance.source.rev);
    await host.issuedPosttestPaper(host.readContext(tx, host.retentionTeachingPurpose), inner);
  }
  return fact;
}

export type PaperPrintHost<ReadCtx, Tx> = {
  readonly readEffectiveSlotVersion: (tx: Tx, slot: { readonly learner: LearnerId; readonly type: string; readonly key: string }, deriver: string, use: string) => Promise<{
    readonly snapshot: {
      readonly id: string;
      readonly outcome: { readonly value?: { readonly basis?: { readonly target: { readonly rev: Revision }; readonly modelMethod: string } } };
    };
  } | undefined>;
  readonly layeredExtractionSlot: string;
  readonly layeredExtractionDeriver: string;
  readonly projectNewPaper: (read: ReadCtx, def: unknown) => Promise<{ readonly title: string }>;
  readonly admitSource: (tx: Tx, read: ReadCtx, def: { readonly source: { readonly id: FactId; readonly rev: Revision } }) => Promise<unknown>;
  readonly ifAvailable: <T>(work: () => Promise<T>) => Promise<T | undefined>;
  readonly purpose: string;
};

export async function paperPrintCandidate<ReadCtx, Tx>(
  host: PaperPrintHost<ReadCtx, Tx>,
  tx: Tx,
  read: ReadCtx,
  fact: { readonly ref: { readonly id: FactId; readonly rev: Revision }; readonly accessEpoch: string },
  kind: PaperPrintKind | 'photo' | 'pdf',
): Promise<Record<string, unknown>> {
  const { id, rev } = fact.ref;
  const definition = { source: { id, rev }, epoch: fact.accessEpoch, layout: previewLayout };
  await host.admitSource(tx, read, definition);
  const project = async ({ layout, ...ref }: Record<string, unknown> & { readonly layout: unknown }) => {
    const { title } = await host.projectNewPaper(read, { layout, ...ref });
    return { kind, title, ...ref };
  };
  if (kind === 'photo' || kind === 'pdf') {
    const layered = await host.ifAvailable(async () => {
      const version = await host.readEffectiveSlotVersion(tx,
        { learner: (tx as { learner: LearnerId }).learner, type: host.layeredExtractionSlot, key: id }, host.layeredExtractionDeriver, host.purpose);
      if (!version) throw learnerMismatch();
      const { snapshot } = version;
      const { basis } = snapshot.outcome.value!;
      const extraction = { derivationId: snapshot.id, sourceRev: basis!.target.rev, modelMethod: basis!.modelMethod };
      return project({ ...definition, extraction });
    });
    if (layered) return layered;
  }
  return project(definition);
}


export async function readPaperIssuance<Tx, ReadCtx>(
  tx: Tx,
  read: ReadCtx,
  id: FactId,
  fact: FactSnapshotForList | undefined,
  deps: {
    readonly readFact: (read: ReadCtx, id: FactId) => Promise<FactSnapshotForList>;
    readonly checkedPaperIssuance: (fact: FactSnapshotForList, id: FactId) => Promise<{ readonly source: { readonly id: FactId; readonly rev: Revision } }>;
    readonly admitSource: (tx: Tx, read: ReadCtx, issuance: { readonly source: { readonly id: FactId; readonly rev: Revision } }) => Promise<unknown>;
    readonly paperIssuanceType: string;
  },
): Promise<{ readonly id: FactId; readonly issue: { readonly source: { readonly id: FactId; readonly rev: Revision } }; readonly source: unknown }> {
  const stored = fact ?? await deps.readFact(read, id);
  checkIssuanceStored(stored, deps.paperIssuanceType);
  const issue = await deps.checkedPaperIssuance(stored, id);
  return { id, issue, source: await deps.admitSource(tx, read, issue) };
}
