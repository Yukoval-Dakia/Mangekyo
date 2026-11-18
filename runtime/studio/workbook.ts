import type { ReviewEntry } from './review.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
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
  workbookCorrectCount,
  workbookDraft,
  workbookPaper,
  workbookPaperType,
  workbookQuestionsView,
  workbookRequestId,
  sameWorkbookJson,
  type WorkbookAttempt,
  type WorkbookAttemptView,
  type WorkbookDetail,
  type WorkbookDraft,
  type WorkbookPaper,
  type WorkbookSourceView,
  type WorkbookSummary,
} from '../../modules/activity/workbook-values.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';

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

function attemptView(id: string, attempt: WorkbookAttempt): WorkbookAttemptView {
  return {
    id,
    requestId: attempt.requestId,
    submittedAt: attempt.submittedAt,
    answers: attempt.answers,
    feedback: attempt.feedback.map(item => item.result === 'unanswered' ? {...item, expected: null, explanation: null} : item),
    correctCount: workbookCorrectCount(attempt.feedback),
    total: attempt.paper.questions.filter(q => q.kind !== 'exact' || !q.selfCheck).length,
  };
}

async function allAttempts(
  tx: ReadTransaction,
  read: ReturnType<typeof createCommandReadContext>,
): Promise<{ id: string; attempt: WorkbookAttempt }[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts
     WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id`,
    [tx.learner, workbookAttemptType],
  );
  const attempts: { id: string; attempt: WorkbookAttempt }[] = [];
  for (const row of rows) {
    try {
      const fact = await read.fact(factId(row.id), { mode: 'following' });
      attempts.push({ id: row.id, attempt: workbookAttempt(fact.value) });
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

function sameDraft(paper: WorkbookPaper, draft: WorkbookDraft): boolean {
  return sameWorkbookJson({
    title: paper.title,
    materialId: paper.materialId,
    questions: paper.questions,
  }, draft);
}

export function openWorkbook(db: Db, activity: LoadedModule) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: { async onFactsChanged() {} },
  });

  async function get(id: string): Promise<WorkbookDetail> {
    const paperId = factIdOf(id, '找不到这份试卷。');
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      const paper = await readPaper(tx, paperId);
      const read = createCommandReadContext(tx, storagePurpose);
      const source = paper.materialId === null
        ? null
        : await sourceView(tx, read, paper.materialId);
      const attempts = (await allAttempts(tx, read))
        .filter(({ attempt }) => attempt.paperId === paperId)
        .map(({ id: attemptId, attempt }) => attemptView(attemptId, attempt));
      return {
        id: paperId,
        title: paper.title,
        savedAt: paper.savedAt,
        source,
        questions: workbookQuestionsView(paper),
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
        for (const { attempt } of await allAttempts(tx, read)) {
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
            if (f.result === 'unanswered' || f.result === 'self-check' || seen.has(key)) continue;
            seen.add(key);
            if (f.result !== 'incorrect') continue;
            const q = attempt.paper.questions.find(q => q.id === f.questionId);
            if (!q) continue;
            const expected = f.expected.kind === 'exact' ? f.expected.values.join(' / ') :
              [f.expected.value, f.expected.unit].filter(x => x !== null).join(' ');
            result.push({ paperId: attempt.paperId, title: attempt.paper.title, questionId: q.id,
              prompt: q.prompt, answer: String(f.answer), expected, explanation: f.explanation });
          }
        }
        return result;
      });
    },

    async save(input: unknown): Promise<WorkbookDetail> {
      let draft: WorkbookDraft;
      let request: string;
      try {
        const row = input as { requestId?: unknown } | null;
        request = workbookRequestId(row?.requestId);
        draft = workbookDraft(input);
      } catch (error) {
        invalid(error, '试卷格式无效。');
      }
      const paperId = factId(stableId('workbook-paper', request));
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

    async submit(id: string, input: unknown): Promise<WorkbookDetail> {
      const paperId = factIdOf(id, '找不到这份试卷。');
      const now = new Date().toISOString();
      let request: string;
      let rawAnswers: Record<string, string | null>;
      try {
        const row = input as { requestId?: unknown; answers?: unknown } | null;
        request = workbookRequestId(row?.requestId);
        rawAnswers = workbookAttemptRequest({
          paperId,
          requestId: request,
          submittedAt: now,
          answers: row?.answers,
        }).answers;
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
      const paper = await db.snapshot({ learner: studioLearner }, async (tx) =>
        readPaper(tx, paperId),
      );
      let graded;
      try {
        graded = gradeWorkbook(paper, rawAnswers);
      } catch (error) {
        invalid(error, '作答格式无效。');
      }
      const attemptId = factId(stableId('workbook-attempt', paperId, request));
      const existing = await db.snapshot({ learner: studioLearner }, async (tx) =>
        readAttemptOrNull(tx, attemptId),
      );
      if (existing) {
        if (
          existing.paperId !== paperId ||
          !sameWorkbookJson(existing.answers, graded.answers)
        ) {
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
            data: {
              paperId,
              requestId: request,
              submittedAt: now,
              answers: rawAnswers,
            },
          },
        });
      } catch (error) {
        if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) {
          throw new RequestError(403, '这份试卷当前不可读取。');
        }
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          const saved = await db.snapshot({learner: studioLearner}, tx => readAttemptOrNull(tx, attemptId));
          if (saved && sameWorkbookJson(saved.answers, graded.answers)) return get(paperId);
          throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
        }
        throw error;
      }
      return get(paperId);
    },
  };
}
