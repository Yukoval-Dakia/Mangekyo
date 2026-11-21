import {
  commandId,
  derivationId,
  factId,
  FactNotFoundError,
  isJson,
  type CommandId,
  type FactId,
  type FactSnapshot,
  type Json,
  type JsonObject,
  type ReadContext,
  type Revision,
} from '@mangekyo/kernel';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import { materialType, storagePurpose, textMaterial } from './library-values.ts';
import { practiceCustodyType } from './sealed-practice.ts';
import {
  completedLegacyRubric,
  legacyRubricInput,
  rubricAssessmentIdentity,
  sameWorkbookDraft,
} from './workbook-assessment-values.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import {
  openWorkbookCorrectionTarget,
  readWorkbookCorrections,
  sameWorkbookCorrectionAttempt,
  workbookCorrectionItems,
  workbookCorrectionTarget,
  workbookCorrectionType,
} from './workbook-correction.ts';
import {
  authorizeWorkbookPresentation,
  recordWorkbookPresentationCommand,
  workbookPresentation,
  WorkbookPresentationError,
} from './workbook-presentation.ts';
import {
  checkWorkbookPacingItems,
  gradeWorkbook,
  independentlyAuthoredPaper,
  sameWorkbookJson,
  saveWorkbookPaperCommand,
  submitWorkbookAttemptCommand,
  workbookAssessmentRequest,
  workbookAssessmentResult,
  workbookAttempt,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookBankReference,
  workbookDraft,
  workbookPaper,
  workbookPaperType,
  workbookQuestionsView,
  workbookRequestId,
  WorkbookRevisionMismatch,
  workbookRubricAssessmentType,
  workbookRubricAssessmentVersion,
  WorkbookSourceMismatch,
  type WorkbookAnswer,
  type WorkbookAssessmentRequest,
  type WorkbookAttempt,
  type WorkbookAttemptRequest,
  type WorkbookDetail,
  type WorkbookDraft,
  type WorkbookPaper,
  type WorkbookQuestionView,
  type WorkbookRubricAssessmentView,
  type WorkbookRubricQuestion,
  type WorkbookSourceView,
} from './workbook-values.ts';
import { projectWorkbookDetail, type readWorkbookAttempts } from './workbook-views.ts';

export class UncertainRubricEffect extends Error {}

export type WorkbookFail = (status: number, message: string) => never;

export type WorkbookErrorChecks = {
  readonly fail: WorkbookFail;
  readonly isRequestError: (error: unknown) => boolean;
  readonly isReadDenied: (error: unknown) => boolean;
  readonly isLifecycleError: (error: unknown) => boolean;
};

export function invalidWorkbookInput(
  error: unknown,
  message: string,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError'>,
): never {
  if (checks.isRequestError(error)) throw error;
  checks.fail(400, error instanceof Error ? error.message : message);
}

export function workbookFactIdOf(value: unknown, message: string, fail: WorkbookFail): FactId {
  try {
    if (typeof value !== 'string') throw new Error();
    return factId(value);
  } catch {
    fail(404, message);
  }
}

export function mapWorkbookReadFailure(
  error: unknown,
  missing: string,
  denied: string,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isReadDenied'>,
): never {
  if (error instanceof FactNotFoundError) checks.fail(404, missing);
  if (checks.isReadDenied(error) || error instanceof WorkbookSourceMismatch) checks.fail(403, denied);
  throw error;
}

export async function readWorkbookSourceView(
  read: ReadContext,
  id: string,
  unavailable: (error: unknown) => boolean,
): Promise<WorkbookSourceView> {
  try {
    const fact = await read.fact(factId(id), { mode: 'following' });
    return fact.type === materialType
      ? { id, title: textMaterial(fact.value).title, available: true }
      : { id, title: null, available: false };
  } catch (error) {
    if (unavailable(error)) return { id, title: null, available: false };
    throw error;
  }
}

export async function listWorkbookPaperIds(tx: ActivityEvidenceReadScope): Promise<FactId[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id, created_tick FROM facts
      WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     UNION ALL
     SELECT r.data#>>'{paper,id}' AS id, f.created_tick
       FROM facts f JOIN fact_revs r
         ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$3 AND f.retracted_rev IS NULL
        AND r.kind='value' AND r.data->>'kind'='sealed'
        AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id
          AND t.kind='fact' AND t.id=r.data#>>'{paper,id}')
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookPaperType, practiceCustodyType],
  );
  return rows.map(row => factId(row.id));
}

export async function listWorkbookCorrectionIds(
  tx: ActivityEvidenceReadScope,
  paperId: FactId,
  attemptId?: FactId,
): Promise<FactId[]> {
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'paperId'=$3
        AND ($4::text IS NULL OR r.data#>>'{attempt,id}'=$4) ORDER BY f.created_tick, f.id`,
    [tx.learner, workbookCorrectionType, paperId, attemptId ?? null],
  );
  return rows.map(({ id }) => id);
}

export type WorkbookPaperSnapshot =
  | { paper: WorkbookPaper; revision: Revision; pending: true; epoch?: undefined }
  | { paper: WorkbookPaper; revision: Revision; epoch: string; pending?: undefined };

export async function readWorkbookPaperSnapshot(ports: {
  id: FactId;
  factType: (id: FactId) => Promise<string | null>;
  assertUnburnedFact: (ids: readonly string[]) => Promise<void>;
  sealedPracticePaper: (id: FactId) => Promise<{ paper: WorkbookPaper; custody: { value: { paper: { rev: Revision } } } } | null | undefined>;
  read: () => ReadContext;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isReadDenied'>;
}): Promise<WorkbookPaperSnapshot> {
  const type = await ports.factType(ports.id);
  if (type === null) {
    await ports.assertUnburnedFact([ports.id]);
    const opened = await ports.sealedPracticePaper(ports.id);
    if (opened) return { paper: opened.paper, revision: opened.custody.value.paper.rev, pending: true };
  }
  if (type !== workbookPaperType) {
    ports.checks.fail(404, '找不到这份试卷。');
  }
  try {
    const read = ports.read();
    const fact = await read.fact(ports.id, { mode: 'following' });
    const paper = workbookPaper(fact.value);
    await readFrozenWorkbookBank(read, paper);
    return { paper, revision: fact.ref.rev, epoch: fact.accessEpoch };
  } catch (error) {
    mapWorkbookReadFailure(error, '找不到这份试卷。', '这份试卷当前不可读取。', ports.checks);
  }
}

export async function readWorkbookAttemptOrNull(ports: {
  id: FactId;
  factType: (id: FactId) => Promise<string | null>;
  read: () => ReadContext;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isReadDenied'>;
}): Promise<WorkbookAttempt | null> {
  if (await ports.factType(ports.id) !== workbookAttemptType) return null;
  try {
    const fact = await ports.read().fact(factId(ports.id), { mode: 'following' });
    return workbookAttempt(fact.value);
  } catch (error) {
    mapWorkbookReadFailure(error, '找不到这次作答。', '这次作答当前不可读取。', ports.checks);
  }
}

export function prepareWorkbookBankInput(
  input: unknown,
  stableId: (...parts: string[]) => string,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError'>,
) {
  if (!isJson(input) || input === null || Array.isArray(input) || typeof input !== 'object') {
    checks.fail(400, '题库组卷格式无效。');
  }
  const { requestId, title, questions, materialId, assessmentRelease } = input as JsonObject;
  if (assessmentRelease !== undefined) checks.fail(400, '题库题项的评估契约由服务器冻结。');
  let request: string;
  try {
    request = workbookRequestId(requestId);
  } catch (error) {
    invalidWorkbookInput(error, '题库请求标识无效。', checks);
  }
  const paperId = factId(stableId('workbook-paper', request));
  const key = commandId(stableId('save-workbook-paper', paperId));
  const bankDraft = { title, questions, materialId: materialId ?? null };
  if (!isJson(bankDraft)) checks.fail(400, '题库组卷格式无效。');
  const baseFactIds = [paperId, ...(typeof materialId === 'string' ? [materialId] : [])];
  return { paperId, key, bankDraft, questions, baseFactIds };
}

export function workbookBankReferenceIds(questions: unknown): string[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap(question => {
    const ref = workbookBankReference(question);
    return ref ? [ref.id] : [];
  });
}

export async function runWorkbookBankSave(ports: {
  input: unknown;
  deletionWatermark: string;
  now: string;
  stableId: (...parts: string[]) => string;
  checks: WorkbookErrorChecks;
  assertUnburnedFact: (ids: readonly string[]) => Promise<void>;
  readRecordedCommand: (id: CommandId) => Promise<{ input: unknown } | null | undefined>;
  saveCommand: (request: {
    id: CommandId;
    type: typeof saveWorkbookPaperCommand;
    deletionWatermark: string;
    input: { id: FactId; bankDraft: Json; savedAt: string };
  }) => Promise<{ state: string; wrote: readonly { id: FactId }[] }>;
  readPaper: (paperId: FactId) => Promise<WorkbookPaper>;
}): Promise<{ id: FactId }> {
  const { paperId, key, bankDraft, questions, baseFactIds } = prepareWorkbookBankInput(ports.input, ports.stableId, ports.checks);
  await ports.assertUnburnedFact(baseFactIds);
  const recorded = await ports.readRecordedCommand(key);
  const previous = (recorded?.input as { input?: { savedAt?: string } } | undefined)?.input;
  try {
    const refIds = workbookBankReferenceIds(questions);
    if (refIds.length) await ports.assertUnburnedFact(refIds);
    const receipt = await ports.saveCommand({
      id: key,
      type: saveWorkbookPaperCommand,
      deletionWatermark: ports.deletionWatermark,
      input: { id: paperId, bankDraft, savedAt: previous?.savedAt ?? ports.now },
    });
    if (receipt.state !== 'done' || !receipt.wrote.some(ref => ref.id === paperId)) {
      ports.checks.fail(409, '试卷发放未完成。');
    }
    await ports.readPaper(paperId);
    return { id: paperId };
  } catch (error) {
    if (ports.checks.isLifecycleError(error)) throw error;
    if (
      error instanceof WorkbookSourceMismatch ||
      (error instanceof Error && error.message === 'Command ID already used with a different command identity')
    ) {
      ports.checks.fail(409, '题版、来源、独立核验或请求标识已变化。');
    }
    invalidWorkbookInput(error, '试卷格式无效。', ports.checks);
  }
}

export async function runWorkbookSavePaper<TRelease extends NonNullable<WorkbookPaper['assessmentRelease']>>(ports: {
  input: unknown;
  now: string;
  stableId: (...parts: string[]) => string;
  prepareRelease: (release: unknown, paperId: FactId, draft: WorkbookDraft) => TRelease;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError' | 'isReadDenied'>;
  readPaperOrNull: (paperId: FactId) => Promise<WorkbookPaper | null>;
  sourceAvailable: (materialId: string) => Promise<boolean>;
  saveCommand: (request: {
    id: CommandId;
    type: typeof saveWorkbookPaperCommand;
    input: { id: FactId; data: WorkbookPaper };
  }) => Promise<void>;
}): Promise<FactId> {
  let draft: WorkbookDraft & Pick<WorkbookPaper, 'assessmentRelease'>;
  let paperId: FactId;
  try {
    const row = ports.input as { requestId?: unknown; assessmentRelease?: unknown } | null;
    const request = workbookRequestId(row?.requestId);
    paperId = factId(ports.stableId('workbook-paper', request));
    draft = workbookDraft(ports.input);
    if (row?.assessmentRelease !== undefined) {
      draft.assessmentRelease = ports.prepareRelease(row.assessmentRelease, paperId, draft);
    }
  } catch (error) {
    invalidWorkbookInput(error, '试卷格式无效。', ports.checks);
  }
  const existing = await ports.readPaperOrNull(paperId);
  if (existing) {
    if (!sameWorkbookDraft(existing, draft)) {
      ports.checks.fail(409, '同一个请求标识已经用于不同的试卷。');
    }
    return paperId;
  }
  if (draft.materialId !== null && !await ports.sourceAvailable(draft.materialId)) {
    ports.checks.fail(400, '来源材料不存在或当前不可读取。');
  }
  const data: WorkbookPaper = { ...draft, savedAt: ports.now };
  try {
    await ports.saveCommand({
      id: commandId(ports.stableId('save-workbook-paper', paperId)),
      type: saveWorkbookPaperCommand,
      input: { id: paperId, data },
    });
  } catch (error) {
    if (error instanceof WorkbookSourceMismatch) ports.checks.fail(409, error.message);
    if (error instanceof FactNotFoundError) ports.checks.fail(409, '找不到引用的来源版本。');
    if (ports.checks.isReadDenied(error)) ports.checks.fail(409, '来源材料已撤回，不能保存这份试卷。');
    if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
      const saved = await ports.readPaperOrNull(paperId);
      if (saved && sameWorkbookDraft(saved, draft)) return paperId;
      ports.checks.fail(409, '同一个请求标识已经用于不同的试卷。');
    }
    throw error;
  }
  return paperId;
}

export async function loadWorkbookDetail<
  TQuestion extends WorkbookQuestionView,
  TFormal extends { releaseRef?: unknown },
>(ports: {
  paperId: FactId;
  snapshot: WorkbookPaperSnapshot;
  sealedPractice: boolean;
  read: ReadContext;
  unavailable: (error: unknown) => boolean;
  sourceView: (materialId: string) => Promise<WorkbookSourceView>;
  assessments: Map<string, WorkbookRubricAssessmentView[]>;
  attempts: Awaited<ReturnType<typeof readWorkbookAttempts>>;
  correctionIds: () => Promise<FactId[]>;
  historicalMount: (fact: FactSnapshot) => Promise<{ paper: { id: FactId; rev: Revision }; epoch: string } | null | undefined>;
  projectQuestions: (paper: WorkbookPaper, mount: { paper: { id: FactId; rev: Revision }; epoch: string }) => Promise<TQuestion[]>;
  formalAssessment: (paper: WorkbookPaper, ref: { id: FactId; rev: Revision }) => Promise<{ view: TFormal; result: Parameters<typeof workbookCorrectionItems>[2] } | undefined>;
}): Promise<WorkbookDetail & {
  assessmentReleaseRef?: TFormal['releaseRef'];
  attempts: (WorkbookDetail['attempts'][number] & { rev: number; formalAssessment?: TFormal; paperRev?: number; questions: TQuestion[] })[];
}> {
  const { paper, revision, epoch, pending } = ports.snapshot;
  const source = paper.materialId === null ? null : await ports.sourceView(paper.materialId);
  const corrections = ports.attempts.length
    ? await readWorkbookCorrections(await ports.correctionIds(), ports.read, ports.unavailable)
    : new Map();
  return projectWorkbookDetail(ports.paperId, revision, paper, source, Boolean(pending) || ports.sealedPractice, {
    attempts: ports.attempts,
    assessments: ports.assessments,
    read: ports.read,
    unavailable: ports.unavailable,
    corrections,
    async frozenAttempt(fact, attempt) {
      try {
        await readFrozenWorkbookBank(ports.read, attempt.paper);
      } catch (error) {
        if (ports.unavailable(error) || error instanceof WorkbookSourceMismatch) return;
        throw error;
      }
      const mount = await ports.historicalMount(fact);
      if (mount) return { questions: await ports.projectQuestions(attempt.paper, mount), paperRev: mount.paper.rev };
      return attempt.paperRev === undefined ? { questions: [] } : undefined;
    },
    formalAssessment: ports.formalAssessment,
    questions: async () => pending
      ? workbookQuestionsView(paper) as TQuestion[]
      : ports.projectQuestions(paper, { paper: { id: ports.paperId, rev: revision }, epoch }),
  });
}

export async function runWorkbookCorrection(ports: {
  paperId: string;
  attemptId: string;
  input: Record<string, unknown>;
  deletionWatermark: string;
  stableId: (...parts: string[]) => string;
  unavailable: (error: unknown) => boolean;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError' | 'isReadDenied'>;
  locked: <T>(run: () => Promise<T>) => Promise<T>;
  assertDeletionWatermark: (watermark: string) => Promise<void>;
  read: () => ReadContext;
  hasHistoricalMount: (paperId: FactId, original: FactSnapshot, read: ReadContext) => Promise<boolean>;
  formalResult: (paper: WorkbookPaper, ref: { id: FactId; rev: Revision }) => Promise<Parameters<typeof workbookCorrectionItems>[2]>;
  gradesForAttempt: (paperId: FactId, attemptId: string) => Promise<readonly WorkbookRubricAssessmentView[]>;
  correctionIds: (paperId: FactId, attemptId: FactId) => Promise<FactId[]>;
  recordCorrection: (id: FactId, data: ReturnType<typeof workbookCorrectionTarget>) => Promise<{ state: string }>;
}): Promise<{ id: FactId }> {
  let data: ReturnType<typeof workbookCorrectionTarget>;
  try {
    data = workbookCorrectionTarget({
      paperId: ports.paperId,
      attempt: { id: ports.attemptId, rev: ports.input.attemptRev },
      itemId: ports.input.itemId,
    });
  } catch (error) {
    invalidWorkbookInput(error, '订正请求无效。', ports.checks);
  }
  try {
    return await ports.locked(async () => {
      await ports.assertDeletionWatermark(ports.deletionWatermark);
      const read = ports.read();
      const { fact: original, attempt } = await openWorkbookCorrectionTarget(read, data);
      if (!await ports.hasHistoricalMount(data.paperId, original, read)) {
        ports.checks.fail(409, '无法确认这次作答的原卷版本。');
      }
      const formalResult = await ports.formalResult(attempt.paper, original.ref);
      const grades = await ports.gradesForAttempt(data.paperId, ports.attemptId);
      if (!workbookCorrectionItems(attempt, grades, formalResult).includes(data.itemId)) {
        throw new WorkbookSourceMismatch('这道题没有可订正的错题或部分得分结果。');
      }
      const ids = await ports.correctionIds(data.paperId, original.ref.id);
      const saved = (await readWorkbookCorrections(ids, read, ports.unavailable)).get(original.ref.id)?.find(
        record => record.itemId === data.itemId && sameWorkbookCorrectionAttempt(record, original),
      );
      if (saved) return { id: saved.id };
      const id = factId(ports.stableId('workbook-correction', original.ref.id, String(original.ref.rev), String(original.accessEpoch), data.itemId));
      const receipt = await ports.recordCorrection(id, data);
      if (receipt.state !== 'done') ports.checks.fail(409, '原订正记录当前不可使用。');
      return { id };
    });
  } catch (error) {
    mapWorkbookReadFailure(error, '找不到订正对应的作答。', '订正对应的卷面或作答已不可用。', ports.checks);
  }
}

export async function runWorkbookPresentation(ports: {
  id: string;
  input: unknown;
  stableId: (...parts: string[]) => string;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isReadDenied'>;
  locked: (run: () => Promise<void>) => Promise<void>;
  read: () => ReadContext;
  record: (key: CommandId, data: ReturnType<typeof workbookPresentation>) => Promise<void>;
}) {
  try {
    const data = workbookPresentation(ports.input);
    if (data.paper.id !== ports.id || 'issuanceId' in data) {
      throw new WorkbookPresentationError('呈现卷面不匹配。');
    }
    const key = commandId(ports.stableId(recordWorkbookPresentationCommand, JSON.stringify(data)));
    await ports.locked(async () => {
      await authorizeWorkbookPresentation(ports.read(), data);
      await ports.record(key, data);
    });
    if (data.phase === 'permit') return { permit: key };
    if (data.kind === 'solution' && data.phase === 'displayed') return { recorded: true, displayId: key };
  } catch (error) {
    if (error instanceof WorkbookPresentationError) ports.checks.fail(400, error.message);
    mapWorkbookReadFailure(error, '找不到呈现的试卷。', '这份试卷当前不可读取。', ports.checks);
  }
  return { recorded: true };
}

export type PreparedWorkbookSubmit = {
  readonly paperId: FactId;
  readonly data: WorkbookAttemptRequest;
  readonly attemptId: FactId;
  readonly paperRev: Revision | undefined;
  readonly versioned: boolean;
  readonly legacyCommand: CommandId;
  readonly versionedCommand: CommandId;
};

export function prepareWorkbookSubmit(
  id: string,
  input: unknown,
  now: string,
  stableId: (...parts: string[]) => string,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError'>,
): PreparedWorkbookSubmit {
  const paperId = workbookFactIdOf(id, '找不到这份试卷。', checks.fail);
  let data: WorkbookAttemptRequest;
  try {
    data = workbookAttemptRequest(input, { paperId, submittedAt: now });
  } catch (error) {
    invalidWorkbookInput(error, '作答格式无效。', checks);
  }
  const attemptId = factId(stableId('workbook-attempt', paperId, data.requestId));
  const paperRev = data.paperRev;
  return {
    paperId,
    data,
    attemptId,
    paperRev,
    versioned: paperRev !== undefined,
    legacyCommand: commandId(stableId('submit-workbook-attempt', attemptId)),
    versionedCommand: commandId(stableId('submit-versioned-workbook-attempt', data.requestId)),
  };
}

export async function runWorkbookSubmitTransaction(ports: {
  prepared: PreparedWorkbookSubmit;
  deletionWatermark: string;
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError' | 'isReadDenied'>;
  assertUnburned: (kind: 'fact' | 'command', ids: readonly string[]) => Promise<void>;
  assertDeletionWatermark: (watermark: string) => Promise<void>;
  readPaperSnapshot: (paperId: FactId) => Promise<WorkbookPaperSnapshot>;
  isPracticeWorkbook: (paperId: FactId) => Promise<boolean>;
  readAttemptOrNull: (attemptId: FactId) => Promise<WorkbookAttempt | null>;
  readRecordedCommand: (id: CommandId) => Promise<{ type: string; state: string; input: unknown } | null | undefined>;
  read: () => ReadContext;
  checkFrozenSubmission: (release: NonNullable<WorkbookPaper['assessmentRelease']>, ref: { id: FactId; rev: Revision }, answers: Record<string, WorkbookAnswer>) => void;
  submitCommand: (
    pending: boolean,
    request: {
      actor: 'learner';
      purpose: string;
      input: { id: FactId; data: WorkbookAttemptRequest };
      type: typeof submitWorkbookAttemptCommand;
      deletionWatermark: string;
      id: CommandId;
    },
  ) => Promise<void>;
}) {
  const { paperId, data, attemptId, paperRev, versioned, legacyCommand, versionedCommand } = ports.prepared;
  function conflict(): never {
    ports.checks.fail(409, '同一个提交标识已经用于不同的作答。');
  }
  try {
    await ports.assertUnburned('fact', [attemptId, paperId]);
    await ports.assertDeletionWatermark(ports.deletionWatermark);
    const snapshot = await ports.readPaperSnapshot(paperId);
    const sealed = Boolean(snapshot.pending) || await ports.isPracticeWorkbook(paperId);
    if (sealed && versioned) ports.checks.fail(400, '只有普通试卷接受逐题过程。');
    const existing = await ports.readAttemptOrNull(attemptId);
    if (existing && (existing.paperId !== paperId || existing.requestId !== data.requestId)) conflict();
    const envelope = { actor: 'learner' as const, purpose: storagePurpose, input: { id: attemptId, data } };
    const legacyReplay = !versioned && existing !== null && existing.paperRev === undefined;
    if (!sealed) await ports.assertUnburned('command', [legacyReplay ? legacyCommand : versionedCommand]);
    if (!sealed && !legacyReplay) {
      const recorded = await ports.readRecordedCommand(versionedCommand);
      if (recorded || existing) {
        if (
          paperRev === undefined ||
          !existing ||
          recorded?.type !== submitWorkbookAttemptCommand ||
          recorded.state !== 'done' ||
          !sameWorkbookJson(recorded.input, {
            ...envelope,
            input: { id: attemptId, data: { ...data, submittedAt: existing.submittedAt } },
          })
        ) {
          return conflict();
        }
        const read = ports.read();
        await read.fact(paperId, { mode: 'pinned', rev: paperRev });
        await readFrozenWorkbookBank(read, existing.paper);
        return;
      }
    }
    if (versioned && paperRev !== snapshot.revision) {
      throw new WorkbookRevisionMismatch('卷版已变化，请刷新后交卷。');
    }
    const paper = existing?.paper ?? snapshot.paper;
    let graded: ReturnType<typeof gradeWorkbook>;
    try {
      checkWorkbookPacingItems(paper, data.pacing);
      graded = gradeWorkbook(paper, data.answers);
      if (paper.assessmentRelease) {
        ports.checkFrozenSubmission(paper.assessmentRelease, { id: attemptId, rev: 1 as Revision }, graded.answers);
      }
    } catch (error) {
      invalidWorkbookInput(error, '作答格式无效。', ports.checks);
    }
    if (existing) {
      if (!sameWorkbookJson(existing.answers, graded.answers) || existing.assessmentConsent !== data.assessmentConsent) {
        conflict();
      }
      return;
    }
    await ports.submitCommand(Boolean(snapshot.pending), {
      ...envelope,
      type: submitWorkbookAttemptCommand,
      deletionWatermark: ports.deletionWatermark,
      id: versioned ? versionedCommand : legacyCommand,
    });
  } catch (error) {
    if (ports.checks.isReadDenied(error) || error instanceof FactNotFoundError || error instanceof WorkbookSourceMismatch) {
      ports.checks.fail(403, '这份试卷当前不可读取。');
    }
    if (error instanceof WorkbookRevisionMismatch) ports.checks.fail(409, error.message);
    if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
      conflict();
    }
    throw error;
  }
}

export function parseWorkbookAssessmentParams(
  paperValue: string,
  attemptValue: string,
  input: unknown,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError'>,
): { paperId: FactId; attemptId: FactId; request: WorkbookAssessmentRequest } {
  const paperId = workbookFactIdOf(paperValue, '找不到这份试卷。', checks.fail);
  const attemptId = workbookFactIdOf(attemptValue, '找不到这次作答。', checks.fail);
  let request: WorkbookAssessmentRequest;
  try {
    request = workbookAssessmentRequest(input);
  } catch (error) {
    invalidWorkbookInput(error, '评分标准批改请求无效。', checks);
  }
  return { paperId, attemptId, request };
}

export async function selectWorkbookRubricAssessment(ports: {
  paperId: FactId;
  attemptId: FactId;
  questionId: string;
  stableId: (...parts: string[]) => string;
  fail: WorkbookFail;
  readPaper: (paperId: FactId) => Promise<WorkbookPaper>;
  readAttemptOrNull: (attemptId: FactId) => Promise<WorkbookAttempt | null>;
  read: () => ReadContext;
  allAssessments: (paperId: FactId, assessmentId: FactId) => Promise<Map<string, WorkbookRubricAssessmentView[]>>;
}) {
  const paper = await ports.readPaper(ports.paperId);
  const attempt = await ports.readAttemptOrNull(ports.attemptId);
  if (!attempt || attempt.paperId !== ports.paperId) {
    ports.fail(404, '找不到这次作答。');
  }
  const input = legacyRubricInput(attempt, ports.questionId);
  if (input.state !== 'ready') ports.fail(input.status, input.reason);
  const { question, answer } = input;
  const assessmentId = factId(ports.stableId(...rubricAssessmentIdentity(ports.attemptId, question)));
  const reads = ports.read();
  const manifestInputs = [];
  for (const source of [ports.paperId, ports.attemptId]) {
    const record = await reads.fact(source, { mode: 'following' });
    manifestInputs.push({
      kind: 'fact' as const,
      id: source,
      rev: record.ref.rev,
      accessEpoch: record.accessEpoch,
      mode: 'following' as const,
    });
  }
  return {
    question,
    answer,
    assessmentId,
    independent: independentlyAuthoredPaper(paper) && independentlyAuthoredPaper(attempt.paper),
    manifestInputs,
    existing: (await ports.allAssessments(ports.paperId, assessmentId)).get(ports.attemptId)?.[0],
  };
}

export function validateWorkbookRubricRoute(params: {
  request: WorkbookAssessmentRequest;
  inputRoute: unknown;
  settings: { readonly allowSearch: boolean; readonly baseUrl: string };
  routeMatches: (route: unknown) => boolean;
  fail: WorkbookFail;
}) {
  if (params.request.publicSearchQuery && !params.settings.allowSearch) {
    params.fail(400, '请在设置中启用公开检索。');
  }
  if (params.request.providerBaseUrl !== params.settings.baseUrl || !params.routeMatches(params.inputRoute)) {
    params.fail(409, '模型端点已经变化，请重新确认本次批改。');
  }
}

export function buildWorkbookRubricEffectInput(params: {
  attemptId: FactId;
  paperId: FactId;
  question: WorkbookRubricQuestion;
  request: WorkbookAssessmentRequest;
  baseUrl: string;
  step: { readonly index: number; readonly model: string; readonly requestDigest: string };
  generation: string;
}) {
  return {
    stepKey: 'rubric:' + params.question.id + ':' + params.generation + ':' + params.step.index,
    label: 'workbook-rubric',
    input: {
      assessmentVersion: workbookRubricAssessmentVersion,
      attemptId: params.attemptId,
      paperId: params.paperId,
      questionId: params.question.id,
      rubricVersion: params.question.rubricVersion,
      consent: params.request.consent,
      provider: params.baseUrl,
      model: params.step.model,
      requestDigest: params.step.requestDigest,
    },
  };
}

export function validateWorkbookRubricPreSend(params: {
  sameProvider: boolean;
  sameApiKey: boolean;
  isSearchStep: boolean;
  allowSearch: boolean;
  sameExaKey: boolean;
  manifestValid: boolean;
  fail: WorkbookFail;
}) {
  if (!params.sameProvider || !params.sameApiKey) params.fail(409, '模型配置已变化，请重新确认批改。');
  if (params.isSearchStep && (!params.allowSearch || !params.sameExaKey)) params.fail(409, '公开检索授权已撤回。');
  if (!params.manifestValid) params.fail(409, '批改依据已经变化。');
}

export function unwrapWorkbookRubricEffect(effect: { kind: string; providerEffectId?: string | null | undefined; result?: unknown }): string {
  if (effect.kind === 'unknown') {
    throw new UncertainRubricEffect(
      '提供方的批改结果待核对，本次没有重复发送。' +
        (effect.providerEffectId ? '请求标识 ' + effect.providerEffectId : ''),
    );
  }
  if (typeof effect.result !== 'string') throw new Error('提供方返回的批改结果无效。');
  return effect.result;
}

export function resolveWorkbookRubricResult(
  raw: Parameters<typeof workbookAssessmentResult>[0],
) {
  return workbookAssessmentResult(raw);
}

export function classifyWorkbookRubricError(
  error: unknown,
  checks: Pick<WorkbookErrorChecks, 'fail' | 'isRequestError'> & {
    readonly isTeachingError: (error: unknown) => boolean;
  },
) {
  if (checks.isRequestError(error)) throw error;
  if (error instanceof UncertainRubricEffect) checks.fail(409, error.message);
  if (checks.isTeachingError(error)) {
    return { verdict: 'pending' as const, feedback: (error as Error).message, evidence: [], trace: [] };
  }
  checks.fail(502, '批改未完成，原作答已保留。');
}

export function buildWorkbookRubricPublication(params: {
  attemptId: FactId;
  paperId: FactId;
  assessmentId: FactId;
  generation: string;
  question: WorkbookRubricQuestion;
  request: WorkbookAssessmentRequest;
  result: ReturnType<typeof workbookAssessmentResult>;
  assessedAt: string;
  route: {
    readonly providerBaseUrl: string;
    readonly requestedModel: string;
    readonly providerProtocol: string;
    readonly providerId: string;
  };
  priorId?: string | undefined;
  stableId: (...parts: string[]) => string;
}) {
  const value = completedLegacyRubric({
    attemptId: params.attemptId,
    paperId: params.paperId,
    question: params.question,
    request: params.request,
    result: params.result,
    assessedAt: params.assessedAt,
    route: params.route,
  });
  return {
    kind: 'publish' as const,
    id: derivationId(params.stableId('rubric-result', params.assessmentId, params.generation, params.request.requestId)),
    slotType: workbookRubricAssessmentType,
    key: params.assessmentId,
    deriver: workbookRubricAssessmentVersion,
    scope: { paperId: params.paperId, attemptId: params.attemptId },
    value,
    previous: params.priorId ? derivationId(params.priorId) : null,
  };
}
