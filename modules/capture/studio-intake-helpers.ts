import { type CommandId, type FactId, type Json, type LearnerId } from '@mangekyo/kernel';
import { RequestError, submittedWatermark } from './request.ts';
import type { IntakeExtraction, IntakeOriginal } from './intake-values.ts';
import type { IntakeMetadata } from './intake-view.ts';
import type { DetectedDocument, IntakeHttpAdapter } from './intake-operations.ts';

export const intakeCardRoutePattern = /^\/api\/materials\/([0-9A-HJKMNP-TV-Z]{26})\/(question-cards|confirm-drafts)$/;

export type IntakeCardRoute =
  | { readonly materialId: string; readonly action: 'question-cards' | 'confirm-drafts' }
  | null;

export function parseIntakeCardRoute(pathname: string): IntakeCardRoute {
  const match = intakeCardRoutePattern.exec(pathname);
  if (!match?.[1]) return null;
  return { materialId: match[1], action: match[2] as 'question-cards' | 'confirm-drafts' };
}

export function cardRouteMethod(action: 'question-cards' | 'confirm-drafts'): 'GET' | 'POST' {
  return action === 'question-cards' ? 'GET' : 'POST';
}

export function cardRouteStatus(action: 'question-cards' | 'confirm-drafts'): number {
  return action === 'question-cards' ? 200 : 201;
}

export function cardRouteErrorStatus(error: unknown, RequestErrorCtor: new (status: number, message: string) => Error): number {
  return error instanceof RequestErrorCtor ? (error as unknown as { status: number }).status
    : error instanceof SyntaxError ? 400 : 500;
}

export function cardRouteErrorMessage(
  error: unknown,
  RequestErrorCtor: new (status: number, message: string) => Error,
  action: 'question-cards' | 'confirm-drafts',
): string {
  return error instanceof RequestErrorCtor || error instanceof SyntaxError
    ? (error as Error).message
    : action === 'question-cards' ? '这份材料的核对卡无法读取。' : '拍卷确认未能完成。';
}

export function methodNotAllowed() {
  return { error: '这个入口只接受指定操作。' } as const;
}

export function intakeExtractionInput(
  inputExtraction: unknown,
  pageCount: number,
): unknown {
  return inputExtraction === undefined && pageCount === 1 ? 'vision_llm' : inputExtraction;
}

export function requireVisionOnlyExtraction(requested: string): void {
  if (requested === 'mineru') throw new RequestError(400, '多页合并拍卷仅支持视觉模型识别。');
  throw new RequestError(415, '多页合并拍卷仅支持视觉模型识别。');
}

export function requireMultiPageVision(requested: string, asyncVision: boolean): void {
  if (requested === 'mineru') throw new RequestError(400, '多页合并拍卷仅支持视觉模型识别。');
  if (!asyncVision) throw new RequestError(415, '多页合并拍卷仅支持视觉模型识别。');
}

export function requireMineruConfigured(mineruEnabled: boolean): void {
  if (!mineruEnabled) throw new RequestError(503, 'MinerU 云识别尚未配置。');
}

export function intakeReplayConflict(): RequestError {
  return new RequestError(409, '同一个请求标识已经用于不同文件或标题。');
}

export function intakeRacedConflict(): RequestError {
  return new RequestError(409, '同一个请求标识已经用于不同内容。');
}

export function captureSourceConflict(): RequestError {
  return new RequestError(409, '同一个请求标识已用于纸卷拍回。');
}

export function isCommandIdentityConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'Command ID already used with a different command identity';
}

export function intakeCommandInput(input: {
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly title: string;
  readonly original: IntakeOriginal;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: 'mineru' | 'vision_llm' | undefined;
}) {
  const { materialId, intakeId, title, original, extraction, requestedExtraction } = input;
  return {
    materialId,
    intakeId,
    title,
    original,
    extraction,
    savedAt: new Date().toISOString(),
    ...(requestedExtraction ? { requestedExtraction } : {}),
  };
}

export function multiPageIntakeCommandInput(input: {
  readonly materialId: FactId;
  readonly intakeId: FactId;
  readonly title: string;
  readonly original: IntakeOriginal;
  readonly originals: readonly IntakeOriginal[];
  readonly extraction: IntakeExtraction;
}) {
  return {
    materialId: input.materialId,
    intakeId: input.intakeId,
    title: input.title,
    original: input.original,
    originals: input.originals,
    extraction: input.extraction,
    savedAt: new Date().toISOString(),
    requestedExtraction: 'vision_llm',
  };
}

export type IntakeConfirmDraftsInput = {
  readonly mode: 'workbook' | 'bank';
  readonly requestId: string;
  readonly confirmedByLearner?: unknown;
  readonly expectedMaterialRev?: unknown;
  readonly items?: unknown;
  readonly purpose?: unknown;
  readonly linkConcepts?: unknown;
};

export function parseIntakeConfirmDraftsInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new RequestError(400, '拍卷确认请求格式无效。');
  return input as Record<string, unknown>;
}

export function requireBankConfirmation(value: Record<string, unknown>): void {
  if (value.mode !== 'bank') throw new RequestError(400, '拍卷确认方式无效。');
  if (value.confirmedByLearner !== true) throw new RequestError(400, '加入题库需要学习者显式确认。');
}

export function requireWorkbookAvailable(workbook: unknown): asserts workbook {
  if (!workbook) throw new RequestError(500, '练习模块未启用。');
}

export function workbookDraftResult(draft: { readonly title: string; readonly materialId: unknown; readonly questions: readonly unknown[] }, saved: { readonly id: string }) {
  return {
    kind: 'workbook' as const,
    paperId: saved.id,
    href: '/papers/' + saved.id,
    title: draft.title,
    questionCount: draft.questions.length,
  };
}

export function translateWorkbookDraftError(error: unknown): never {
  throw new RequestError(400, error instanceof Error ? error.message : '微卷选题格式无效。');
}

export function translateConfirmQuestionsParseError(error: unknown): never {
  throw new RequestError(400, error instanceof Error ? error.message : '拍卷题目确认无效。');
}

export function translateConfirmQuestionsWriteError(deps: { readonly isNotFound: (error: unknown) => boolean; readonly isDenied: (error: unknown) => boolean }, error: unknown): never {
  if (deps.isNotFound(error) || deps.isDenied(error))
    throw new RequestError(404, '找不到这份拍卷材料。');
  if (error instanceof Error && (error.message.startsWith('材料版本已变化') || error.message.startsWith('Fact revision conflict') ||
      error.message === 'Command ID already used with a different command identity'))
    throw new RequestError(409, '拍卷题目或材料版本已变化，请重新核对。');
  if (error instanceof Error && ['这份材料未授权教学用途。', '已有题目未授权教学用途。', '已有概念节点未授权教学用途。',
      '规范概念类型不符。', '概念标识已被其他记录占用。', '知识边标识已被其他记录占用。', '题目标识已被其他记录占用。'].includes(error.message))
    throw new RequestError(409, error.message);
  throw error;
}

export function confirmQuestionsParseArgs(value: Record<string, unknown>, materialId: string): Record<string, unknown> {
  return {
    confirmedByLearner: true,
    materialId,
    expectedMaterialRev: value.expectedMaterialRev,
    items: value.items,
    ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
    ...(value.linkConcepts === undefined ? {} : { linkConcepts: value.linkConcepts }),
  };
}

export type IntakeWriteTargetSpec = Record<string, { readonly create?: readonly string[]; readonly correct?: readonly string[] }>;

export function buildIntakeWriteTargets(deps: {
  readonly captureIntakeCommand: string;
  readonly correctIntakeCommand: string;
  readonly completeCloudIntakeCommand: string;
  readonly completeVisionIntakeCommand: string;
  readonly retryVisionIntakeCommand: string;
  readonly appendIntakePagesCommand: string;
  readonly confirmIntakeQuestionsCommand: string;
  readonly materialType: string;
  readonly questionAssetType: string;
  readonly questionStateType: string;
  readonly questionMetaDraftType: string;
}): IntakeWriteTargetSpec {
  return {
    [deps.captureIntakeCommand]: { create: [deps.materialType] },
    [deps.correctIntakeCommand]: { correct: [deps.materialType] },
    [deps.completeCloudIntakeCommand]: { correct: [deps.materialType] },
    [deps.completeVisionIntakeCommand]: { correct: [deps.materialType] },
    [deps.retryVisionIntakeCommand]: { correct: [deps.materialType] },
    [deps.appendIntakePagesCommand]: { correct: [deps.materialType] },
    [deps.confirmIntakeQuestionsCommand]: { create: [deps.questionAssetType, deps.questionStateType, deps.questionMetaDraftType] },
  };
}

export function expectedRevMismatch(): RequestError {
  return new RequestError(409, '原文版本已经变更，请刷新后再续拍加页。');
}

export function originalPageMissing(): RequestError {
  return new RequestError(404, '找不到该页原件。');
}

export type IntakeQuestionCardsView = {
  readonly materialId: FactId;
  readonly materialRev: number;
  readonly intakeRev: number;
  readonly title: string;
  readonly questionCards: unknown;
};

export function intakeQuestionCardsView(
  facts: { readonly id: FactId; readonly material: { readonly ref: { readonly rev: number } }; readonly document: { readonly ref: { readonly rev: number }; readonly value: unknown } },
  title: string,
  questionCards: unknown,
): IntakeQuestionCardsView {
  return {
    materialId: facts.id,
    materialRev: facts.material.ref.rev,
    intakeRev: facts.document.ref.rev,
    title,
    questionCards,
  };
}

export type IntakeSaveHooks = {
  readonly onFactsChanged: (tx: unknown, tick: unknown, changes: unknown) => Promise<void>;
};

export type IntakeSaveDeps = {
  readonly db: unknown;
  readonly runtime: unknown;
  readonly createCommandHandler: (db: unknown, options: unknown) => (command: unknown) => Promise<unknown>;
};

export function buildIntakeSaver(
  deps: IntakeSaveDeps,
  hooks: IntakeSaveHooks,
  afterFactsChanged: (tx: unknown, tick: unknown, changes: unknown) => Promise<void>,
): (command: unknown) => Promise<unknown> {
  return deps.createCommandHandler(deps.db, {
    ...(deps.runtime as Record<string, unknown>),
    hooks: {
      async onFactsChanged(tx: unknown, tick: unknown, changes: unknown) {
        await afterFactsChanged(tx, tick, changes);
        await hooks.onFactsChanged(tx, tick, changes);
      },
    },
  });
}

export type StagedIntakeSaveSpec = {
  readonly kind: 'capture' | 'pages' | 'append';
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: 'mineru' | 'vision_llm' | undefined;
};

export function stagedExtractionFor(
  cloud: boolean,
  asyncVision: boolean,
  localExtract: () => Promise<IntakeExtraction>,
  pendingMineru: () => IntakeExtraction,
  pendingVision: (state: 'queued') => IntakeExtraction,
): Promise<IntakeExtraction> {
  if (cloud) return Promise.resolve(pendingMineru());
  if (asyncVision) return Promise.resolve(pendingVision('queued'));
  return localExtract();
}

export function captureRequestedExtraction(cloud: boolean, asyncVision: boolean): 'mineru' | 'vision_llm' | undefined {
  return cloud ? 'mineru' : asyncVision ? 'vision_llm' : undefined;
}

export type IntakeStagedSaveHost<Database, Tx, Tick, Changes> = {
  readonly createCommandHandler: (database: Database, options: Record<string, unknown>) => (command: unknown) => Promise<unknown>;
  readonly database: Database;
  readonly runtime: Record<string, unknown>;
  readonly hooks: { readonly onFactsChanged: (tx: Tx, tick: Tick, changes: Changes) => Promise<void> };
  readonly learner: unknown;
  readonly purpose: string;
  readonly type: string;
  readonly commandIdValue: unknown;
  readonly deletionWatermark?: string;
};

export async function runIntakeStagedSave<Database, Tx, Tick, Changes>(
  host: IntakeStagedSaveHost<Database, Tx, Tick, Changes>,
  commandInput: Record<string, unknown>,
  afterInstall: (tx: Tx, tick: Tick) => Promise<void>,
  install: () => Promise<void>,
  markInstalled: () => void,
): Promise<void> {
  const save = host.createCommandHandler(host.database, {
    ...host.runtime,
    hooks: {
      async onFactsChanged(tx: Tx, tick: Tick, changes: Changes) {
        await install();
        markInstalled();
        await afterInstall(tx, tick);
        await host.hooks.onFactsChanged(tx, tick, changes);
      },
    },
  });
  await save({
    learner: host.learner,
    actor: 'learner',
    purpose: host.purpose,
    type: host.type,
    id: host.commandIdValue,
    ...(host.deletionWatermark === undefined ? {} : { deletionWatermark: host.deletionWatermark }),
    input: commandInput,
  });
}

export type IntakeBankConfirmHost<Tx> = {
  readonly parseConfirmIntakeQuestions: (args: Record<string, unknown>) => { readonly materialId: FactId; readonly items: readonly { readonly draftId: string }[] } & Record<string, unknown>;
  readonly intakeQuestionId: (materialId: FactId, draftId: string) => Promise<unknown>;
  readonly handle: (command: IntakeBankCommandRequest) => Promise<{ readonly wrote: readonly unknown[] }>;
  readonly snapshot: <T>(read: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly isNotFound: (error: unknown) => boolean;
  readonly isDenied: (error: unknown) => boolean;
  readonly summarize: (tx: Tx, data: Record<string, unknown>, wrote: readonly unknown[]) => Promise<Record<string, unknown>>;
  readonly commandIdOf: (value: string) => CommandId;
  readonly stableIdOf: (...parts: string[]) => string;
};

export type IntakeBankCommandRequest = {
  readonly deletionWatermark?: string;
  readonly learner: LearnerId;
  readonly id: CommandId;
  readonly type: string;
  readonly input: Json;
  readonly actor: 'learner' | 'companion';
  readonly purpose: string;
};

export async function runBankConfirmation<Tx>(
  host: IntakeBankConfirmHost<Tx>,
  args: {
    readonly materialId: string;
    readonly requestId: string;
    readonly learner: LearnerId;
    readonly purpose: string;
    readonly confirmIntakeQuestionsCommand: string;
    readonly value: Record<string, unknown>;
  },
): Promise<{ readonly kind: 'bank' } & Record<string, unknown>> {
  const requestId = args.requestId;
  let data;
  try {
    data = host.parseConfirmIntakeQuestions(confirmQuestionsParseArgs(args.value, args.materialId));
  } catch (error) {
    return translateConfirmQuestionsParseError(error);
  }
  await Promise.all(data.items.map(item => host.intakeQuestionId(data.materialId, item.draftId)));
  let receipt;
  try {
    receipt = await host.handle({
      learner: args.learner,
      actor: 'learner',
      purpose: args.purpose,
      type: args.confirmIntakeQuestionsCommand,
      id: host.commandIdOf(host.stableIdOf('intake-question-confirmation', requestId)),
      input: data as Json,
    });
  } catch (error) {
    return translateConfirmQuestionsWriteError(host, error);
  }
  const summary = await host.snapshot(tx => host.summarize(tx, data, receipt.wrote));
  return { kind: 'bank' as const, ...summary };
}

export async function runHandledIntakeCommand(
  args: {
    readonly handle: (command: IntakeBankCommandRequest) => Promise<unknown>;
    readonly learner: LearnerId;
    readonly purpose: string;
    readonly type: string;
    readonly commandIdValue: CommandId;
    readonly input: Json;
    readonly translate: (error: unknown) => never;
  },
): Promise<void> {
  try {
    await args.handle({
      learner: args.learner,
      actor: 'learner',
      purpose: args.purpose,
      type: args.type,
      id: args.commandIdValue,
      input: args.input,
    });
  } catch (error) {
    return args.translate(error);
  }
}

export function intakeMetadataView(
  facts: { readonly id: FactId; readonly material: { readonly value: unknown }; readonly document: { readonly value: unknown; readonly ref: { readonly rev: number }; readonly purpose: readonly string[] } },
  project: (id: FactId, material: unknown, document: unknown, rev: number, purpose: readonly string[]) => IntakeMetadata,
  questionCards: (document: unknown) => unknown,
): IntakeMetadata & { readonly questionCards: unknown } {
  return {
    ...project(facts.id, facts.material.value, facts.document.value, facts.document.ref.rev, facts.document.purpose),
    questionCards: questionCards(facts.document.value),
  };
}

export function cloudIntakeHooksSpec<Tx, Tick, Changes>(args: {
  readonly work: unknown;
  readonly cloudIntakeSlot: string;
  readonly ref: unknown;
  readonly documentRef: { readonly id: string; readonly rev: number };
  readonly materialRef: { readonly id: string; readonly rev: number };
  readonly isExpected: (work: unknown, slot: string, doc: { id: string; rev: number }, mat: { id: string; rev: number }, changes: Changes) => boolean;
  readonly stale: () => Error;
}) {
  return {
    expected(changes: Changes): boolean {
      return args.isExpected(args.work, args.cloudIntakeSlot, args.documentRef, args.materialRef, changes);
    },
    staleError(): Error {
      return args.stale();
    },
  };
}

export function completeCloudIntakeInput(
  documentRef: { readonly id: string; readonly rev: number },
  materialRef: { readonly id: string; readonly rev: number },
  extraction: IntakeExtraction,
): Record<string, unknown> {
  return {
    intakeId: documentRef.id,
    expectedRev: documentRef.rev,
    expectedMaterialRev: materialRef.rev,
    extraction,
  };
}

export function workChanged(): RequestError {
  return new RequestError(409, '交入工作已更改。');
}

export function intakePrepareAdapters<Detected extends DetectedDocument | null, Bytes>(args: {
  readonly stableId: (...parts: string[]) => string;
  readonly factId: (value: string) => FactId;
  readonly submittedWatermark: (input: { readonly deletionWatermark?: unknown }) => string;
  readonly identify: (bytes: Bytes, extension: string, declaredType: unknown) => Detected;
  readonly digest: (bytes: Bytes) => string;
  readonly isBuffer: (value: unknown) => boolean;
}) {
  return {
    isBuffer: args.isBuffer,
    materialIdFor: (requestId: string) => args.factId(args.stableId('intake-material', requestId)),
    parseWatermark: args.submittedWatermark,
    identify: args.identify,
    sha256: args.digest,
  };
}

export function checkIntakeReplay<T>(prior: T | null | undefined, matches: (prior: T) => boolean): { readonly replayed: boolean; readonly prior?: T } {
  if (!prior) return { replayed: false };
  if (!matches(prior)) throw intakeReplayConflict();
  return { replayed: true, prior };
}

export async function metadataOrNullFor<T>(
  metadataFor: (materialId: string, watermark: string) => Promise<T>,
  materialId: string,
  watermark: string,
): Promise<T | null> {
  try {
    return await metadataFor(materialId, watermark);
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) return null;
    throw error;
  }
}

export type IntakeFactsHost<Tx> = {
  readonly snapshot: <T>(read: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly checkCapture: (tx: Tx, id: FactId, watermark: string) => Promise<void>;
  readonly readContext: (tx: Tx) => { readonly fact: (id: FactId, options: { readonly mode: string }) => Promise<{ readonly type: string; readonly value: unknown; readonly ref: { readonly rev: number }; readonly purpose: readonly string[]; readonly accessEpoch: string }> };
  readonly intakeIdFor: (id: FactId) => FactId;
  readonly factId: (value: string) => FactId;
  readonly captureSourceType: string;
};

export type IntakeFacts = {
  readonly id: FactId;
  readonly intakeId: FactId;
  readonly material: { readonly type: string; readonly value: unknown; readonly ref: { readonly rev: number }; readonly purpose: readonly string[]; readonly accessEpoch: string };
  readonly document: { readonly type: string; readonly value: unknown; readonly ref: { readonly rev: number }; readonly purpose: readonly string[]; readonly accessEpoch: string };
};

export async function intakeFactsFor<Tx>(
  host: IntakeFactsHost<Tx>,
  materialId: string,
  watermark?: string,
): Promise<IntakeFacts> {
  const id = host.factId(materialId);
  const intakeId = host.intakeIdFor(id);
  return host.snapshot(async tx => {
    if (watermark !== undefined) await host.checkCapture(tx, id, watermark);
    const read = host.readContext(tx);
    const material = await read.fact(id, { mode: 'following' });
    if (watermark !== undefined && material.type === host.captureSourceType) throw captureSourceConflict();
    const document = await read.fact(intakeId, { mode: 'following' });
    return { id, material, document, intakeId };
  });
}

export async function intakeOriginalFor<Tx, Bytes>(
  host: {
    readonly factId: (value: string) => FactId;
    readonly snapshot: <T>(read: (tx: Tx) => Promise<T>) => Promise<T>;
    readonly readContext: (tx: Tx) => { readonly fact: (id: FactId, options: { readonly mode: string }) => Promise<{ readonly type: string; readonly value: unknown }> };
    readonly extractPaperReturnOriginal: (fact: { readonly type: string; readonly value: unknown }, id: FactId) => IntakeOriginal | null;
    readonly isIgnorableReadError: (error: unknown) => boolean;
    readonly metadataFor: (id: FactId) => Promise<{ readonly original: IntakeOriginal }>;
    readonly readObject: (id: FactId, original: IntakeOriginal) => Promise<Bytes>;
  },
  materialId: string,
): Promise<{ readonly metadata: { readonly original: IntakeOriginal }; readonly stored: IntakeOriginal; readonly bytes: Bytes }> {
  const id = host.factId(materialId);
  const original = await host.snapshot(async tx => {
    const read = host.readContext(tx);
    try {
      return host.extractPaperReturnOriginal(await read.fact(id, { mode: 'following' }), id);
    } catch (error) {
      if (!host.isIgnorableReadError(error)) throw error;
    }
    return null;
  });
  const metadata = original ? { original } : await host.metadataFor(id);
  const bytes = await host.readObject(id, metadata.original);
  return { metadata, stored: metadata.original, bytes };
}

export type IntakeCardRouteHost = {
  readonly json: (status: number, data: unknown) => void;
  readonly readBody: (limit: number) => Promise<{ readonly toString: (encoding?: string) => string }>;
  readonly questionCards: (materialId: string) => Promise<unknown>;
  readonly confirmDrafts: (materialId: string, input: unknown) => Promise<unknown>;
  readonly RequestError: new (status: number, message: string) => Error;
};

export async function runIntakeCardRoute(
  host: IntakeCardRouteHost,
  route: { readonly materialId: string; readonly action: 'question-cards' | 'confirm-drafts' },
  method: string | undefined,
): Promise<true> {
  const expected = cardRouteMethod(route.action);
  if (method !== expected) return host.json(405, methodNotAllowed()), true;
  try {
    const result = route.action === 'question-cards'
      ? await host.questionCards(route.materialId)
      : await host.confirmDrafts(route.materialId, JSON.parse((await host.readBody(1_048_576)).toString('utf8')));
    if (result) return host.json(cardRouteStatus(route.action), result), true;
  } catch (error) {
    return host.json(cardRouteErrorStatus(error, host.RequestError),
      { error: cardRouteErrorMessage(error, host.RequestError, route.action) }), true;
  }
  return host.json(405, methodNotAllowed()), true;
}




export async function intakeOriginalPage(
  facts: { readonly id: FactId; readonly document: { readonly value: unknown } },
  page: number,
  deps: {
    readonly intakeDocumentPages: (document: unknown) => readonly { readonly page: number }[];
    readonly intakeDocument: (value: unknown) => unknown;
    readonly readPage: (id: FactId, page: number, entry: never) => Promise<unknown>;
  },
): Promise<{ readonly original: unknown; readonly bytes: unknown }> {
  const pages = deps.intakeDocumentPages(deps.intakeDocument(facts.document.value));
  const entry = pages.find(item => item.page === page);
  if (!entry) throw originalPageMissing();
  const bytes = await deps.readPage(facts.id, page, entry as never);
  return { original: entry, bytes };
}

export type IntakeAppendHost<Tx, Tick, Data> = {
  readonly factsFor: (materialId: string) => Promise<{ readonly document: { readonly value: unknown; readonly ref: { readonly rev: number } } } | null>;
  readonly intakeDocumentPages: (document: unknown) => readonly { readonly page: number }[];
  readonly intakeDocument: (value: unknown) => unknown;
  readonly appendOriginals: (materialId: FactId, startPage: number, pages: readonly unknown[], staged: (staged: unknown, install: () => Promise<void>) => Promise<void>, options: { readonly whenUncommitted: (undo: () => Promise<void>) => Promise<void> }) => Promise<void>;
  readonly runSave: (afterInstall: (tx: Tx, tick: Tick) => Promise<void>, install: () => Promise<void>, markInstalled: () => void) => Promise<void>;
  readonly enqueue: (tx: Tx, tick: Tick, intakeId: FactId) => Promise<void>;
  readonly translateError: (error: unknown, isDenied: boolean) => never;
  readonly isDenied: (error: unknown) => boolean;
  readonly metadataFor: (materialId: string) => Promise<unknown>;
};

export async function runIntakeAppendPages<Tx, Tick, Data extends { readonly intakeId: FactId }>(
  host: IntakeAppendHost<Tx, Tick, Data>,
  prepared: { readonly materialId: FactId; readonly requestId: string; readonly data: Data; readonly pages: readonly unknown[] },
): Promise<unknown> {
  const { materialId, data, pages } = prepared;
  const intakeId = data.intakeId;
  let installed = false;
  try {
    const current = await host.factsFor(materialId.toString());
    const priorPages = current ? host.intakeDocumentPages(host.intakeDocument(current.document.value)) : [];
    if (current && current.document.ref.rev !== (data as unknown as { readonly expectedRev: number }).expectedRev) throw expectedRevMismatch();
    const startPage = priorPages.length + 1;
    await host.appendOriginals(materialId, startPage, pages,
      async (_staged, install) => {
        await host.runSave((tx, tick) => host.enqueue(tx, tick, intakeId), install, () => { installed = true; });
      },
      {
        whenUncommitted: async (undo) => {
          const currentNow = await host.factsFor(materialId.toString()).catch(() => null);
          const pagesNow = currentNow ? host.intakeDocumentPages(host.intakeDocument(currentNow.document.value)) : [];
          if (!pagesNow.some(p => p.page >= startPage)) await undo();
        },
      });
  } catch (error) {
    return host.translateError(error, host.isDenied(error));
  }
  return { ...(await host.metadataFor(materialId.toString()) as Record<string, unknown>), created: installed };
}

export function intakeDispatchAdapter<Bytes extends Uint8Array>(args: {
  readonly headers: IntakeHttpAdapter<Bytes>['headers'];
  readonly readBody: IntakeHttpAdapter<Bytes>['readBody'];
  readonly fromArrayBuffer: IntakeHttpAdapter<Bytes>['fromArrayBuffer'];
  readonly lifecycleError: (error: unknown, includeCode: boolean) => { readonly status: number; readonly message: string; readonly code?: string | undefined } | null;
  readonly mineruEnabled: IntakeHttpAdapter<Bytes>['mineruEnabled'];
  readonly visionOcrEnabled: IntakeHttpAdapter<Bytes>['visionOcrEnabled'];
  readonly hasPapers: boolean;
  readonly lifecycleState: IntakeHttpAdapter<Bytes>['lifecycleState'];
  readonly erase: IntakeHttpAdapter<Bytes>['erase'];
  readonly metadata: IntakeHttpAdapter<Bytes>['metadata'];
  readonly original: IntakeHttpAdapter<Bytes>['original'];
  readonly originalPage: IntakeHttpAdapter<Bytes>['originalPage'];
  readonly capture: IntakeHttpAdapter<Bytes>['capture'];
  readonly capturePages: IntakeHttpAdapter<Bytes>['capturePages'];
  readonly appendPages: IntakeHttpAdapter<Bytes>['appendPages'];
  readonly paperReturn: IntakeHttpAdapter<Bytes>['paperReturn'];
  readonly correct: IntakeHttpAdapter<Bytes>['correct'];
  readonly setResearch: IntakeHttpAdapter<Bytes>['setResearch'];
  readonly retryVision: IntakeHttpAdapter<Bytes>['retryVision'];
}): IntakeHttpAdapter<Bytes> {
  return {
    headers: args.headers,
    readBody: args.readBody,
    fromArrayBuffer: args.fromArrayBuffer,
    decodeUtf8Bytes: (bytes: Bytes) => bytes.toString(),
    parseWatermark: submittedWatermark,
    readLifecycleError: args.lifecycleError,
    mineruEnabled: args.mineruEnabled,
    ...(args.visionOcrEnabled === undefined ? {} : { visionOcrEnabled: args.visionOcrEnabled }),
    hasPapers: args.hasPapers,
    lifecycleState: args.lifecycleState,
    erase: args.erase,
    metadata: args.metadata,
    original: args.original,
    ...(args.originalPage === undefined ? {} : { originalPage: args.originalPage }),
    capture: args.capture,
    ...(args.capturePages === undefined ? {} : { capturePages: args.capturePages }),
    ...(args.appendPages === undefined ? {} : { appendPages: args.appendPages }),
    paperReturn: args.paperReturn,
    correct: args.correct,
    setResearch: args.setResearch,
    ...(args.retryVision === undefined ? {} : { retryVision: args.retryVision }),
  };
}

export type IntakeOutcome =
  | { readonly kind: 'bytes'; readonly status: number; readonly headers: Record<string, string>; readonly bytes: Uint8Array }
  | { readonly kind: 'json'; readonly status: number; readonly headers?: Record<string, string>; readonly body: unknown }
  | null
  | undefined;

export function writeIntakeOutcome(
  outcome: IntakeOutcome,
  io: {
    readonly writeHead: (status: number, headers: Record<string, string>) => void;
    readonly end: (bytes: Uint8Array) => void;
    readonly setHeader: (name: string, value: string) => void;
    readonly json: (status: number, body: unknown) => void;
  },
): boolean {
  if (!outcome) return false;
  if (outcome.kind === 'bytes') {
    io.writeHead(outcome.status, outcome.headers);
    io.end(outcome.bytes);
    return true;
  }
  if (outcome.headers) {
    for (const [name, value] of Object.entries(outcome.headers)) io.setHeader(name, value);
  }
  io.json(outcome.status, outcome.body);
  return true;
}

export type CloudCompletionHost<Tx, Tick, Changes, Work> = {
  readonly createCommandHandler: (database: unknown, options: Record<string, unknown>) => (command: unknown) => Promise<unknown>;
  readonly database: unknown;
  readonly runtime: Record<string, unknown>;
  readonly hooks: { readonly onFactsChanged: (tx: Tx, tick: Tick, changes: Changes) => Promise<void> };
  readonly readReadyWork: (tx: Tx, ref: unknown) => Promise<Work>;
  readonly isExpectedCloudCompletion: (
    work: Work | null | undefined,
    slotType: string,
    documentRef: { readonly id: string; readonly rev: number },
    materialRef: { readonly id: string; readonly rev: number },
    changes: Changes,
  ) => boolean;
  readonly cloudIntakeSlot: string;
  readonly ref: unknown;
  readonly documentRef: { readonly id: string; readonly rev: number };
  readonly materialRef: { readonly id: string; readonly rev: number };
};

export function cloudCompletionHandler<Tx, Tick, Changes, Work>(host: CloudCompletionHost<Tx, Tick, Changes, Work>) {
  return host.createCommandHandler(host.database, {
    ...host.runtime,
    hooks: {
      ...host.hooks,
      async onFactsChanged(tx: Tx, tick: Tick, changes: Changes) {
        const work = await host.readReadyWork(tx, host.ref);
        if (!host.isExpectedCloudCompletion(work, host.cloudIntakeSlot, host.documentRef, host.materialRef, changes))
          throw workChanged();
        await host.hooks.onFactsChanged(tx, tick, changes);
      },
    },
  });
}

export async function runWorkbookConfirmation<Tx, Facts, Draft extends { readonly title: unknown; readonly materialId: unknown; readonly questions: readonly unknown[] }>(
  host: {
    readonly factsFor: (materialId: string) => Promise<Facts>;
    readonly buildDraft: (document: unknown, selection: unknown) => Draft;
    readonly save: (input: unknown) => Promise<{ readonly id: string }>;
    readonly isDenied: (error: unknown) => boolean;
    readonly isLifecycle: (error: unknown) => boolean;
    readonly translate: (error: unknown, isLifecycle: boolean, isDenied: boolean) => Error;
  },
  args: {
    readonly materialId: string;
    readonly value: Record<string, unknown>;
    readonly documentValue: (facts: Facts) => unknown;
  },
): Promise<{ readonly kind: 'workbook'; readonly paperId: string; readonly href: string; readonly title: unknown; readonly questionCount: unknown }> {
  let facts;
  try {
    facts = await host.factsFor(args.materialId);
  } catch (error) {
    throw host.translate(error, host.isLifecycle(error), host.isDenied(error));
  }
  let draft;
  try {
    draft = host.buildDraft(args.documentValue(facts), args.value) as Draft;
  } catch (error) {
    return translateWorkbookDraftError(error);
  }
  const saved = await host.save({ requestId: args.value.requestId, title: draft.title, materialId: draft.materialId, questions: draft.questions });
  return workbookDraftResult(draft as never, saved);
}

export async function runIntakeRead<T>(
  read: () => Promise<T>,
  deps: { readonly isLifecycle: (error: unknown) => boolean; readonly isDenied: (error: unknown) => boolean; readonly translate: (error: unknown, isLifecycle: boolean, isDenied: boolean) => Error },
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw deps.translate(error, deps.isLifecycle(error), deps.isDenied(error));
  }
}
