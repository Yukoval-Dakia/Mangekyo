import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { notionReadScope } from './notion.ts';
import { assertDeletionWatermark, assertUnburned, LifecycleError } from '../../kernel/src/lifecycle.ts';
import { submittedWatermark } from './deletion-watermark.ts';
import { projectWorkbookReview, readWorkbookAttempts, readWorkbookSummaries, type ReviewEntry } from '../../modules/activity/workbook-views.ts';
import { historicalWorkbookMount, openWorkbookContext, type WorkbookContextAuthority } from './workbook-context.ts';
import { posttestIssuanceType } from '../../modules/activity/retention-posttest.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, derivationId, factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import { isJson } from '../../kernel/src/declarations/define.ts';
import type { Json, JsonObject } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { runEffect } from '../../kernel/src/work/index.ts';
import { assessWithAgent } from '../../executors/teaching/assessment-agent.ts';
import {
  TeachingError,
  type TeachingDependencies,
} from '../../executors/teaching/index.ts';
import {
  materialType,
  storagePurpose,
  textMaterial,
} from '../../modules/activity/library-values.ts';
import {
  gradeWorkbook, independentlyAuthoredPaper,
  saveWorkbookPaperCommand,
  submitWorkbookAttemptCommand,
  workbookAttempt,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookBankReference,
  workbookAssessmentRequest,
  workbookAssessmentResult,
  workbookDraft,
  WorkbookSourceMismatch,
  workbookPaper,
  workbookPaperType,
  workbookQuestionsView,
  workbookRequestId,
  workbookRubricAssessmentType,
  workbookRubricAssessmentVersion,
  sameWorkbookJson,
  type WorkbookAttempt,
  type WorkbookAttemptRequest,
  type WorkbookAttemptView,
  type WorkbookDetail,
  type WorkbookDraft,
  type WorkbookPaper,
  type WorkbookSourceView,
  type WorkbookSummary,
} from '../../modules/activity/workbook-values.ts';
import { authorizeWorkbookPresentation, recordWorkbookPresentationCommand, workbookPresentation, WorkbookPresentationError } from '../../modules/activity/workbook-presentation.ts';
import { includesBankReferences, readFrozenWorkbookBank } from '../../modules/activity/workbook-bank.ts';
import { completedLegacyRubric, legacyRubricInput, rubricAssessmentIdentity, sameWorkbookDraft, workbookAttemptView } from '../../modules/activity/workbook-assessment-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { routeMatchesInput, sameActiveProvider } from './harness.ts';
import { loadSettings } from './settings.ts';
import { allAssessments } from './learning-attempt-read.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import {
  frozenSubmission, openWorkbookAssessment, prepareWorkbookRelease, readWorkbookAssessment,
} from './workbook-assessment.ts';

class UncertainRubricEffect extends Error {}

function invalid(error: unknown, message: string): never {
  if (error instanceof RequestError) throw error;
  throw new RequestError(400, error instanceof Error ? error.message : message);
}

function factIdOf(value: unknown, message: string): FactId {
  try {
    if (typeof value !== 'string') throw new Error();
    return factId(value);
  } catch {
    throw new RequestError(404, message);
  }
}

async function factType(tx: ReadTransaction, id: FactId): Promise<string | null> {
  const result = await tx.query<{ type: string }>(
    'SELECT type FROM facts WHERE learner_id=$1 AND id=$2',
    [tx.learner, id],
  );
  return result.rows[0]?.type ?? null;
}

function mapReadFailure(error: unknown, missing: string, denied: string): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof FactNotFoundError) throw new RequestError(404, missing);
  if (error instanceof FactReadDeniedError || error instanceof WorkbookSourceMismatch) throw new RequestError(403, denied);
  throw error;
}

async function readPaperSnapshot(tx: ReadTransaction, id: FactId) {
  if (await factType(tx, id) !== workbookPaperType) {
    throw new RequestError(404, '找不到这份试卷。');
  }
  try {
    const read = createCommandReadContext(tx, storagePurpose);
    const fact = await read.fact(id, { mode: 'following' });
    const paper = workbookPaper(fact.value);
    await readFrozenWorkbookBank(read, paper);
    return { paper, revision: fact.ref.rev, epoch: fact.accessEpoch };
  } catch (error) {
    mapReadFailure(error, '找不到这份试卷。', '这份试卷当前不可读取。');
  }
}

async function readPaper(tx: ReadTransaction, id: FactId) {
  return (await readPaperSnapshot(tx, id)).paper;
}

async function readPaperOrNull(tx: ReadTransaction, id: FactId): Promise<WorkbookPaper | null> {
  if (await factType(tx, id) !== workbookPaperType) return null;
  return readPaper(tx, id);
}

async function readAttemptOrNull(tx: ReadTransaction, id: FactId): Promise<WorkbookAttempt | null> {
  if (await factType(tx, id) !== workbookAttemptType) return null;
  try {
    const fact = await createCommandReadContext(tx, storagePurpose)
      .fact(factId(id), { mode: 'following' });
    return workbookAttempt(fact.value);
  } catch (error) {
    mapReadFailure(error, '找不到这次作答。', '这次作答当前不可读取。');
  }
}

async function sourceView(read: ReturnType<typeof createCommandReadContext>, id: string): Promise<WorkbookSourceView> {
  const fact = await readable(() => read.fact(factId(id), { mode: 'following' }));
  return fact?.type === materialType ? { id, title: textMaterial(fact.value).title, available: true }
    : { id, title: null, available: false };
}

const factUnavailable = (error: unknown) => error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
const workbookUnavailable = (error: unknown) => factUnavailable(error) ||
  (error instanceof RequestError && (error.status === 403 || error.status === 404));
const allAttempts = (tx: ReadTransaction, read: ReturnType<typeof createCommandReadContext>) =>
  readWorkbookAttempts(tx, read, factUnavailable);

async function requireSource(db: Db, id: string): Promise<void> {
  const exists = await db.snapshot({learner:studioLearner}, async tx =>
    (await sourceView(createCommandReadContext(tx,storagePurpose),id)).available);
  if (!exists) throw new RequestError(400, '来源材料不存在或当前不可读取。');
}

type FormalAssessmentView = Awaited<ReturnType<typeof readWorkbookAssessment>>;
type WorkbookDetailWithAssessment = WorkbookDetail & {
  assessmentReleaseRef?: FormalAssessmentView['releaseRef'];
  attempts: (WorkbookAttemptView & { rev: number; formalAssessment?: FormalAssessmentView; paperRev?: number;
    questions: Awaited<ReturnType<ReturnType<typeof openWorkbookContext>['questions']>> })[];
};

export function openWorkbook(db: Db, activity: LoadedModule, {
  assessment = openWorkbookAssessment(db),
  onResearchFactsChanged, context = {},
}: {
  context?: WorkbookContextAuthority;
  assessment?: ReturnType<typeof openWorkbookAssessment>;
  onResearchFactsChanged?: CommandHooks['onFactsChanged'];
} = {}) {
  const hooks = createStudioCommandHooks({
    async afterFactsChanged(tx, tick, changes) {
      await assessment.afterFactsChanged(tx, tick, changes);
      await onResearchFactsChanged?.(tx, tick, changes);
    },
  });
  const commands = { modules: [activity], hooks };
  const handle = createCommandHandler(db, commands);

  function inTransaction(tx: DbTransaction) {
    return { ...db, query: tx.query, tx: async <Result>(scope: { learner: typeof tx.learner },
      run: (tx: DbTransaction) => Promise<Result>) => {
      if (scope.learner !== tx.learner) throw new Error('试卷事务的学习者不匹配。');
      return run(tx);
    } };
  }

  async function saveBank(tx: DbTransaction, input: unknown) {
    if (!isJson(input) || input === null || Array.isArray(input) || typeof input !== 'object')
      throw new RequestError(400, '题库组卷格式无效。');
    const { requestId, title, questions, materialId, assessmentRelease } = input as JsonObject;
    if (assessmentRelease !== undefined) throw new RequestError(400, '题库题项的评估契约由服务器冻结。');
    let request: string;
    try { request = workbookRequestId(requestId); }
    catch (error) { invalid(error, '题库请求标识无效。'); }
    const paperId = factId(stableId('workbook-paper', request));
    const key = commandId(stableId('save-workbook-paper', paperId));
    const deletionWatermark = submittedWatermark(input);
    await assertUnburned(tx, 'fact', [paperId, ...(typeof materialId === 'string' ? [materialId] : [])]);
    const recorded = await readRecordedCommand(tx, key);
    const previous = (recorded?.input as { input?: { savedAt?: string } } | undefined)?.input;
    const bankDraft = { title, questions, materialId: materialId ?? null };
    if (!isJson(bankDraft)) throw new RequestError(400, '题库组卷格式无效。');
    const bound = createCommandHandler(inTransaction(tx),
      { ...commands, bindCommandRead: (inner, _, base) => ({ ...base, slot: readCurrentQuestionVerification(inner) }) });
    try {
      if (Array.isArray(questions)) await assertUnburned(tx, 'fact', questions.flatMap(question => {
        const ref = workbookBankReference(question);
        return ref ? [ref.id] : [];
      }));
      const receipt = await bound({ learner: tx.learner, actor: 'learner', purpose: storagePurpose,
        id: key, type: saveWorkbookPaperCommand, deletionWatermark,
        input: { id: paperId, bankDraft, savedAt: previous?.savedAt ?? new Date().toISOString() } });
      if (receipt.state !== 'done' || !receipt.wrote.some(ref => ref.id === paperId))
        throw new RequestError(409, '试卷发放未完成。');
      await readPaper(tx, paperId);
      return { id: paperId };
    } catch (error) {
      if (error instanceof LifecycleError) throw error;
      if (error instanceof WorkbookSourceMismatch ||
          (error instanceof Error && error.message === 'Command ID already used with a different command identity'))
        throw new RequestError(409, '题版、来源、独立核验或请求标识已变化。');
      invalid(error, '试卷格式无效。');
    }
  }

  const capsules = openWorkbookContext(db, activity, hooks, context);

  async function get(id: string): Promise<WorkbookDetailWithAssessment> {
    const paperId = factIdOf(id, '找不到这份试卷。');
    return notionReadScope(db,studioLearner).read(async (tx,check) => {
      if (await factType(tx,paperId) === posttestIssuanceType) {
        try { return await capsules.issued(tx,paperId,check); }
        catch (error) { mapReadFailure(error,'找不到已发放的后测。','后测当前不可读取。'); }
      }
      const { paper, revision, epoch } = await readPaperSnapshot(tx, paperId);
      const read = createCommandReadContext(tx, storagePurpose);
      const source = paper.materialId === null
        ? null
        : await sourceView(read, paper.materialId);
      const assessments = await allAssessments(tx, paperId);
      const attempts: WorkbookDetailWithAssessment['attempts'] = [];
      for (const { id: attemptId, rev, attempt, fact } of await allAttempts(tx, read)) {
        if (attempt.paperId !== paperId) continue;
        try { await readFrozenWorkbookBank(read, attempt.paper); }
        catch (error) {
          if (factUnavailable(error) || error instanceof WorkbookSourceMismatch) continue;
          throw error;
        }
        const mount = await historicalWorkbookMount(tx,paperId,fact,read);
        const questions = mount ? await capsules.questions(tx,attempt.paper,mount,check) : [];
        const release = attempt.paper.assessmentRelease;
        const formal = release && await readWorkbookAssessment(tx, release, { id: attemptId, rev });
        const view = workbookAttemptView(attemptId, attempt, assessments.get(attemptId) ?? [],
          formal && 'result' in formal ? formal.result : undefined);
        attempts.push({ ...view, rev, questions, ...(mount ? {paperRev:mount.paper.rev} : {}), ...(formal ? { formalAssessment: formal } : {}) });
      }
      return {
        id: paperId,
        revision,
        title: paper.title,
        savedAt: paper.savedAt,
        source,
        questions: await capsules.questions(tx,paper,{paper:{id:paperId,rev:revision},epoch},check),
        ...(paper.assessmentRelease ? { assessmentReleaseRef: paper.assessmentRelease.releaseRef } : {}),
        attempts,
      };
    });
  }

  return {
    issueBank: (tx: DbTransaction, input: { requestId: string; questionRefs: readonly { id: FactId; rev: Revision }[]; deletionWatermark?: string }) =>
      saveBank(tx, { requestId: input.requestId, title: '题库练习', deletionWatermark: input.deletionWatermark ?? '0',
        questions: input.questionRefs.map(sourceQuestionRef => ({ sourceQuestionRef })) } satisfies Json),
    async list(): Promise<WorkbookSummary[]> {
      return db.snapshot({learner:studioLearner}, async tx => {
        const read = createCommandReadContext(tx,storagePurpose);
        return readWorkbookSummaries(tx,await allAttempts(tx,read),id => readPaper(tx,id),
          id => sourceView(read,id),workbookUnavailable);
      });
    },

    get,
    readingContext: (id: string, input: Record<string,unknown>) => capsules.event(factIdOf(id,'找不到这份试卷。'),input),
    async sheet(id: string) {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const { paper, revision } = await readPaperSnapshot(tx, factIdOf(id, '找不到这份试卷。'));
        return { revision, title: paper.title, questions: workbookQuestionsView(paper) };
      });
    },
    async recordPresentation(id: string, input: unknown) {
      try {
        const data = workbookPresentation(input);
        if (data.paper.id !== id || 'issuanceId' in data) throw new WorkbookPresentationError('呈现卷面不匹配。');
        const key = commandId(stableId(recordWorkbookPresentationCommand, JSON.stringify(data)));
        await db.tx({ learner: studioLearner }, async tx => {
          await lockLearner(tx, tx.learner);
          await authorizeWorkbookPresentation(createCommandReadContext(tx, storagePurpose), data);
          await createCommandHandler(inTransaction(tx), commands)({
            learner: tx.learner, actor: 'learner', purpose: storagePurpose,
            id: key, type: recordWorkbookPresentationCommand, input: { id: key, data },
          });
        });
        if (data.phase === 'permit') return { permit: key };
      } catch (error) {
        if (error instanceof WorkbookPresentationError) throw new RequestError(400, error.message);
        mapReadFailure(error, '找不到呈现的试卷。', '这份试卷当前不可读取。');
      }
      return { recorded: true };
    },
    async review(): Promise<ReviewEntry[]> {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const read = createCommandReadContext(tx, storagePurpose);
        const attempts = await allAttempts(tx,read);
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
        const { id } = await db.tx({ learner: studioLearner }, async tx => {
          await lockLearner(tx, tx.learner);
          return saveBank(tx, input);
        });
        return get(id);
      }
      let draft: WorkbookDraft & Pick<WorkbookPaper, 'assessmentRelease'>;
      let paperId: FactId;
      try {
        const row = input as { requestId?: unknown; assessmentRelease?: unknown } | null;
        const request = workbookRequestId(row?.requestId);
        paperId = factId(stableId('workbook-paper', request));
        draft = workbookDraft(input);
        if (row?.assessmentRelease !== undefined) draft.assessmentRelease = prepareWorkbookRelease(row.assessmentRelease, paperId, draft);
      } catch (error) {
        invalid(error, '试卷格式无效。');
      }
      const existing = await db.snapshot({ learner: studioLearner }, async (tx) =>
        readPaperOrNull(tx, paperId),
      );
      if (existing) {
        if (!sameWorkbookDraft(existing, draft)) {
          throw new RequestError(409, '同一个请求标识已经用于不同的试卷。');
        }
        return get(paperId);
      }
      if (draft.materialId !== null) await requireSource(db, draft.materialId);
      const data: WorkbookPaper = {
        ...draft,
        savedAt: new Date().toISOString(),
      };
      try {
        await handle({
          learner: studioLearner,
          actor: 'learner',
          purpose: storagePurpose,
          type: saveWorkbookPaperCommand,
          id: commandId(stableId('save-workbook-paper', paperId)),
          input: { id: paperId, data },
        });
      } catch (error) {
        if (error instanceof WorkbookSourceMismatch) throw new RequestError(409, error.message);
        if (error instanceof FactNotFoundError) throw new RequestError(409, '找不到引用的来源版本。');
        if (error instanceof FactReadDeniedError) {
          throw new RequestError(409, '来源材料已撤回，不能保存这份试卷。');
        }
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          const saved = await db.snapshot({learner: studioLearner}, tx => readPaperOrNull(tx, paperId));
          if (saved && sameWorkbookDraft(saved, draft)) return get(paperId);
          throw new RequestError(409, '同一个请求标识已经用于不同的试卷。');
        }
        throw error;
      }
      return get(paperId);
    },

    async submit(id: string, input: unknown): Promise<WorkbookDetailWithAssessment> {
      const paperId = factIdOf(id, '找不到这份试卷。');
      const now = new Date().toISOString();
      let data: WorkbookAttemptRequest;
      try {
        const row = input as {
          requestId?: unknown; answers?: unknown; assessmentConsent?: unknown; effectiveDurationMs?: unknown;
        } | null;
        data = workbookAttemptRequest({
          paperId,
          requestId: row?.requestId,
          submittedAt: now,
          answers: row?.answers,
          assessmentConsent: row?.assessmentConsent,
          effectiveDurationMs: row?.effectiveDurationMs,
        });
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
      const attemptId = factId(stableId('workbook-attempt', paperId, data.requestId));
      const deletionWatermark = submittedWatermark(input);
      const priorAttempt = () => db.snapshot({ learner:studioLearner }, async tx => {
        await assertUnburned(tx, 'fact', [attemptId,paperId]);
        await assertDeletionWatermark(tx,deletionWatermark);
        return { existing: await readAttemptOrNull(tx, attemptId), current: await readPaper(tx, paperId) };
      });
      const { existing, current } = await priorAttempt();
      const paper = existing?.paper ?? current;
      let graded: ReturnType<typeof gradeWorkbook>;
      try {
        graded = gradeWorkbook(paper, data.answers);
        if (paper.assessmentRelease) frozenSubmission(paper.assessmentRelease, { id: attemptId, rev: 1 as Revision }, graded.answers);
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
      // The first accepted submission fixes timing alongside its original submission timestamp.
      const isReplay = (attempt: WorkbookAttempt) => attempt.paperId === paperId &&
        sameWorkbookJson(attempt.answers, graded.answers) && attempt.assessmentConsent === data.assessmentConsent;
      if (existing) {
        if (!isReplay(existing)) {
          throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
        }
        return get(paperId);
      }
      try {
        await handle({
          learner: studioLearner,
          actor: 'learner',
          purpose: storagePurpose,
          type: submitWorkbookAttemptCommand, deletionWatermark,
          id: commandId(stableId('submit-workbook-attempt', attemptId)),
          input: {
            id: attemptId,
            data,
          },
        });
      } catch (error) {
        if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError || error instanceof WorkbookSourceMismatch) {
          throw new RequestError(403, '这份试卷当前不可读取。');
        }
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          const { existing: saved } = await priorAttempt();
          if (saved && isReplay(saved)) return get(paperId);
          throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
        }
        throw error;
      }
      return get(paperId);
    },

    async assess(
      paperValue: string,
      attemptValue: string,
      input: unknown,
    ): Promise<WorkbookDetailWithAssessment> {
      const paperId = factIdOf(paperValue, '找不到这份试卷。');
      const attemptId = factIdOf(attemptValue, '找不到这次作答。');
      let request;
      try {
        request = workbookAssessmentRequest(input);
      } catch (error) {
        invalid(error, '评分标准批改请求无效。');
      }
      const selected = await db.snapshot({ learner: studioLearner }, async (tx) => {
        const paper = await readPaper(tx, paperId);
        const attempt = await readAttemptOrNull(tx, attemptId);
        if (!attempt || attempt.paperId !== paperId) {
          throw new RequestError(404, '找不到这次作答。');
        }
        const input = legacyRubricInput(attempt, request.questionId);
        if (input.state !== 'ready') throw new RequestError(input.status, input.reason);
        const { question, answer } = input;
        const id = factId(stableId(...rubricAssessmentIdentity(attemptId, question)));
        const reads = createCommandReadContext(tx, storagePurpose);
        const inputs = [];
        for (const source of [paperId, attemptId]) {
          const record = await reads.fact(source, {mode: 'following'});
          inputs.push({kind: 'fact', id: source, rev: record.ref.rev, accessEpoch: record.accessEpoch, mode: 'following'});
        }
        const {rows} = await tx.query<{tick: string}>('SELECT clock::text AS tick FROM learners WHERE id=$1', [tx.learner]);
        const manifest = parseManifest({version: 1, learner: tx.learner, purpose: storagePurpose, gatherTick: rows[0]?.tick, inputs});
        return {
          question,
          answer,
          assessmentId: id,
          independent: independentlyAuthoredPaper(paper) && independentlyAuthoredPaper(attempt.paper),
          manifest, existing: (await allAssessments(tx, paperId, id)).get(attemptId)?.[0],
        };
      });
      const settings = await loadSettings('assessment');
      if (request.publicSearchQuery && !settings.allowSearch) throw new RequestError(400, '请在设置中启用公开检索。');
      if (request.providerBaseUrl !== settings.baseUrl || !routeMatchesInput((input as Record<string, unknown>).route, settings)) {
        throw new RequestError(409, '模型端点已经变化，请重新确认本次批改。');
      }
      const prior = selected.existing;
      if (prior && (prior.verdict !== 'pending' || prior.requestId === request.requestId)) return get(paperId);
      const generation = prior?.id ?? stableId('rubric-input', JSON.stringify(selected.manifest.inputs), request.providerBaseUrl, request.publicSearchQuery ?? '');

      const runAssessmentEffect: TeachingDependencies['runEffect'] = async (step, invoke) => {
        const effect = await runEffect(
          db,
          {
            learner: studioLearner,
            ownerKind: 'session',
            ownerId: attemptId,
            stepKey: 'rubric:' + selected.question.id + ':' + generation + ':' + step.index,
            label: 'workbook-rubric',
            input: {
              assessmentVersion: workbookRubricAssessmentVersion,
              attemptId,
              paperId,
              questionId: selected.question.id,
              rubricVersion: selected.question.rubricVersion,
              consent: request.consent,
              provider: settings.baseUrl,
              model: step.model,
              requestDigest: step.requestDigest,
            },
          },
          providerEffectId => invoke(providerEffectId),
          async tx => {
            const current = await loadSettings('assessment');
            if (!sameActiveProvider(settings, current) || current.apiKey !== settings.apiKey) throw new RequestError(409, '模型配置已变化，请重新确认批改。');
            if (step.provider === 'tool:exa_search' && (!current.allowSearch || current.exaApiKey !== settings.exaApiKey)) throw new RequestError(409, '公开检索授权已撤回。');
            if ((await revalidateManifest(tx, selected.manifest)).kind !== 'valid') throw new RequestError(409, '批改依据已经变化。');
          },
          selected.independent && !request.publicSearchQuery ? { manifest: selected.manifest } : undefined,
        );
        if (effect.kind === 'unknown') {
          throw new UncertainRubricEffect(
            '提供方的批改结果待核对，本次没有重复发送。' +
              (effect.providerEffectId ? '请求标识 ' + effect.providerEffectId : ''),
          );
        }
        if (typeof effect.result !== 'string') throw new Error('提供方返回的批改结果无效。');
        return effect.result;
      };

      let result;
      try {
        const raw = await assessWithAgent(
          {
            question: selected.question.prompt,
            answer: selected.answer,
            rubric: selected.question.rubric,
          },
          {
            provider: settings,
            runEffect: runAssessmentEffect,
            allowSearch: settings.allowSearch, exaApiKey: settings.exaApiKey,
            ...(request.publicSearchQuery ? {publicSearchQuery: request.publicSearchQuery} : {}),
          },
        );
        result = workbookAssessmentResult(raw);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        if (error instanceof UncertainRubricEffect) {
          throw new RequestError(409, error.message);
        }
        if (error instanceof TeachingError) {
          result = {verdict: 'pending' as const, feedback: error.message, evidence: [], trace: []};
        } else {
          throw new RequestError(502, '批改未完成，原作答已保留。');
        }
      }

      const data = completedLegacyRubric({
        attemptId, paperId, question: selected.question, request, result, assessedAt: new Date().toISOString(),
        route: { providerBaseUrl: settings.baseUrl, requestedModel: settings.model,
          providerProtocol: settings.protocol, providerId: settings.activeProviderId },
      });
      await db.tx({learner: studioLearner}, async tx => {
        await lockLearner(tx, tx.learner);
        if ((await revalidateManifest(tx, selected.manifest)).kind !== 'valid') throw new RequestError(409, '本次批改依据已经变化。');
        const latest = (await allAssessments(tx, paperId, selected.assessmentId)).get(attemptId)?.[0];
        if (latest?.id !== prior?.id) return;
        await tx.withLearnerWrite(async tick => {
          const id = derivationId(stableId('rubric-result', selected.assessmentId, generation, request.requestId));
          if (prior) await tx.query("UPDATE derivations SET lifecycle='superseded',selection_ended_tick=$3 WHERE learner_id=$1 AND id=$2", [tx.learner,prior.id,tick]);
          await tx.insert('derivations', {
            learner_id: tx.learner, id, slot_type: workbookRubricAssessmentType, slot_key: selected.assessmentId,
            deriver: workbookRubricAssessmentVersion, scope_keys: JSON.stringify({paperId,attemptId}),
            value: JSON.stringify(data), lifecycle: 'effective', freshness: 'current', is_shadow: false,
            gather_tick: selected.manifest.gatherTick, effective_tick: tick, manifest: JSON.stringify(selected.manifest),
          });
          await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,current_id,last_id,changed_tick,scope_keys)
            VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT (learner_id,slot_type,slot_key)
            DO UPDATE SET current_id=EXCLUDED.current_id,last_id=EXCLUDED.last_id,changed_tick=EXCLUDED.changed_tick`,
            [tx.learner,workbookRubricAssessmentType,selected.assessmentId,id,tick,JSON.stringify({paperId,attemptId})]);
          await hooks.onSlotChanged(tx, tick, {
            kind: 'effective',
            slot: { learner: tx.learner, type: workbookRubricAssessmentType, key: selected.assessmentId },
            id,
            previousCurrent: prior ? derivationId(prior.id) : null,
            freshness: 'current',
          });
        });
      });
      return get(paperId);
    },
  };
}
