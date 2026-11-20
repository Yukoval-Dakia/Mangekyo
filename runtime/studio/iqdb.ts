import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import {
  bankProposalView, inspectBankQuestion, parsePaper, parseProposal, recordedReferences, selectBankQuestions, type QuestionRef,
} from '../../modules/activity/iqdb-selection.ts';
import { assetType } from '../../modules/content/asset.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { enqueueQuestionVerification, readCurrentQuestionVerification } from './iqdb-verification.ts';
import { RequestError } from './sessions.ts';

export type IssueBank = (tx: DbTransaction, input: { requestId: string; questionRefs: readonly QuestionRef[]; deletionWatermark: string }) => Promise<{ id: FactId }>;
const scope = { learner: studioLearner };
const proposalLabel = 'iqdb-proposal';
const blocked = () => new RequestError(409, '请重新选择当前获准且已独立验收的固定题版。');

function validated<Result>(parse: () => Result) {
  try { return parse(); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '题库请求无效。'); }
}

async function inspectQuestion(tx: ReadTransaction, id: FactId, pinned?: QuestionRef['rev']) {
  const read = { ...createCommandReadContext(tx, purpose), slot: readCurrentQuestionVerification(tx) };
  try {
    return await inspectBankQuestion(read, id, pinned);
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
        (error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。')) return;
    throw error;
  }
}

async function listQuestions(tx: ReadTransaction) {
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='question'
       AND f.purpose && ARRAY[$3,'all']::text[] ORDER BY f.id`, [tx.learner, assetType, purpose],
  );
  const questions = [];
  for (const { id } of rows) {
    const opened = await inspectQuestion(tx, id);
    if (opened) questions.push(opened.public);
  }
  return questions;
}

export function openIqdb(db: Db, verificationConfigured: boolean, issueBank: IssueBank) {
  return {
    questions: () => db.snapshot(scope, async tx => ({ questions: await listQuestions(tx) })),
    async proposals({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parseProposal(raw));
      const proposalId = stableId(proposalLabel, input.requestId);
      const saved = await recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: proposalId,
        stepKey: 'plan', label: proposalLabel, input }, async tx => {
        const questionRefs = input.questionRefs.length ? input.questionRefs : selectBankQuestions(input, await listQuestions(tx));
        return JSON.stringify({ ...input, questionRefs });
      }, tx => assertDeletionWatermark(tx, watermark)).catch(error => {
        if (error instanceof Error && error.message === 'Workspace read receipt does not match the request')
          throw new RequestError(409, '这个请求标识已经用于另一份提案。');
        throw error;
      });
      return db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await assertDeletionWatermark(tx, watermark);
        const requested = recordedReferences(saved);
        const selected: NonNullable<Awaited<ReturnType<typeof inspectQuestion>>>[] = [];
        for (const ref of requested) {
          const opened = await inspectQuestion(tx, ref.id, ref.rev);
          if (!opened) continue;
          if (verificationConfigured && opened.public.status === 'needs_verification' && !opened.reviewed)
            await enqueueQuestionVerification(tx, opened.version);
          selected.push(opened);
        }
        return bankProposalView(input, proposalId, requested, selected);
      });
    },
    async papers({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parsePaper(raw));
      return db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await assertDeletionWatermark(tx, watermark);
        let refs;
        if (input.sourceRef) refs = [input.sourceRef];
        else {
          const { rows: [saved] } = await tx.query<{ result: string }>(
            `SELECT result FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2
             AND step_key='plan' AND label=$3 AND state='done'`, [tx.learner, input.proposalId, proposalLabel],
          );
          if (!saved) throw new RequestError(404, '找不到这份题库提案。');
          refs = recordedReferences(saved.result);
        }
        if (!refs.length) throw blocked();
        return issueBank(tx, { requestId: input.requestId, questionRefs: refs, deletionWatermark: watermark });
      });
    },
  };
}
