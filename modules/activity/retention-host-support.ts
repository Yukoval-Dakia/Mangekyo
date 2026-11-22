import { parseManifest, revalidateManifest } from '@mangekyo/kernel';
import {
  commandId, factId, stableId, createPropagationHooks, type DbTransaction, type FactId, type FactSnapshot,
  type Json, type ReadContext, type ReadTransaction, FactNotFoundError, createCommandReadContext,
} from '@mangekyo/kernel';
import { readPosttestIssuanceBirth } from './evidence-read.ts';
import {
  insideFrozenPosttestWindow, closedPosttest, type RetentionWindow, issuePosttestCommand, posttestIssuance, posttestIssuanceType, posttestSubmissionType,
  retentionPaper, retentionPaperType, retentionTeachingPurpose,
} from './retention-posttest.ts';
import {
  gradeWorkbook, sameWorkbookJson, saveWorkbookPaperCommand, submitWorkbookAttemptCommand, workbookAttempt,
  workbookDraft, workbookQuestionView, workbookRequestId, type WorkbookPaper,
} from './workbook-values.ts';

export type PosttestWriterDeps = {
  readonly createCommandReadContext: typeof createCommandReadContext;
  readonly createCommandHandler: typeof import('../../kernel/src/commands/handle.ts').createCommandHandler;
  readonly withinLearnerTransaction: typeof import('../../kernel/src/db/learner.ts').withinLearnerTransaction;
  readonly RequestError: new (status: number, message: string) => Error;
};
type Issuance = ReturnType<typeof posttestIssuance>;
export type PosttestFactReader = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };

export const posttestIdFor = (forecast: string) => factId(stableId('retention-posttest', forecast));
export const posttestAttemptFor = (issuance: string) => factId(stableId('retention-posttest-attempt', issuance));

async function optionalFact(read: ReadContext, id: FactId) {
  try { return await read.fact(id, { mode: 'following' }); }
  catch (error) {
    if (!(error instanceof FactNotFoundError)) throw error;
    return undefined;
  }
}

export async function readPosttestIssuance(tx: ReadTransaction, read: PosttestFactReader, id: FactId,
  readBirth = readPosttestIssuanceBirth, deps?: Pick<PosttestWriterDeps, 'RequestError'>) {
  const fact = await read.fact(id, { mode: 'following' });
  if (fact.type !== posttestIssuanceType || fact.ref.rev !== 1) throw new deps!.RequestError(422, '需要原始后测发放记录。');
  const issuance = posttestIssuance(fact.value);
  const birth = await readBirth(tx, id);
  if (!birth || BigInt(birth.tick) <= BigInt(issuance.effectiveTick)) throw new deps!.RequestError(422, '后测缺少预测生效后的发放回执。');
  return { fact, issuance, tick: birth.tick };
}

export function posttestWriter(db: any, activity: any, hooks: ReturnType<typeof createPropagationHooks>, deps: PosttestWriterDeps) {
  const reader = (tx: ReadTransaction) => deps.createCommandReadContext(tx, retentionTeachingPurpose);

  // The same lock covers the live forecast check, formal command and reconciliation enqueue.
  async function write(tx: DbTransaction, type: string, id: FactId, data: Json) {
    const handle = deps.createCommandHandler(deps.withinLearnerTransaction(db, tx), { modules: [activity], hooks });
    const receipt = await handle({ learner: tx.learner, actor: 'learner', purpose: retentionTeachingPurpose,
      type, id: commandId(stableId(type, id)), input: { id, data, condition: closedPosttest } });
    if (receipt.state !== 'done') throw new deps.RequestError(409, '这次后测操作已失效。');
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
        throw new deps.RequestError(400, error instanceof Error ? error.message : '冻结卷格式无效。');
      }
      const existing = await optionalFact(reader(tx), id);
      if (existing) {
        const previous = retentionPaper(existing.value);
        if (existing.type !== retentionPaperType || !sameWorkbookJson(previous, { ...paper, savedAt: previous.savedAt })) {
          throw new deps.RequestError(409, '冻结卷请求标识已使用。');
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
        if (startedAt < notBefore || startedAt >= data.through) throw new deps.RequestError(409, '当前时间不在保持预测的观察窗口内。');
        await write(tx, issuePosttestCommand, id, { ...data, startedAt, condition: closedPosttest });
      }
      const { fact: { ref }, issuance, tick } = await readPosttestIssuance(tx, read, id);
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
        throw new deps.RequestError(400, '后测只接受一份非空作答。');
      }
      const answers = { [issuance.itemId]: answer };
      let graded: ReturnType<typeof gradeWorkbook>;
      try { graded = gradeWorkbook(paper, answers); }
      catch (error) { throw new deps.RequestError(400, error instanceof Error ? error.message : '后测作答无效。'); }
      const attemptId = posttestAttemptFor(id);
      const existing = await optionalFact(reader(tx), attemptId);
      if (existing) {
        const attempt = workbookAttempt(existing.value);
        if (existing.type !== posttestSubmissionType || !sameWorkbookJson(attempt.answers, graded.answers)) {
          throw new deps.RequestError(409, '此次后测已经交卷。');
        }
      } else {
        const submittedAt = new Date().toISOString();
        if (submittedAt < issuance.startedAt || submittedAt > issuance.through) throw new deps.RequestError(409, '交卷超出后测窗口。');
        await write(tx, submitWorkbookAttemptCommand, attemptId, { paperId: id, requestId: attemptId, submittedAt, answers });
      }
      return attemptId;
    },
  };
}


export type RetentionFail = (status: number, message: string) => never;

export function requestInput<T>(parse: () => T, fail: RetentionFail): T {
  try { return parse(); }
  catch { fail(400, '保持预测请求格式无效。'); }
}

export function recordId(value: unknown) {
  if (typeof value !== 'string') throw new Error('需要记录标识。');
  return factId(value);
}

export function afterFreeze(observation: {admittedAt: string; submittedAt: string}, window: RetentionWindow, effectiveTick: import('@mangekyo/kernel').Tick, fail: RetentionFail) {
  if (!insideFrozenPosttestWindow(observation as never, window, effectiveTick)) {
    fail(409, '这次交卷不在预测冻结后的观察窗口内。');
  }
}

export function requireIndependentPosttest(observation: {exposure: {kind: string}; result: string}, fail: RetentionFail) {
  if (observation.exposure.kind !== 'independent' || observation.result === 'unknown') {
    fail(422, '需要有判分结果的独立受控后测，才能安排下一次后测。');
  }
}
export type RetentionComparisonDeps = {
  readonly RequestError: new (status: number, message: string) => Error;
  readonly retentionPurpose: string;
  readonly forecastType: string;
  readonly reconciliationType: string;
  readonly retentionComparisonWork: string;
  readonly retentionHistoryValid: (tx: ReadTransaction, id: any, observation?: any) => Promise<boolean>;
};
export type RetentionPair = { forecastKey: string; forecastId: any; reconciliationKey: string; reconciliationId: any };
export type RetentionComparisonPlan = { method: string; pairs: RetentionPair[]; manifest: any };

export function frozenInputs(deps: RetentionComparisonDeps, pair: RetentionPair) {
  return [
    { kind: 'slot', slotType: deps.forecastType, slotKey: pair.forecastKey, derivationId: pair.forecastId, mode: 'pinned' },
    { kind: 'slot', slotType: deps.reconciliationType, slotKey: pair.reconciliationKey, derivationId: pair.reconciliationId, mode: 'pinned' },
  ];
}

export async function selectPair(deps: RetentionComparisonDeps, tx: ReadTransaction, key: string): Promise<RetentionPair> {
  const { rows: [pair] } = await tx.query<RetentionPair>(
    `SELECT r.slot_key AS "reconciliationKey", d.id AS "reconciliationId",
            r.scope_keys->>'forecastKey' AS "forecastKey", r.scope_keys->>'forecastId' AS "forecastId"
     FROM slot_state r JOIN derivations d
       ON (d.learner_id,d.id,d.slot_type,d.slot_key)=(r.learner_id,r.current_id,r.slot_type,r.slot_key)
     WHERE r.learner_id=$1 AND r.slot_type=$2 AND r.slot_key=$3 AND d.lifecycle='effective'
       AND NOT d.is_shadow AND (d.value->'value'->>'forecastId')=(r.scope_keys->>'forecastId')`,
    [tx.learner, deps.reconciliationType, key],
  );
  if (!pair) throw new deps.RequestError(409, '找不到当前可用的保持对账。');
  return pair;
}

export async function readComparisonPlan(deps: RetentionComparisonDeps, tx: ReadTransaction, key: string) {
  const { rows: [job] } = await tx.query<{ plan: RetentionComparisonPlan; state: string }>(
    `SELECT s.scope_keys AS plan, w.state FROM slot_state s JOIN work w
       ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key)
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`, [tx.learner, deps.retentionComparisonWork, key],
  );
  return job;
}

export async function frozenValue<T>(tx: ReadTransaction, id: any) {
  const { rows: [row] } = await tx.query<{ value: { kind: string; value: T } }>(
    'SELECT value FROM derivations WHERE learner_id=$1 AND id=$2 AND NOT is_shadow', [tx.learner, id],
  );
  if (row?.value.kind !== 'value') throw new Error('Frozen retention value unavailable');
  return row.value.value;
}

export async function validComparisonPlan(deps: RetentionComparisonDeps, tx: ReadTransaction, plan: RetentionComparisonPlan,
  manifest = parseManifest(plan.manifest)) {
  if ((await revalidateManifest(tx, manifest, deps.retentionPurpose)).kind !== 'valid') return false;
  for (const pair of plan.pairs) {
    const { observation } = await frozenValue<{observation: unknown}>(tx, pair.reconciliationId);
    if (!await deps.retentionHistoryValid(tx, pair.forecastId, observation)) return false;
  }
  return true;
}
