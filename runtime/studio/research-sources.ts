import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  readResearchSource, ResearchBasisChanged, researchOrder, researchPurpose, researchWorksheet,
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

export async function readWorksheet(tx: ReadTransaction, paperId: string, attemptId: string) {
  const attempt = await workbookSource(tx, paperId, attemptId);
  if (!attempt.purpose.includes(researchPurpose)) return null;
  const id = worksheetId(attempt.ref.id, attempt.ref.rev, attempt.accessEpoch);
  const read = researchReader(tx);
  return whenAvailable(async () => {
    const fact = await read.fact(id, { mode: 'following' });
    const { orderId, draft, method, deliveredAt } = researchWorksheet(fact.value);
    const order = researchOrder((await read.fact(orderId, { mode: 'following' })).value);
    if (order.source.attemptId !== attempt.ref.id || order.source.revision !== attempt.ref.rev ||
        order.source.accessEpoch !== attempt.accessEpoch) throw new ResearchBasisChanged('复习单来源已变更。');
    const source = await readResearchSource(read, order.source);
    const evidence = reviewEvidence(source.value, order.source.questionId);
    const href = `/api/papers/${paperId}/attempts/${attemptId}/research/${id}/source`;
    return {
      worksheet: {
        id, orderId, ...draft, method, deliveredAt, autonomy: 0, cost: 0,
        source: { ...order.source, href },
      },
      source: { ...order.source, ...evidence },
    };
  });
}
