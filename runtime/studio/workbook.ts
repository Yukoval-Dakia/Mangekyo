import { createPythonDeriverHost, type PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { assessWithAgent } from '../../executors/teaching/assessment-agent.ts';
import { TeachingError, type TeachingDependencies } from '../../executors/teaching/index.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { readFactType as factType } from '../../kernel/src/commands/fact-collection.ts';
import { readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { commandId, factId, LifecycleError, parseManifest, revalidateManifest, storeSettledValue, type DbTransaction, type FactId, type Json, type ReadContext, type ReadTransaction, type Revision } from '../../kernel/src/index.ts';
import { assertDeletionWatermark, assertUnburned, deletionWatermark as readDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { newUlid } from '../../kernel/src/work/identity.ts';
import { runEffect } from '../../kernel/src/work/index.ts';
import { examTimeValueMethod, projectWorkbookExamTimeValue, unknownExamTimeValue, type ExamTimeValueView } from '../../modules/activity/exam-time-value.ts';
import { allAssessments, openWorkbookExamTimeValueBundle, verifyWorkbookExamTimeValueBundle, type AuthorizedExamTimeValueBundle, type WorkbookExamTimeValueAccess } from '../../modules/activity/learning-attempt-read.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { bindPreSubmitRevisionWitness } from '../../modules/activity/pre-submit-revision.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import { includesBankReferences } from '../../modules/activity/workbook-bank.ts';
import { recordWorkbookCorrection } from '../../modules/activity/workbook-correction.ts';
import { buildWorkbookRubricEffectInput, buildWorkbookRubricPublication, classifyWorkbookRubricError, hasWorkbookOnceAttachmentReuse, listWorkbookCorrectionIds, listWorkbookPaperIds, loadWorkbookDetail, mapWorkbookReadFailure, parseWorkbookAssessmentParams, prepareWorkbookSubmit, readWorkbookAttemptOrNull, readWorkbookPaperSnapshot, readWorkbookSourceView, resolveWorkbookRubricResult, runWorkbookAttachmentUpload, runWorkbookBankSave, runWorkbookCorrection, runWorkbookPresentation, runWorkbookSavePaper, runWorkbookSubmitTransaction, selectWorkbookRubricAssessment, unwrapWorkbookRubricEffect, validateWorkbookRubricPreSend, validateWorkbookRubricRoute, workbookFactIdOf, type WorkbookErrorChecks } from '../../modules/activity/workbook-operations.ts';
import { recordWorkbookPresentationCommand } from '../../modules/activity/workbook-presentation.ts';
import { workbookPaperType, workbookQuestionsView, type WorkbookAttemptView, type WorkbookDetail, type WorkbookPaper, type WorkbookSummary } from '../../modules/activity/workbook-values.ts';
import { projectWorkbookReview, readWorkbookAttempts, readWorkbookSummaries, type ReviewEntry } from '../../modules/activity/workbook-views.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { captureSourceCommand } from '../../modules/capture/source.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { createStudioCommand, isFactReadDenied, isFactUnavailable, storageRead } from './fact-read-helpers.ts';
import { routeMatchesInput, sameActiveProvider } from './harness.ts';
import { stableId, studioLearner } from './identity.ts';
import { digest, openIntakeObjects } from './intake-objects.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import { isPracticeWorkbook, sealedPracticePaper, submitWithPracticeCustody } from './sealed-practice.ts';
import { RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';
import { frozenSubmission, openWorkbookAssessment, prepareWorkbookRelease, readWorkbookAssessment } from './workbook-assessment.ts';
import { historicalWorkbookMount, openWorkbookContext, type WorkbookContextAuthority, type WorkbookQuestionWithContext } from './workbook-context.ts';
import { readWorkbookPreSubmitPitfalls, verifyWorkbookPreSubmitRevision, type WorkbookPreSubmitAuthority, type WorkbookPreSubmitReadOptions } from './workbook-pre-submit.ts';

const checks: WorkbookErrorChecks = {
  fail: (status, message) => { throw new RequestError(status, message); },
  isRequestError: error => error instanceof RequestError,
  isReadDenied: isFactReadDenied,
  isLifecycleError: error => error instanceof LifecycleError,
};
const factIdOf = (value: unknown, message: string) => workbookFactIdOf(value, message, checks.fail);
const workbookUnavailable = (error: unknown) => isFactUnavailable(error) || (error instanceof RequestError && (error.status === 403 || error.status === 404));
const sourceView = (read: ReadContext, id: string) => readWorkbookSourceView(read, id, isFactUnavailable);
const readPaperSnapshot = (tx: ReadTransaction, id: FactId) => readWorkbookPaperSnapshot({
  id, factType: target => factType(tx, target), assertUnburnedFact: ids => assertUnburned(tx, 'fact', ids),
  sealedPracticePaper: target => sealedPracticePaper(tx, target), read: () => storageRead(tx), checks,
});
const readPaper = async (tx: ReadTransaction, id: FactId) => (await readPaperSnapshot(tx, id)).paper;
const readPaperOrNull = async (tx: ReadTransaction, id: FactId): Promise<WorkbookPaper | null> =>
  await factType(tx, id) === workbookPaperType ? readPaper(tx, id) : null;
const readAttemptOrNull = (tx: ReadTransaction, id: FactId) =>
  readWorkbookAttemptOrNull({ id, factType: target => factType(tx, target), read: () => storageRead(tx), checks });
const readAttempts = (tx: ReadTransaction, read: ReadContext, paperId?: FactId) =>
  readWorkbookAttempts(tx, read, isFactUnavailable, paperId);

type FormalAssessmentView = Awaited<ReturnType<typeof readWorkbookAssessment>>;
type WorkbookDetailWithAssessment = Omit<WorkbookDetail, 'attempts'> & {
  assessmentReleaseRef?: FormalAssessmentView['releaseRef'];
  attempts: (WorkbookAttemptView & { rev: number; formalAssessment?: FormalAssessmentView; paperRev?: number;
    examTimeValue?: ExamTimeValueView; questions: WorkbookQuestionWithContext[] })[];
};
let sharedPacingHost: PythonDeriverHost | undefined;

export function openWorkbook(db: Db, activity: LoadedModule, {
  capture, assessment = openWorkbookAssessment(db), onResearchFactsChanged, context = {}, preSubmit, pythonHost,
}: {
  capture?: LoadedModule; context?: WorkbookContextAuthority; preSubmit?: WorkbookPreSubmitAuthority;
  pythonHost?: PythonDeriverHost; assessment?: ReturnType<typeof openWorkbookAssessment>; onResearchFactsChanged?: CommandHooks['onFactsChanged'];
} = {}) {
  const objects = openIntakeObjects(db);
  const hooks = createStudioCommandHooks({ async afterFactsChanged(tx, tick, changes) {
    await assessment.afterFactsChanged(tx, tick, changes);
    await onResearchFactsChanged?.(tx, tick, changes);
  } });
  const commands = { modules: [activity], hooks }, handle = createStudioCommand(db, commands);
  const snap = <T>(run: (tx: ReadTransaction) => Promise<T>) => db.snapshot({ learner: studioLearner }, run);
  const locked = <T>(run: (tx: DbTransaction) => Promise<T>) => db.tx({ learner: studioLearner }, async tx => { await lockLearner(tx, tx.learner); return run(tx); });
  const localHandle = (tx: DbTransaction, extra?: Record<string, unknown>) =>
    createStudioCommand(withinLearnerTransaction(db, tx), { ...commands, ...extra } as Parameters<typeof createStudioCommand>[1]);
  const capsules = openWorkbookContext(db, activity, hooks, context);

  const saveBank = (tx: DbTransaction, input: unknown) => {
    const bound = localHandle(tx, { bindCommandRead: (inner: ReadTransaction, _: unknown, base: ReadContext) => ({ ...base, slot: readCurrentQuestionVerification(inner) }) });
    return runWorkbookBankSave({
      input, deletionWatermark: submittedWatermark(input), now: new Date().toISOString(), stableId, checks,
      assertUnburnedFact: ids => assertUnburned(tx, 'fact', ids), readRecordedCommand: id => readRecordedCommand(tx, id),
      saveCommand: request => bound({ learner: tx.learner, actor: 'learner', purpose: storagePurpose, ...request }),
      readPaper: id => readPaper(tx, id),
    });
  };
  async function formalAssessment(tx: ReadTransaction, paper: WorkbookPaper, ref: { id: FactId; rev: Revision }) {
    if (!paper.assessmentRelease) return;
    const view = await readWorkbookAssessment(tx, paper.assessmentRelease, ref);
    return { view, result: 'result' in view ? view.result : undefined };
  }
  async function deriveExamTimeValue(bundle: AuthorizedExamTimeValueBundle, maySend?: WorkbookExamTimeValueAccess['maySend']): Promise<ExamTimeValueView> {
    const fallback = unknownExamTimeValue(bundle.paperRef, bundle.attemptRef);
    const derived = await (pythonHost ?? (sharedPacingHost ??= createPythonDeriverHost())).derive(examTimeValueMethod, bundle.request);
    if (derived.kind !== 'ok' || derived.outcome.kind !== 'value') return fallback;
    const valid = await snap(tx => verifyWorkbookExamTimeValueBundle(tx, bundle,
      (release, attemptRef, epochs) => readWorkbookAssessment(tx, release, attemptRef, { ...epochs, purpose: bundle.purpose, ...(maySend ? { maySend } : {}) }), maySend));
    return valid ? projectWorkbookExamTimeValue({ paperRef: bundle.paperRef, attemptRef: bundle.attemptRef, attempt: bundle.attempt, rawResult: derived.outcome.value }) : fallback;
  }

  async function get(id: string): Promise<WorkbookDetailWithAssessment> {
    const paperId = factIdOf(id, '找不到这份试卷。');
    const gathered = await snap(async tx => {
      if (await factType(tx, paperId) === posttestIssuanceType) {
        try { return { issued: await capsules.issued(tx, paperId) }; }
        catch (error) { mapWorkbookReadFailure(error, '找不到已发放的后测。', '后测当前不可读取。', checks); }
      }
      const snapshot = await readPaperSnapshot(tx, paperId), read = storageRead(tx);
      const detail: WorkbookDetailWithAssessment = await loadWorkbookDetail({
        paperId, snapshot, sealedPractice: await isPracticeWorkbook(tx, paperId), read, unavailable: isFactUnavailable,
        sourceView: materialId => sourceView(read, materialId), assessments: await allAssessments(tx, paperId),
        attempts: await readAttempts(tx, read, paperId), correctionIds: () => listWorkbookCorrectionIds(tx, paperId),
        historicalMount: fact => historicalWorkbookMount(tx, paperId, fact, read), projectQuestions: capsules.questions(tx),
        formalAssessment: (frozen, ref) => formalAssessment(tx, frozen, ref),
      });
      const bundles = new Map<string, AuthorizedExamTimeValueBundle>();
      if (!detail.sealedPractice) {
        for (const attempt of detail.attempts) {
          if (attempt.paperRev === undefined) continue;
          const bundle = await openWorkbookExamTimeValueBundle(tx, paperId, factId(attempt.id), (release, attemptRef, epochs) => readWorkbookAssessment(tx, release, attemptRef, epochs));
          if (bundle) bundles.set(attempt.id, bundle);
        }
      }
      return { detail, bundles };
    });
    if ('issued' in gathered) return gathered.issued;
    if (gathered.detail.sealedPractice) return gathered.detail;
    const resolved = new Map<string, ExamTimeValueView>();
    for (const [attemptId, bundle] of gathered.bundles) resolved.set(attemptId, await deriveExamTimeValue(bundle));
    return {
      ...gathered.detail,
      attempts: gathered.detail.attempts.map(attempt => attempt.paperRev === undefined ? attempt : {
        ...attempt,
        examTimeValue: resolved.get(attempt.id) ?? unknownExamTimeValue({ id: paperId, rev: attempt.paperRev as Revision }, { id: factId(attempt.id), rev: attempt.rev as Revision }),
      }),
    };
  }

  return {
    get,
    correct(paperId: string, attemptId: string, input: Record<string, unknown>, deletionWatermark: string) {
      let activeTx!: DbTransaction;
      return runWorkbookCorrection({
        paperId, attemptId, input, deletionWatermark, stableId, unavailable: isFactUnavailable, checks,
        locked: run => locked(async tx => { activeTx = tx; return run(); }),
        assertDeletionWatermark: wm => assertDeletionWatermark(activeTx, wm), read: () => storageRead(activeTx),
        hasHistoricalMount: async (pid, original, read) => Boolean(await historicalWorkbookMount(activeTx, pid, original, read)),
        formalResult: async (paper, ref) => (await formalAssessment(activeTx, paper, ref))?.result,
        gradesForAttempt: async (pid, aid) => (await allAssessments(activeTx, pid)).get(aid) ?? [],
        correctionIds: (pid, aid) => listWorkbookCorrectionIds(activeTx, pid, aid),
        recordCorrection: (id, data) => localHandle(activeTx)({ learner: activeTx.learner, actor: 'learner', purpose: storagePurpose, deletionWatermark, id: commandId(id), type: recordWorkbookCorrection, input: { id, data } }),
      });
    },
    issueBank: (tx: DbTransaction, input: { requestId: string; questionRefs: readonly { id: FactId; rev: Revision }[]; deletionWatermark?: string }) =>
      saveBank(tx, { requestId: input.requestId, title: '题库练习', deletionWatermark: input.deletionWatermark ?? '0', questions: input.questionRefs.map(sourceQuestionRef => ({ sourceQuestionRef })) } satisfies Json),
    list: (): Promise<WorkbookSummary[]> => snap(async tx => {
      const read = storageRead(tx);
      return readWorkbookSummaries(await listWorkbookPaperIds(tx), await readAttempts(tx, read), id => readPaper(tx, id), id => sourceView(read, id), workbookUnavailable);
    }),
    preSubmitPitfalls: (id: string, options: WorkbookPreSubmitReadOptions = {}) =>
      snap(tx => readWorkbookPreSubmitPitfalls(tx, factIdOf(id, '找不到这份试卷。'), { ...preSubmit, ...options })),
    async examTimeValue(paperValue: string, attemptValue: string, access: WorkbookExamTimeValueAccess = {}): Promise<ExamTimeValueView> {
      const paperId = factIdOf(paperValue, '找不到这份试卷。'), attemptId = factIdOf(attemptValue, '找不到这次作答。');
      const opened = await snap(async tx => {
        const bundle = await openWorkbookExamTimeValueBundle(tx, paperId, attemptId, (release, attemptRef, epochs) =>
          readWorkbookAssessment(tx, release, attemptRef, { ...epochs, ...(access.purpose ? { purpose: access.purpose } : {}), ...(access.maySend ? { maySend: access.maySend } : {}) }), access);
        if (bundle) return { bundle };
        const read = storageRead(tx);
        const paper = await read.fact(paperId, { mode: 'following' }).catch(() => undefined);
        const attempt = await read.fact(attemptId, { mode: 'following' }).catch(() => undefined);
        return { paperRef: { id: paperId, rev: (paper?.ref.rev ?? 1) as Revision }, attemptRef: { id: attemptId, rev: (attempt?.ref.rev ?? 1) as Revision } };
      });
      return 'bundle' in opened && opened.bundle ? deriveExamTimeValue(opened.bundle, access.maySend) : unknownExamTimeValue(opened.paperRef, opened.attemptRef);
    },
    readingLabels: (id: string, query: URLSearchParams, signal: AbortSignal) => capsules.labels(factIdOf(id, '找不到这份试卷。'), query, signal),
    readingContext: (id: string, input: Record<string, unknown>, signal: AbortSignal) => capsules.event(factIdOf(id, '找不到这份试卷。'), input, signal),
    sheet: (id: string) => snap(async tx => {
      const { paper, revision } = await readPaperSnapshot(tx, factIdOf(id, '找不到这份试卷。'));
      return { revision, title: paper.title, questions: workbookQuestionsView(paper) };
    }),
    recordPresentation(id: string, input: unknown) {
      let activeTx!: DbTransaction;
      return runWorkbookPresentation({
        id, input, stableId, checks, locked: run => locked(async tx => { activeTx = tx; await run(); }), read: () => storageRead(activeTx),
        record: async (key, data) => { await localHandle(activeTx)({ learner: activeTx.learner, actor: 'learner', purpose: storagePurpose, id: key, type: recordWorkbookPresentationCommand, input: { id: key, data } }); },
      });
    },
    review: (): Promise<ReviewEntry[]> => snap(async tx => projectWorkbookReview(await readAttempts(tx, storageRead(tx)), await allAssessments(tx),
      async paperId => { try { return Boolean(await readPaperOrNull(tx, factId(paperId))); } catch (error) { if (workbookUnavailable(error)) return false; throw error; } },
      (paper, ref) => formalAssessment(tx, paper, ref).then(found => found?.result))),
    async save(input: unknown): Promise<WorkbookDetailWithAssessment> {
      if (includesBankReferences(input)) return get((await locked(tx => saveBank(tx, input))).id);
      const paperId = await runWorkbookSavePaper({
        input, now: new Date().toISOString(), stableId, prepareRelease: prepareWorkbookRelease, checks,
        readPaperOrNull: pid => snap(tx => readPaperOrNull(tx, pid)),
        sourceAvailable: mid => snap(async tx => (await sourceView(storageRead(tx), mid)).available),
        saveCommand: async request => { await handle({ learner: studioLearner, actor: 'learner', purpose: storagePurpose, ...request }); },
      });
      return get(paperId);
    },
    uploadAttachment(paperValue: string, input: Parameters<typeof runWorkbookAttachmentUpload<Buffer>>[0]['input']) {
      if (!capture) throw new RequestError(500, '原件存储模块未启用。');
      let activeTx!: DbTransaction;
      return runWorkbookAttachmentUpload({
        paperValue, input, captureCommandType: captureSourceCommand, generatedRequestId: newUlid(), stableId, sha256: digest, parseWatermark: submittedWatermark, checks,
        withOriginal: (originalId, bytes, original, run) => objects.withOriginal(originalId, bytes, original, (_, install) => run(install)),
        locked: run => locked(tx => { activeTx = tx; return run(); }),
        assertUnburned: (kind, ids) => assertUnburned(activeTx, kind, ids), assertDeletionWatermark: wm => assertDeletionWatermark(activeTx, wm), readDeletionWatermark: () => readDeletionWatermark(activeTx),
        readPaperSnapshot: pid => readPaperSnapshot(activeTx, pid), readRecordedCommand: cid => readRecordedCommand(activeTx, cid), read: () => storageRead(activeTx),
        captureSource: req => createStudioCommand(withinLearnerTransaction(db, activeTx), { modules: [capture], hooks: createStudioCommandHooks() })({ learner: studioLearner, actor: 'learner', purpose: storagePurpose, type: captureSourceCommand, ...req }),
      });
    },
    async submit(id: string, input: unknown): Promise<WorkbookDetailWithAssessment> {
      const prepared = prepareWorkbookSubmit(id, input, new Date().toISOString(), stableId, checks), deletionWatermark = submittedWatermark(input);
      await locked(tx => runWorkbookSubmitTransaction({
        prepared, deletionWatermark, checks,
        assertUnburned: (kind, ids) => assertUnburned(tx, kind, ids), assertDeletionWatermark: wm => assertDeletionWatermark(tx, wm),
        readPaperSnapshot: pid => readPaperSnapshot(tx, pid), isPracticeWorkbook: pid => isPracticeWorkbook(tx, pid),
        readAttemptOrNull: aid => readAttemptOrNull(tx, aid), readRecordedCommand: cid => readRecordedCommand(tx, cid),
        read: () => storageRead(tx), hasOnceAttachmentReuse: (attemptId, onceIds) => hasWorkbookOnceAttachmentReuse(tx, attemptId, onceIds),
        checkFrozenSubmission: frozenSubmission,
        async submitCommand(pending, request) {
          const local = withinLearnerTransaction(db, tx), full = { ...request, learner: studioLearner };
          if (pending) await submitWithPracticeCustody(local, activity, hooks, prepared.paperId, full);
          else await localHandle(tx, { bindCommandRead: (inner: ReadTransaction, _: unknown, base: ReadContext) =>
            bindPreSubmitRevisionWitness(base, { verify: check => verifyWorkbookPreSubmitRevision(inner, check, preSubmit) }) })(full);
        },
      }));
      return get(prepared.paperId);
    },
    async assess(paperValue: string, attemptValue: string, input: unknown): Promise<WorkbookDetailWithAssessment> {
      const { paperId, attemptId, request } = parseWorkbookAssessmentParams(paperValue, attemptValue, input, checks);
      const selected = await snap(async tx => {
        const chosen = await selectWorkbookRubricAssessment({
          paperId, attemptId, questionId: request.questionId, stableId, fail: checks.fail,
          readPaper: pid => readPaper(tx, pid), readAttemptOrNull: aid => readAttemptOrNull(tx, aid),
          read: () => storageRead(tx), unavailable: isFactUnavailable, allAssessments: (pid, aid) => allAssessments(tx, pid, aid),
        });
        const { rows } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
        return { ...chosen, manifest: parseManifest({ version: 1, learner: tx.learner, purpose: storagePurpose, gatherTick: rows[0]?.tick, inputs: chosen.manifestInputs }) };
      });
      const settings = await loadSettings('assessment');
      validateWorkbookRubricRoute({ request, inputRoute: (input as Record<string, unknown>).route, settings, routeMatches: route => routeMatchesInput(route, settings), fail: checks.fail });
      const prior = selected.existing;
      if (prior && (prior.verdict !== 'pending' || prior.requestId === request.requestId)) return get(paperId);
      const generation = prior?.id ?? stableId('rubric-input', JSON.stringify(selected.manifest.inputs), request.providerBaseUrl, request.publicSearchQuery ?? '');
      const runAssessmentEffect: TeachingDependencies['runEffect'] = async (step, invoke) => {
        const desc = buildWorkbookRubricEffectInput({ attemptId, paperId, question: selected.question, request, baseUrl: settings.baseUrl, step, generation });
        const effect = await runEffect(db, { learner: studioLearner, ownerKind: 'session', ownerId: attemptId, ...desc }, providerEffectId => invoke(providerEffectId),
          async tx => {
            const current = await loadSettings('assessment');
            validateWorkbookRubricPreSend({
              sameProvider: sameActiveProvider(settings, current), sameApiKey: current.apiKey === settings.apiKey,
              isSearchStep: step.provider === 'tool:exa_search', allowSearch: current.allowSearch, sameExaKey: current.exaApiKey === settings.exaApiKey,
              manifestValid: (await revalidateManifest(tx, selected.manifest)).kind === 'valid', fail: checks.fail,
            });
          }, selected.independent && !request.publicSearchQuery ? { manifest: selected.manifest } : undefined);
        return unwrapWorkbookRubricEffect(effect);
      };
      let result;
      try {
        const raw = await assessWithAgent({ question: selected.question.prompt, answer: selected.answer, rubric: selected.question.rubric },
          { provider: settings, runEffect: runAssessmentEffect, allowSearch: settings.allowSearch, exaApiKey: settings.exaApiKey, ...(request.publicSearchQuery ? { publicSearchQuery: request.publicSearchQuery } : {}) });
        result = resolveWorkbookRubricResult(raw);
      } catch (error) { result = classifyWorkbookRubricError(error, { ...checks, isTeachingError: err => err instanceof TeachingError }); }
      const publication = buildWorkbookRubricPublication({
        attemptId, paperId, assessmentId: selected.assessmentId, generation, question: selected.question, request, result, assessedAt: new Date().toISOString(),
        priorId: prior?.id, stableId, route: { providerBaseUrl: settings.baseUrl, requestedModel: settings.model, providerProtocol: settings.protocol, providerId: settings.activeProviderId },
      });
      await locked(async tx => {
        if ((await revalidateManifest(tx, selected.manifest)).kind !== 'valid') throw new RequestError(409, '本次批改依据已经变化。');
        if ((await allAssessments(tx, paperId, selected.assessmentId)).get(attemptId)?.[0]?.id !== prior?.id) return;
        await tx.withLearnerWrite(async tick => { await storeSettledValue(tx, tick, { ...publication, manifest: selected.manifest }, hooks); });
      });
      return get(paperId);
    },
  };
}
