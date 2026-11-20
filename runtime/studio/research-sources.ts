import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  readResearchSource, ResearchBasisChanged, researchOrder, researchOrderType, researchPurpose, researchWorksheet,
  researchWorksheetType,
  type ResearchOrder,
} from '../../modules/companion/research.ts';
import { stableId } from './identity.ts';
import { RequestError } from './sessions.ts';

export const researchReader = (tx: ReadTransaction) => createCommandReadContext(tx, researchPurpose);

export async function whenAvailable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof ResearchBasisChanged)
      return null;
    throw error;
  }
}

export function worksheetId(attemptId: FactId, revision: number, epoch: string) {
  return factId(stableId('research-worksheet-v1', attemptId, String(revision), epoch));
}

export async function workbookSource(tx: ReadTransaction, paperId: string, attemptId: string) {
  const id = factId(attemptId);
  const { rowCount } = await tx.query(
    'SELECT id FROM facts WHERE learner_id = $1 AND type = $2 AND id = $3',
    [tx.learner, workbookAttemptType, id],
  );
  if (!rowCount) throw new RequestError(404, '找不到这次作答。');
  const fact = await whenAvailable(() => createCommandReadContext(tx, storagePurpose).fact(id, { mode: 'following' }));
  if (!fact || workbookAttempt(fact.value).paperId !== paperId) throw new RequestError(404, '找不到这次作答。');
  return fact;
}

export function reviewEvidence(data: unknown, questionId: string) {
  const attempt = workbookAttempt(data);
  const index = attempt.paper.questions.findIndex(question => question.id === questionId);
  const question = attempt.paper.questions[index];
  const feedback = attempt.feedback.find(item => item.questionId === questionId);
  if (!question || feedback?.result !== 'incorrect') throw new ResearchBasisChanged('原卷判题已变更。');
  return { paperId: attempt.paperId, paperTitle: attempt.paper.title, submittedAt: attempt.submittedAt,
    questionNumber: index + 1, questionId, prompt: question.prompt, feedback };
}
export type ReviewEvidence = ReturnType<typeof reviewEvidence>;

export async function readWorksheetById(tx: ReadTransaction, id: FactId) {
  const read = researchReader(tx);
  return whenAvailable(async () => {
    const fact = await read.fact(id, { mode: 'following' });
    if (fact.type !== researchWorksheetType || !fact.purpose.includes(researchPurpose)) return null;
    const result = researchWorksheet(fact.value);
    const order = 'todoId' in result ? null : await read.fact(result.orderId, { mode: 'following' });
    if (order && (order.type !== researchOrderType || !order.purpose.includes(researchPurpose))) return null;
    const ref = 'todoId' in result ? result.source : researchOrder(order?.value).source;
    const source = await readResearchSource(read, ref);
    if (source.type !== workbookAttemptType || id !== worksheetId(ref.attemptId, ref.revision, ref.accessEpoch))
      return null;
    await createCommandReadContext(tx, storagePurpose).fact(ref.attemptId, { mode: 'following' });
    const evidence = reviewEvidence(source.value, ref.questionId);
    const href = `/api/papers/${evidence.paperId}/attempts/${ref.attemptId}/research/${id}/source`;
    return {
      fact,
      worksheet: {
        id, ...result.draft, method: result.method, deliveredAt: result.deliveredAt, tier: 1, cost: 0,
        ...('todoId' in result ? { todoId: result.todoId, digest: result.digest } : { orderId: result.orderId }),
        source: { ...ref, href },
      },
      source: { ...ref, ...evidence },
    };
  });
}

export async function readWorksheet(tx: ReadTransaction, paperId: string, attemptId: string) {
  const attempt = await workbookSource(tx, paperId, attemptId);
  if (!attempt.purpose.includes(researchPurpose)) return null;
  return readWorksheetById(tx, worksheetId(attempt.ref.id, attempt.ref.rev, attempt.accessEpoch));
}
