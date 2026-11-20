import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError } from '../../kernel/src/commands/reads.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { Json, ReadContext } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  closedPosttest, issuePosttestCommand, posttestIssuance, posttestIssuanceType, posttestSubmissionType,
  retentionPaper, retentionPaperType, retentionTeachingPurpose,
} from '../../modules/activity/retention-posttest.ts';
import {
  gradeWorkbook, sameWorkbookJson, saveWorkbookPaperCommand, submitWorkbookAttemptCommand, workbookAttempt,
  workbookDraft, workbookQuestionView, workbookRequestId, type WorkbookPaper,
} from '../../modules/activity/workbook-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId } from './identity.ts';
import { RequestError } from './sessions.ts';

type Issuance = ReturnType<typeof posttestIssuance>;

export const posttestIdFor = (forecast: string) => factId(stableId('retention-posttest', forecast));
export const posttestAttemptFor = (issuance: string) => factId(stableId('retention-posttest-attempt', issuance));

async function optionalFact(read: ReadContext, id: FactId) {
  try { return await read.fact(id, { mode: 'following' }); }
  catch (error) {
    if (!(error instanceof FactNotFoundError)) throw error;
    return undefined;
  }
}

export async function readPosttestIssuance(tx: ReadTransaction, read: ReadContext, id: FactId) {
  const fact = await read.fact(id, { mode: 'following' });
  if (fact.type !== posttestIssuanceType || fact.ref.rev !== 1) throw new RequestError(422, '需要原始后测发放记录。');
  const issuance = posttestIssuance(fact.value);
  const { rows: [birth] } = await tx.query<{ tick: Tick }>(
    `SELECT r.tick::text FROM fact_revs r
     JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
     WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
       AND c.type=$3 AND c.state='done' AND r.data=c.input->'input'->'data'`,
    [tx.learner, id, issuePosttestCommand],
  );
  if (!birth || BigInt(birth.tick) <= BigInt(issuance.effectiveTick)) throw new RequestError(422, '后测缺少预测生效后的发放回执。');
  return { ref: fact.ref, issuance, tick: birth.tick };
}

export function posttestWriter(db: Db, activity: LoadedModule) {
  const hooks = createStudioCommandHooks();
  const reader = (tx: ReadTransaction) => createCommandReadContext(tx, retentionTeachingPurpose);

  // The same lock covers the live forecast check, formal command and reconciliation enqueue.
  async function write(tx: DbTransaction, type: string, id: FactId, data: Json) {
    const handle = createCommandHandler({ ...db, query: tx.query, tx: async (scope, run) => {
      if (scope.learner !== tx.learner) throw new Error('Posttest command learner mismatch');
      return run(tx);
    } }, { modules: [activity], hooks });
    const receipt = await handle({ learner: tx.learner, actor: 'learner', purpose: retentionTeachingPurpose,
      type, id: commandId(stableId(type, id)), input: { id, data, condition: closedPosttest } });
    if (receipt.state !== 'done') throw new RequestError(409, '这次后测操作已失效。');
  }

  return {
    async save(tx: DbTransaction, input: Record<string, unknown>) {
      let id: FactId;
      let paper: WorkbookPaper;
      try {
        id = factId(stableId('retention-paper', workbookRequestId(input.requestId)));
        if (input.assessmentRelease !== undefined) throw new Error('受控后测使用确定性卷面判分。');
        paper = retentionPaper({ ...workbookDraft(input), savedAt: new Date().toISOString() });
      } catch (error) {
        throw new RequestError(400, error instanceof Error ? error.message : '冻结卷格式无效。');
      }
      const existing = await optionalFact(reader(tx), id);
      if (existing) {
        const previous = retentionPaper(existing.value);
        if (existing.type !== retentionPaperType || !sameWorkbookJson(previous, { ...paper, savedAt: previous.savedAt })) {
          throw new RequestError(409, '冻结卷请求标识已使用。');
        }
      } else await write(tx, saveWorkbookPaperCommand, id, paper);
      return { id, itemId: paper.questions[0]!.id };
    },

    async start(tx: DbTransaction, data: Omit<Issuance, 'startedAt' | 'condition'>, paper: WorkbookPaper, notBefore: string) {
      const id = posttestIdFor(data.forecastId);
      const read = reader(tx);
      const existing = await optionalFact(read, id);
      if (!existing) {
        const startedAt = new Date().toISOString();
        if (startedAt < notBefore || startedAt >= data.through) throw new RequestError(409, '当前时间不在保持预测的观察窗口内。');
        await write(tx, issuePosttestCommand, id, { ...data, startedAt, condition: closedPosttest });
      }
      const { ref, issuance, tick } = await readPosttestIssuance(tx, read, id);
      return {
        id: ref.id, rev: ref.rev, issuedAtTick: tick, forecastId: data.forecastId, startedAt: issuance.startedAt,
        through: issuance.through, item: workbookQuestionView(paper.questions[0]!),
        observationScope: closedPosttest,
      };
    },

    async submit(tx: DbTransaction, id: FactId, issuance: Issuance, paper: WorkbookPaper, input: Record<string, unknown>) {
      const { answer } = input;
      if (Object.keys(input).length !== 1 || typeof answer !== 'string' || !answer.trim() ||
          answer.length > 4000 || !answer.isWellFormed() || answer.includes('\0')) {
        throw new RequestError(400, '后测只接受一份非空作答。');
      }
      const answers = { [issuance.itemId]: answer };
      let graded: ReturnType<typeof gradeWorkbook>;
      try { graded = gradeWorkbook(paper, answers); }
      catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '后测作答无效。'); }
      const attemptId = posttestAttemptFor(id);
      const existing = await optionalFact(reader(tx), attemptId);
      if (existing) {
        const attempt = workbookAttempt(existing.value);
        if (existing.type !== posttestSubmissionType || !sameWorkbookJson(attempt.answers, graded.answers)) {
          throw new RequestError(409, '此次后测已经交卷。');
        }
      } else {
        const submittedAt = new Date().toISOString();
        if (submittedAt < issuance.startedAt || submittedAt > issuance.through) throw new RequestError(409, '交卷超出后测窗口。');
        await write(tx, submitWorkbookAttemptCommand, attemptId, { paperId: id, requestId: attemptId, submittedAt, answers });
      }
      return attemptId;
    },
  };
}
