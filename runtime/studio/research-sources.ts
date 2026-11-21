import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  readResearchSource, ResearchBasisChanged, researchOrder, researchOrderType, researchPurpose, researchWorksheet,
  researchWorksheetType, retentionReviewPermission, retentionReviewPermissionType,
  type ResearchOrder,
} from '../../modules/companion/research.ts';
import { stableId } from './identity.ts';
import { readMissedPosttest } from './learner-radar.ts';
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
  if (!question || question.sourceQuestionRef || feedback?.result !== 'incorrect' || !feedback.expected) throw new ResearchBasisChanged('原卷判题已变更。');
  return { paperId: attempt.paperId, paperTitle: attempt.paper.title, submittedAt: attempt.submittedAt,
    questionNumber: index + 1, questionId, prompt: question.prompt, feedback: { ...feedback, expected: feedback.expected } };
}
export type ReviewEvidence = ReturnType<typeof reviewEvidence>;

export const retentionReviewAnchor = 'retention-posttest';

export function retentionReviewPermissionId(key: string) {
  return factId(stableId('retention-review-permission', key));
}

export async function activeRetentionReview(tx: ReadTransaction, fact: FactSnapshot) {
  if (fact.type !== retentionReviewPermissionType || !fact.purpose.includes(researchPurpose)) return null;
  const permission = retentionReviewPermission(fact.value);
  if (!permission.allowed || fact.ref.id !== retentionReviewPermissionId(permission.key) ||
      !await readMissedPosttest(tx, permission.key, permission.resultId)) return null;
  return permission;
}

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
    if (id !== worksheetId(ref.attemptId, ref.revision, ref.accessEpoch)) return null;
    const retention = source.type === retentionReviewPermissionType && ref.questionId === retentionReviewAnchor
      ? await activeRetentionReview(tx, source) : null;
    if (source.type !== workbookAttemptType && !retention) return null;
    const evidence = retention ? null : reviewEvidence(source.value, ref.questionId);
    if (evidence) await createCommandReadContext(tx, storagePurpose).fact(ref.attemptId, { mode: 'following' });
    const href = retention ? `/api/retention/${retention.key}`
      : `/api/papers/${evidence!.paperId}/attempts/${ref.attemptId}/research/${id}/source`;
    return {
      fact,
      worksheet: {
        id, ...result.draft, method: result.method, deliveredAt: result.deliveredAt, tier: 1, cost: 0,
        ...('todoId' in result ? { todoId: result.todoId, digest: result.digest } : { orderId: result.orderId }),
        source: { ...ref, href },
      },
      source: evidence && { ...ref, ...evidence },
    };
  });
}

export async function readWorksheet(tx: ReadTransaction, paperId: string, attemptId: string) {
  const attempt = await workbookSource(tx, paperId, attemptId);
  if (!attempt.purpose.includes(researchPurpose)) return null;
  return readWorksheetById(tx, worksheetId(attempt.ref.id, attempt.ref.rev, attempt.accessEpoch));
}
