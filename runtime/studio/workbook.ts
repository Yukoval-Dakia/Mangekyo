import { storeSettledValue } from '../../kernel/src/derivations/settled-value.ts';
import { readFactType as factType } from '../../kernel/src/commands/fact-collection.ts';
import { assertDeletionWatermark, assertUnburned, deletionWatermark as readDeletionWatermark, LifecycleError } from '../../kernel/src/lifecycle.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { projectWorkbookReview, readWorkbookAttempts, readWorkbookSummaries, type ReviewEntry } from '../../modules/activity/workbook-views.ts';
import { historicalWorkbookMount, openWorkbookContext, type WorkbookContextAuthority, type WorkbookQuestionWithContext } from './workbook-context.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import { newUlid } from '../../kernel/src/work/identity.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { runEffect } from '../../kernel/src/work/index.ts';
import { assessWithAgent } from '../../executors/teaching/assessment-agent.ts';
import {
  TeachingError,
  type TeachingDependencies,
} from '../../executors/teaching/index.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { workbookPaperType, workbookQuestionsView, type WorkbookAttemptView, type WorkbookDetail, type WorkbookPaper, type WorkbookSummary } from '../../modules/activity/workbook-values.ts';
import { recordWorkbookPresentationCommand } from '../../modules/activity/workbook-presentation.ts';
import { includesBankReferences } from '../../modules/activity/workbook-bank.ts';
import { recordWorkbookCorrection } from '../../modules/activity/workbook-correction.ts';
import { captureSourceCommand } from '../../modules/capture/source.ts';
import {
  buildWorkbookRubricEffectInput, buildWorkbookRubricPublication, classifyWorkbookRubricError, hasWorkbookOnceAttachmentReuse,
  listWorkbookCorrectionIds, listWorkbookPaperIds, loadWorkbookDetail, mapWorkbookReadFailure,
  parseWorkbookAssessmentParams, prepareWorkbookSubmit, readWorkbookAttemptOrNull,
  readWorkbookPaperSnapshot, readWorkbookSourceView, resolveWorkbookRubricResult,
  runWorkbookAttachmentUpload, runWorkbookBankSave, runWorkbookCorrection, runWorkbookPresentation, runWorkbookSavePaper,
  runWorkbookSubmitTransaction, selectWorkbookRubricAssessment, unwrapWorkbookRubricEffect,
  validateWorkbookRubricPreSend, validateWorkbookRubricRoute, workbookFactIdOf,
  type WorkbookErrorChecks,
} from '../../modules/activity/workbook-operations.ts';
import { digest, openIntakeObjects } from './intake-objects.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { isPracticeWorkbook, sealedPracticePaper, submitWithPracticeCustody } from './sealed-practice.ts';
import { RequestError } from './sessions.ts';
import { routeMatchesInput, sameActiveProvider } from './harness.ts';
import { loadSettings } from './settings.ts';
import { allAssessments } from './learning-attempt-read.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import {
  frozenSubmission, openWorkbookAssessment, prepareWorkbookRelease, readWorkbookAssessment,
} from './workbook-assessment.ts';

const checks: WorkbookErrorChecks = {
  fail: (status, message) => { throw new RequestError(status, message); },
  isRequestError: error => error instanceof RequestError,
  isReadDenied: error => error instanceof FactReadDeniedError,
  isLifecycleError: error => error instanceof LifecycleError,
};
const factIdOf = (value: unknown, message: string) => workbookFactIdOf(value, message, checks.fail);
const factUnavailable = (error: unknown) => error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
const workbookUnavailable = (error: unknown) => factUnavailable(error) ||
  (error instanceof RequestError && (error.status === 403 || error.status === 404));
const sourceView = (read: ReturnType<typeof createCommandReadContext>, id: string) =>
  readWorkbookSourceView(read, id, factUnavailable);
const readPaperSnapshot = (tx: ReadTransaction, id: FactId) => readWorkbookPaperSnapshot({
  id, factType: target => factType(tx, target), assertUnburnedFact: ids => assertUnburned(tx, 'fact', ids),
  sealedPracticePaper: target => sealedPracticePaper(tx, target), read: () => createCommandReadContext(tx, storagePurpose), checks,
});
const readPaper = async (tx: ReadTransaction, id: FactId) => (await readPaperSnapshot(tx, id)).paper;
const readPaperOrNull = async (tx: ReadTransaction, id: FactId): Promise<WorkbookPaper | null> =>
  await factType(tx, id) === workbookPaperType ? readPaper(tx, id) : null;
const readAttemptOrNull = (tx: ReadTransaction, id: FactId) => readWorkbookAttemptOrNull({
  id, factType: target => factType(tx, target), read: () => createCommandReadContext(tx, storagePurpose), checks,
});
const readAttempts = (tx: ReadTransaction, read: ReturnType<typeof createCommandReadContext>, paperId?: FactId) =>
  readWorkbookAttempts(tx, read, factUnavailable, paperId);

type FormalAssessmentView = Awaited<ReturnType<typeof readWorkbookAssessment>>;
type WorkbookDetailWithAssessment = WorkbookDetail & {
  assessmentReleaseRef?: FormalAssessmentView['releaseRef'];
  attempts: (WorkbookAttemptView & { rev: number; formalAssessment?: FormalAssessmentView; paperRev?: number;
    questions: WorkbookQuestionWithContext[] })[];
};

export function openWorkbook(db: Db, activity: LoadedModule, {
  capture, assessment = openWorkbookAssessment(db), onResearchFactsChanged, context = {},
}: {
  capture?: LoadedModule; context?: WorkbookContextAuthority;
  assessment?: ReturnType<typeof openWorkbookAssessment>;
  onResearchFactsChanged?: CommandHooks['onFactsChanged'];
} = {}) {
  const objects = openIntakeObjects(db);
  const hooks = createStudioCommandHooks({
    async afterFactsChanged(tx, tick, changes) {
      await assessment.afterFactsChanged(tx, tick, changes);
      await onResearchFactsChanged?.(tx, tick, changes);
    },
  });
  const commands = { modules: [activity], hooks };
  const handle = createCommandHandler(db, commands);
  const locked = <T>(run: (tx: DbTransaction) => Promise<T>) => db.tx({ learner: studioLearner }, async tx => {
    await lockLearner(tx, tx.learner);
    return run(tx);
  });

  const saveBank = (tx: DbTransaction, input: unknown) => {
    const bound = createCommandHandler(withinLearnerTransaction(db, tx),
      { ...commands, bindCommandRead: (inner, _, base) => ({ ...base, slot: readCurrentQuestionVerification(inner) }) });
    return runWorkbookBankSave({
      input, deletionWatermark: submittedWatermark(input), now: new Date().toISOString(), stableId, checks,
      assertUnburnedFact: ids => assertUnburned(tx, 'fact', ids),
      readRecordedCommand: id => readRecordedCommand(tx, id),
      saveCommand: request => bound({ learner: tx.learner, actor: 'learner', purpose: storagePurpose, ...request }),
      readPaper: id => readPaper(tx, id),
    });
  };

  const capsules = openWorkbookContext(db, activity, hooks, context);
  async function formalAssessment(tx: ReadTransaction, paper: WorkbookPaper, ref: {id: FactId; rev: Revision}) {
    if (!paper.assessmentRelease) return;
    const view = await readWorkbookAssessment(tx, paper.assessmentRelease, ref);
    return {view, result: 'result' in view ? view.result : undefined};
  }

  async function get(id: string): Promise<WorkbookDetailWithAssessment> {
    const paperId = factIdOf(id, '找不到这份试卷。');
    return db.snapshot({learner:studioLearner},async tx => {
      if (await factType(tx,paperId) === posttestIssuanceType) {
        try { return await capsules.issued(tx,paperId); }
        catch (error) { mapWorkbookReadFailure(error,'找不到已发放的后测。','后测当前不可读取。',checks); }
      }
      const snapshot = await readPaperSnapshot(tx, paperId);
      const read = createCommandReadContext(tx, storagePurpose);
      return loadWorkbookDetail({
        paperId, snapshot, sealedPractice: await isPracticeWorkbook(tx, paperId), read, unavailable: factUnavailable,
        sourceView: materialId => sourceView(read, materialId),
        assessments: await allAssessments(tx, paperId),
        attempts: await readAttempts(tx, read, paperId),
        correctionIds: () => listWorkbookCorrectionIds(tx, paperId),
        historicalMount: fact => historicalWorkbookMount(tx, paperId, fact, read),
        projectQuestions: capsules.questions(tx),
        formalAssessment: (frozen, ref) => formalAssessment(tx, frozen, ref),
      });
    });
  }

  return {
    async correct(paperId: string, attemptId: string, input: Record<string, unknown>, deletionWatermark: string) {
      let activeTx!: DbTransaction;
      return runWorkbookCorrection({
        paperId, attemptId, input, deletionWatermark, stableId, unavailable: factUnavailable, checks,
        locked: run => locked(async tx => { activeTx = tx; return run(); }),
        assertDeletionWatermark: wm => assertDeletionWatermark(activeTx, wm),
        read: () => createCommandReadContext(activeTx, storagePurpose),
        hasHistoricalMount: async (pid, original, read) => Boolean(await historicalWorkbookMount(activeTx, pid, original, read)),
        formalResult: async (paper, ref) => (await formalAssessment(activeTx, paper, ref))?.result,
        gradesForAttempt: async (pid, aid) => (await allAssessments(activeTx, pid)).get(aid) ?? [],
        correctionIds: (pid, aid) => listWorkbookCorrectionIds(activeTx, pid, aid),
        recordCorrection: (id, data) => createCommandHandler(withinLearnerTransaction(db, activeTx), commands)({
          learner: activeTx.learner, actor: 'learner', purpose: storagePurpose, deletionWatermark,
          id: commandId(id), type: recordWorkbookCorrection, input: { id, data },
        }),
      });
    },
    issueBank: (tx: DbTransaction, input: { requestId: string; questionRefs: readonly { id: FactId; rev: Revision }[]; deletionWatermark?: string }) =>
      saveBank(tx, { requestId: input.requestId, title: '题库练习', deletionWatermark: input.deletionWatermark ?? '0',
        questions: input.questionRefs.map(sourceQuestionRef => ({ sourceQuestionRef })) } satisfies Json),
    async list(): Promise<WorkbookSummary[]> {
      return db.snapshot({ learner: studioLearner }, async (tx) => {
        const read = createCommandReadContext(tx, storagePurpose);
        return readWorkbookSummaries(await listWorkbookPaperIds(tx), await readAttempts(tx, read), id => readPaper(tx, id),
          id => sourceView(read,id),workbookUnavailable);
      });
    },

    get,
    readingLabels: (id: string, query: URLSearchParams, signal: AbortSignal) => capsules.labels(factIdOf(id,'找不到这份试卷。'),query,signal),
    readingContext: (id: string, input: Record<string,unknown>, signal: AbortSignal) =>
      capsules.event(factIdOf(id,'找不到这份试卷。'),input,signal),
    async sheet(id: string) {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const { paper, revision } = await readPaperSnapshot(tx, factIdOf(id, '找不到这份试卷。'));
        return { revision, title: paper.title, questions: workbookQuestionsView(paper) };
      });
    },
    async recordPresentation(id: string, input: unknown) {
      let activeTx!: DbTransaction;
      return runWorkbookPresentation({
        id, input, stableId, checks,
        locked: run => locked(async tx => { activeTx = tx; await run(); }),
        read: () => createCommandReadContext(activeTx, storagePurpose),
        record: async (key, data) => {
          await createCommandHandler(withinLearnerTransaction(db, activeTx), commands)({
            learner: activeTx.learner, actor: 'learner', purpose: storagePurpose,
            id: key, type: recordWorkbookPresentationCommand, input: { id: key, data },
          });
        },
      });
    },
    async review(): Promise<ReviewEntry[]> {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const read = createCommandReadContext(tx, storagePurpose);
        const attempts = await readAttempts(tx,read);
        return projectWorkbookReview(attempts,await allAssessments(tx), async paperId => {
          try { return Boolean(await readPaperOrNull(tx,factId(paperId))); }
          catch (error) {
            if (workbookUnavailable(error)) return false;
            throw error;
          }
        });
      });
    },

    async save(input: unknown): Promise<WorkbookDetailWithAssessment> {
      if (includesBankReferences(input)) {
        const { id } = await locked(tx => saveBank(tx, input));
        return get(id);
      }
      const paperId = await runWorkbookSavePaper({
        input, now: new Date().toISOString(), stableId, prepareRelease: prepareWorkbookRelease, checks,
        readPaperOrNull: pid => db.snapshot({ learner: studioLearner }, tx => readPaperOrNull(tx, pid)),
        sourceAvailable: mid => db.snapshot({ learner: studioLearner }, async tx =>
          (await sourceView(createCommandReadContext(tx, storagePurpose), mid)).available),
        saveCommand: async request => {
          await handle({ learner: studioLearner, actor: 'learner', purpose: storagePurpose, ...request });
        },
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
        readPaperSnapshot: pid => readPaperSnapshot(activeTx, pid), readRecordedCommand: cid => readRecordedCommand(activeTx, cid), read: () => createCommandReadContext(activeTx, storagePurpose),
        captureSource: req => createCommandHandler(withinLearnerTransaction(db, activeTx), { modules: [capture], hooks: createStudioCommandHooks() })({ learner: studioLearner, actor: 'learner', purpose: storagePurpose, type: captureSourceCommand, ...req }),
      });
    },

    async submit(id: string, input: unknown): Promise<WorkbookDetailWithAssessment> {
      const prepared = prepareWorkbookSubmit(id, input, new Date().toISOString(), stableId, checks);
      const deletionWatermark = submittedWatermark(input);
      await locked(tx => runWorkbookSubmitTransaction({
        prepared, deletionWatermark, checks,
        assertUnburned: (kind, ids) => assertUnburned(tx, kind, ids),
        assertDeletionWatermark: wm => assertDeletionWatermark(tx, wm),
        readPaperSnapshot: pid => readPaperSnapshot(tx, pid),
        isPracticeWorkbook: pid => isPracticeWorkbook(tx, pid),
        readAttemptOrNull: aid => readAttemptOrNull(tx, aid),
        readRecordedCommand: cid => readRecordedCommand(tx, cid),
        read: () => createCommandReadContext(tx, storagePurpose),
        hasOnceAttachmentReuse: (attemptId, onceIds) => hasWorkbookOnceAttachmentReuse(tx, attemptId, onceIds),
        checkFrozenSubmission: frozenSubmission,
        async submitCommand(pending, request) {
          const local = withinLearnerTransaction(db, tx);
          const full = { ...request, learner: studioLearner };
          if (pending) await submitWithPracticeCustody(local, activity, hooks, prepared.paperId, full);
          else await createCommandHandler(local, commands)(full);
        },
      }));
      return get(prepared.paperId);
    },

    async assess(
      paperValue: string,
      attemptValue: string,
      input: unknown,
    ): Promise<WorkbookDetailWithAssessment> {
      const { paperId, attemptId, request } = parseWorkbookAssessmentParams(paperValue, attemptValue, input, checks);
      const selected = await db.snapshot({ learner: studioLearner }, async (tx) => {
        const chosen = await selectWorkbookRubricAssessment({
          paperId, attemptId, questionId: request.questionId, stableId, fail: checks.fail,
          readPaper: pid => readPaper(tx, pid), readAttemptOrNull: aid => readAttemptOrNull(tx, aid),
          read: () => createCommandReadContext(tx, storagePurpose),
          unavailable: factUnavailable,
          allAssessments: (pid, aid) => allAssessments(tx, pid, aid),
        });
        const { rows } = await tx.query<{ tick: string }>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
        const manifest = parseManifest({
          version: 1, learner: tx.learner, purpose: storagePurpose, gatherTick: rows[0]?.tick, inputs: chosen.manifestInputs,
        });
        return { ...chosen, manifest };
      });
      const settings = await loadSettings('assessment');
      validateWorkbookRubricRoute({
        request, inputRoute: (input as Record<string, unknown>).route, settings,
        routeMatches: route => routeMatchesInput(route, settings), fail: checks.fail,
      });
      const prior = selected.existing;
      if (prior && (prior.verdict !== 'pending' || prior.requestId === request.requestId)) return get(paperId);
      const generation = prior?.id ?? stableId('rubric-input', JSON.stringify(selected.manifest.inputs), request.providerBaseUrl, request.publicSearchQuery ?? '');

      const runAssessmentEffect: TeachingDependencies['runEffect'] = async (step, invoke) => {
        const desc = buildWorkbookRubricEffectInput({
          attemptId, paperId, question: selected.question, request, baseUrl: settings.baseUrl, step, generation,
        });
        const effect = await runEffect(db, { learner: studioLearner, ownerKind: 'session', ownerId: attemptId, ...desc },
          providerEffectId => invoke(providerEffectId),
          async tx => {
            const current = await loadSettings('assessment');
            validateWorkbookRubricPreSend({
              sameProvider: sameActiveProvider(settings, current), sameApiKey: current.apiKey === settings.apiKey,
              isSearchStep: step.provider === 'tool:exa_search', allowSearch: current.allowSearch,
              sameExaKey: current.exaApiKey === settings.exaApiKey,
              manifestValid: (await revalidateManifest(tx, selected.manifest)).kind === 'valid', fail: checks.fail,
            });
          },
          selected.independent && !request.publicSearchQuery ? { manifest: selected.manifest } : undefined,
        );
        return unwrapWorkbookRubricEffect(effect);
      };

      let result;
      try {
        const raw = await assessWithAgent(
          { question: selected.question.prompt, answer: selected.answer, rubric: selected.question.rubric },
          { provider: settings, runEffect: runAssessmentEffect, allowSearch: settings.allowSearch, exaApiKey: settings.exaApiKey,
            ...(request.publicSearchQuery ? { publicSearchQuery: request.publicSearchQuery } : {}) },
        );
        result = resolveWorkbookRubricResult(raw);
      } catch (error) {
        result = classifyWorkbookRubricError(error, { ...checks, isTeachingError: err => err instanceof TeachingError });
      }

      const publication = buildWorkbookRubricPublication({
        attemptId, paperId, assessmentId: selected.assessmentId, generation, question: selected.question, request,
        result, assessedAt: new Date().toISOString(), priorId: prior?.id, stableId,
        route: { providerBaseUrl: settings.baseUrl, requestedModel: settings.model, providerProtocol: settings.protocol, providerId: settings.activeProviderId },
      });
      await locked(async tx => {
        if ((await revalidateManifest(tx, selected.manifest)).kind !== 'valid') throw new RequestError(409, '本次批改依据已经变化。');
        const latest = (await allAssessments(tx, paperId, selected.assessmentId)).get(attemptId)?.[0];
        if (latest?.id !== prior?.id) return;
        await tx.withLearnerWrite(async tick => {
          await storeSettledValue(tx, tick, { ...publication, manifest: selected.manifest }, hooks);
        });
      });
      return get(paperId);
    },
  };
}
