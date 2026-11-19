import type { ReviewEntry } from './review.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, derivationId, factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
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
  gradeWorkbook,
  saveWorkbookPaperCommand,
  submitWorkbookAttemptCommand,
  workbookAttempt,
  workbookAttemptRequest,
  workbookAttemptType,
  workbookAssessmentRequest,
  workbookAssessmentResult,
  workbookCorrectCount,
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
  type WorkbookRubricAssessment,
  type WorkbookRubricAssessmentView,
  type WorkbookRubricQuestion,
  type WorkbookSourceView,
  type WorkbookSummary,
} from '../../modules/activity/workbook-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';
import { routeMatchesInput, sameActiveProvider } from './harness.ts';
import { loadSettings } from './settings.ts';
import { allAssessments } from './learning-attempt-read.ts';
import {
  frozenSubmission, openWorkbookAssessment, prepareWorkbookRelease, readWorkbookAssessment,
} from './workbook-assessment.ts';

class UncertainRubricEffect extends Error {}

function assessmentKey(
  attemptId: FactId,
  question: WorkbookRubricQuestion,
): FactId {
  return factId(stableId(
    'workbook-rubric-assessment',
    attemptId,
    question.id,
    question.rubricVersion,
    question.rubric,
  ));
}

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
  if (error instanceof FactReadDeniedError) throw new RequestError(403, denied);
  throw error;
}

async function readPaper(tx: ReadTransaction, id: FactId): Promise<WorkbookPaper> {
  if (await factType(tx, id) !== workbookPaperType) {
    throw new RequestError(404, '找不到这份试卷。');
  }
  try {
    const fact = await createCommandReadContext(tx, storagePurpose)
      .fact(factId(id), { mode: 'following' });
    return workbookPaper(fact.value);
  } catch (error) {
    mapReadFailure(error, '找不到这份试卷。', '这份试卷当前不可读取。');
  }
}

async function readPaperOrNull(tx: ReadTransaction, id: FactId): Promise<WorkbookPaper | null> {
  if (await factType(tx, id) !== workbookPaperType) return null;
  try {
    const fact = await createCommandReadContext(tx, storagePurpose)
      .fact(factId(id), { mode: 'following' });
    return workbookPaper(fact.value);
  } catch (error) {
    mapReadFailure(error, '找不到这份试卷。', '这份试卷当前不可读取。');
  }
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

async function sourceView(
  tx: ReadTransaction,
  read: ReturnType<typeof createCommandReadContext>,
  id: string,
): Promise<WorkbookSourceView> {
  if (await factType(tx, factId(id)) !== materialType) {
    return { id, title: null, available: false };
  }
  try {
    const fact = await read.fact(factId(id), { mode: 'following' });
    return { id, title: textMaterial(fact.value).title, available: true };
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) {
      return { id, title: null, available: false };
    }
    throw error;
  }
}

function attemptView(
  id: string,
  attempt: WorkbookAttempt,
  assessments: WorkbookRubricAssessmentView[],
): WorkbookAttemptView {
  return {
    id,
    requestId: attempt.requestId,
    submittedAt: attempt.submittedAt,
    gradingVersion: attempt.gradingVersion,
    answers: attempt.answers,
    feedback: attempt.feedback.map(item => item.result === 'unanswered' ? {...item, expected: null, explanation: null} : item),
    assessments,
    correctCount: workbookCorrectCount(attempt.feedback),
    total: attempt.paper.questions.filter(
      q => q.kind !== 'rubric' && (q.kind !== 'exact' || !q.selfCheck),
    ).length,
  };
}

async function allAttempts(
  tx: ReadTransaction,
  read: ReturnType<typeof createCommandReadContext>,
): Promise<{ id: FactId; rev: Revision; attempt: WorkbookAttempt }[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookAttemptType],
  );
  const attempts: Awaited<ReturnType<typeof allAttempts>> = [];
  for (const row of rows) {
    try {
      const fact = await read.fact(factId(row.id), { mode: 'following' });
      attempts.push({ id: fact.ref.id, rev: fact.ref.rev, attempt: workbookAttempt(fact.value) });
    } catch (error) {
      if (!(error instanceof FactReadDeniedError) && !(error instanceof FactNotFoundError)) throw error;
    }
  }
  return attempts;
}

async function requireSource(db: Db, id: string): Promise<void> {
  const exists = await db.snapshot({ learner: studioLearner }, async (tx) => {
    if (await factType(tx, factId(id)) !== materialType) return false;
    try {
      const fact = await createCommandReadContext(tx, storagePurpose)
        .fact(factId(id), { mode: 'following' });
      textMaterial(fact.value);
      return true;
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return false;
      throw error;
    }
  });
  if (!exists) throw new RequestError(400, '来源材料不存在或当前不可读取。');
}

function sameDraft(paper: WorkbookPaper, draft: Omit<WorkbookPaper, 'savedAt'>): boolean {
  const { savedAt: _, ...savedDraft } = paper;
  return sameWorkbookJson(savedDraft, draft);
}

type FormalAssessmentView = Awaited<ReturnType<typeof readWorkbookAssessment>>;
type WorkbookDetailWithAssessment = WorkbookDetail & {
  assessmentReleaseRef?: FormalAssessmentView['releaseRef'];
  attempts: (WorkbookAttemptView & { formalAssessment?: FormalAssessmentView })[];
};

export function openWorkbook(db: Db, activity: LoadedModule, {
  assessment = openWorkbookAssessment(db),
  onResearchFactsChanged,
}: {
  assessment?: ReturnType<typeof openWorkbookAssessment>;
  onResearchFactsChanged?: CommandHooks['onFactsChanged'];
} = {}) {
  const hooks = createStudioCommandHooks({
    async afterFactsChanged(tx, tick, changes) {
      await assessment.afterFactsChanged(tx, tick, changes);
      await onResearchFactsChanged?.(tx, tick, changes);
    },
  });
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks,
  });

  async function get(id: string): Promise<WorkbookDetailWithAssessment> {
    const paperId = factIdOf(id, '找不到这份试卷。');
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      const paper = await readPaper(tx, paperId);
      const read = createCommandReadContext(tx, storagePurpose);
      const source = paper.materialId === null
        ? null
        : await sourceView(tx, read, paper.materialId);
      const assessments = await allAssessments(tx, paperId);
      const attempts: WorkbookDetailWithAssessment['attempts'] = [];
      for (const { id: attemptId, rev, attempt } of await allAttempts(tx, read)) {
        if (attempt.paperId !== paperId) continue;
        const view = attemptView(attemptId, attempt, assessments.get(attemptId) ?? []);
        const release = attempt.paper.assessmentRelease;
        attempts.push(release
          ? { ...view, formalAssessment: await readWorkbookAssessment(tx, release, { id: attemptId, rev }) }
          : view);
      }
      return {
        id: paperId,
        title: paper.title,
        savedAt: paper.savedAt,
        source,
        questions: workbookQuestionsView(paper),
        ...(paper.assessmentRelease ? { assessmentReleaseRef: paper.assessmentRelease.releaseRef } : {}),
        attempts,
      };
    });
  }

  return {
    async list(): Promise<WorkbookSummary[]> {
      return db.snapshot({ learner: studioLearner }, async (tx) => {
        const read = createCommandReadContext(tx, storagePurpose);
        const attempts = await allAttempts(tx, read);
        const grouped = new Map<string, { count: number; last: string | null }>();
        for (const { attempt } of attempts) {
          const current = grouped.get(attempt.paperId) ?? { count: 0, last: null };
          current.count += 1;
          if (current.last === null || attempt.submittedAt > current.last) {
            current.last = attempt.submittedAt;
          }
          grouped.set(attempt.paperId, current);
        }
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM facts
           WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
           ORDER BY created_tick DESC, id`,
          [tx.learner, workbookPaperType],
        );
        const summaries: WorkbookSummary[] = [];
        for (const row of rows) {
          try {
            const paper = await readPaper(tx, factId(row.id));
            const source = paper.materialId === null
              ? null
              : await sourceView(tx, read, paper.materialId);
            const usage = grouped.get(row.id);
            summaries.push({
              id: row.id,
              title: paper.title,
              questionCount: paper.questions.length,
              savedAt: paper.savedAt,
              sourceId: paper.materialId,
              sourceTitle: source?.title ?? null,
              attemptCount: usage?.count ?? 0,
              lastAttemptAt: usage?.last ?? null,
            });
          } catch (error) {
            if (
              error instanceof FactReadDeniedError ||
              error instanceof FactNotFoundError ||
              (error instanceof RequestError && (error.status === 403 || error.status === 404))
            ) continue;
            throw error;
          }
        }
        return summaries;
      });
    },

    get,
    async sheet(id: string) {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const paper = await readPaper(tx, factIdOf(id, '找不到这份试卷。'));
        return { title: paper.title, questions: workbookQuestionsView(paper) };
      });
    },
    async review(): Promise<ReviewEntry[]> {
      return db.snapshot({ learner: studioLearner }, async tx => {
        const read = createCommandReadContext(tx, storagePurpose);
        const seen = new Set<string>();
        const available = new Map<string, boolean>();
        const result: ReviewEntry[] = [];
        const assessments = await allAssessments(tx);
        for (const { id, attempt } of await allAttempts(tx, read)) {
          if (!available.has(attempt.paperId)) {
            try {
              available.set(attempt.paperId, Boolean(await readPaperOrNull(tx, factId(attempt.paperId))));
            } catch (error) {
              if (!(error instanceof RequestError) || ![403, 404].includes(error.status)) throw error;
              available.set(attempt.paperId, false);
            }
          }
          if (!available.get(attempt.paperId)) continue;
          for (const f of attempt.feedback) {
            const key = attempt.paperId + '/' + f.questionId;
            const grade = assessments.get(id)?.find(result => result.questionId === f.questionId);
            const verdict = grade?.verdict ?? f.result;
            if (verdict === 'pending' || verdict === 'unanswered' || verdict === 'self-check' || seen.has(key)) continue;
            seen.add(key);
            if (verdict !== 'incorrect' && verdict !== 'partial') continue;
            const q = attempt.paper.questions.find(q => q.id === f.questionId);
            if (!q) continue;
            const expected = f.expected.kind === 'exact'
              ? f.expected.values.join(' / ')
              : f.expected.kind === 'rubric'
                ? f.expected.rubric
                : [f.expected.value, f.expected.unit].filter(x => x !== null).join(' ');
            result.push({ paperId: attempt.paperId, title: attempt.paper.title, questionId: q.id,
              prompt: q.prompt, answer: String(f.answer), expected, explanation: grade?.feedback ?? f.explanation });
          }
        }
        return result;
      });
    },

    async save(input: unknown): Promise<WorkbookDetailWithAssessment> {
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
        if (!sameDraft(existing, draft)) {
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
          if (saved && sameDraft(saved, draft)) return get(paperId);
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
        const row = input as { requestId?: unknown; answers?: unknown; assessmentConsent?: unknown } | null;
        data = workbookAttemptRequest({
          paperId,
          requestId: row?.requestId,
          submittedAt: now,
          answers: row?.answers,
          assessmentConsent: row?.assessmentConsent,
        });
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
      const attemptId = factId(stableId('workbook-attempt', paperId, data.requestId));
      const existing = await db.snapshot({ learner: studioLearner }, (tx) => readAttemptOrNull(tx, attemptId));
      const paper = existing?.paper ?? await db.snapshot({ learner: studioLearner }, (tx) => readPaper(tx, paperId));
      let graded: ReturnType<typeof gradeWorkbook>;
      try {
        graded = gradeWorkbook(paper, data.answers);
        if (paper.assessmentRelease) frozenSubmission(paper.assessmentRelease, { id: attemptId, rev: 1 as Revision }, graded.answers);
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
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
          type: submitWorkbookAttemptCommand,
          id: commandId(stableId('submit-workbook-attempt', attemptId)),
          input: {
            id: attemptId,
            data,
          },
        });
      } catch (error) {
        if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) {
          throw new RequestError(403, '这份试卷当前不可读取。');
        }
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          const saved = await db.snapshot({learner: studioLearner}, tx => readAttemptOrNull(tx, attemptId));
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
        await readPaper(tx, paperId);
        const attempt = await readAttemptOrNull(tx, attemptId);
        if (!attempt || attempt.paperId !== paperId) {
          throw new RequestError(404, '找不到这次作答。');
        }
        if (attempt.paper.assessmentRelease?.items.some(item => item.itemId === request.questionId)) {
          throw new RequestError(409, '此题已经随交卷登记自动评估，请刷新作答查看状态。');
        }
        const question = attempt.paper.questions.find(({ id }) => id === request.questionId);
        if (!question || question.kind !== 'rubric') {
          throw new RequestError(400, '这道题没有可用的评分标准。');
        }
        const answer = attempt.answers[question.id];
        if (typeof answer !== 'string' || !answer.trim()) {
          throw new RequestError(400, '这次作答没有可供批改的文字。');
        }
        const id = assessmentKey(attemptId, question);
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

      const data: WorkbookRubricAssessment = {
        attemptId,
        paperId,
        questionId: selected.question.id,
        requestId: request.requestId,
        assessedAt: new Date().toISOString(),
        consent: request.consent,
        ...(request.publicSearchQuery ? {publicSearchQuery: request.publicSearchQuery} : {}),
        assessmentVersion: workbookRubricAssessmentVersion,
        rubricVersion: selected.question.rubricVersion,
        rubric: selected.question.rubric,
        providerBaseUrl: settings.baseUrl,
        requestedModel: settings.model,
        providerProtocol: settings.protocol,
        providerId: settings.activeProviderId,
        ...result,
      };
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
