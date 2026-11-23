import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { withLearnerLock, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { createPropagationHooks, factId, learnerId, type DbTransaction, type DerivationId, type FactId, type GatherContext, type GatherInput, type Json, type JsonObject, type ReadTransaction, type Tick, type Waiting } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { failWork, readWork, requestCatalogedWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { throughTick, validatesWorkbookHistory, workbookReadAtWatermark } from '../../modules/activity/evidence-read.ts';
import { findWorkbookRetentionSlot as findSlot, workbookEvidenceWatermark as evidenceWatermark, type SlotRow } from '../../modules/activity/retention-history.ts';
import { afterFreeze, posttestAttemptFor, posttestIdFor, posttestWriter, recordId, requestInput, requireIndependentPosttest } from '../../modules/activity/retention-host-support.ts';
import { matchesCurrentPosttest, posttestOpensAt, retentionFollowupRequest, retentionFreezeRequest, retentionTeachingPurpose as retentionPurpose } from '../../modules/activity/retention-posttest.ts';
import { authorizedRetention, currentRetentionForecast, currentRetentionReconciliation, getRetentionSlot, isRetentionSlot as isRetentionSlotHost, listRetentionPosttests, projectRetentionSlot, reconcileRetentionAttempt, retentionHistoryValid as retentionHistoryValidHost, sameRetentionTarget, type ForecastScope, type StudioRetentionDeps } from '../../modules/activity/studio-retention-host.ts';
import { workbookGradingVersion } from '../../modules/activity/workbook-values.ts';
import forecast from '../../modules/learner/derivers/retention-forecast.ts';
import reconciliation from '../../modules/learner/derivers/retention-reconciliation.ts';
import { defaultRetentionMethod, evaluateFrozenRetention, readAnyRetentionMethod, type RetentionForecast, type RetentionObservation, type RetentionTarget } from '../../modules/learner/retention.ts';
import { buildRetentionForecastPayload, checkRetentionFreezeEligibility, matchesRetentionFreezeScope, unwrapPythonRetentionOutcome, type ComparableRetentionRow } from '../../modules/learner/retention-slice.ts';
import { againstFrozenTarget } from '../../modules/learner/retention-view.ts';
import forecastSlot from '../../modules/learner/slots/forecast.ts';
import reconciliationSlot from '../../modules/learner/slots/reconciliation.ts';
import { createPythonDeriverHost, type PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import type { CognitionResult } from '../../executors/python-deriver/schema.ts';
import { createCommandReadContext, FactReadDeniedError, factReadChecks, isFactUnavailable } from './fact-read-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { openRetentionTarget, readComparableWorkbookEvidence, readItemDimensions, readWorkbookObservation } from './retention-workbook.ts';
import { RequestError } from './sessions.ts';

const forecastPolicy = { slot: forecastSlot, purpose: retentionPurpose, deriver: `${forecast.name}@${forecast.version}` };
const reconciliationPolicy = { slot: reconciliationSlot, purpose: retentionPurpose, deriver: `${reconciliation.name}@${reconciliation.version}` };
const propagation = createPropagationHooks([]), scope = { learner: studioLearner };
const forecastUnavailable = '预测的冻结依据已变化或不可读取。', legacyRetentionMethod = 'last-independent-result@1';
const fail = (status: number, message: string): never => { throw new RequestError(status, message); };
type ReconciliationScope = { forecastKey: string; forecastId: DerivationId; attemptId: FactId };
type ReconciliationValue = Extract<Awaited<ReturnType<typeof reconciliation.derive>>, { kind: 'value' }>['value'];

let cachedDeps: StudioRetentionDeps | undefined;
function getRetentionDeps(): StudioRetentionDeps {
  return cachedDeps ??= {
    retentionPurpose, forecastSlotType: forecastSlot.type, reconciliationSlotType: reconciliationSlot.type,
    forecastUnavailable, fail, isRequestError: error => error instanceof RequestError, ...factReadChecks,
    stableId, canonicalJsonString, reconciliationSlotKey: input => reconciliationSlot.key(input),
    openRetentionTarget: (tx, read, paper, itemId) => openRetentionTarget(tx, read, paper as FactId, itemId),
    readWorkbookObservation: (...args) => readWorkbookObservation(...args),
    readComparableWorkbookEvidence: (...args) => readComparableWorkbookEvidence(...args),
    requireFreshVariant, againstFrozenTarget: againstFrozenTarget as StudioRetentionDeps['againstFrozenTarget'], afterFreeze,
    enqueueWork: (tx, slotType, slotKey, scopeKeys) => tx.withLearnerWrite(tick => requestCatalogedWork(tx, tick,
      { slotType, slotKey, deriver: reconciliationPolicy.deriver }, canonicalJsonString(scopeKeys as JsonObject), { reuseSlot: true })).then(() => {}),
  };
}
// Hoisted function exports break circular ESM TDZ with learner-radar.ts.
export function retentionHistoryValid(tx: ReadTransaction, id: DerivationId, observation?: RetentionObservation) {
  return retentionHistoryValidHost(getRetentionDeps(), tx, id, observation);
}
export function isRetentionSlot(type: string) { return isRetentionSlotHost(getRetentionDeps(), type); }
const project = <T>(tx: ReadTransaction, key: string, row: SlotRow<T, unknown>) => projectRetentionSlot(getRetentionDeps(), tx, key, row);
const enqueue = (tx: DbTransaction, policy: CandidatePolicy, key: string, scopeKeys: JsonObject) =>
  tx.withLearnerWrite(tick => requestCatalogedWork(tx, tick, { slotType: policy.slot.type, slotKey: key, deriver: policy.deriver }, canonicalJsonString(scopeKeys), { reuseSlot: true }));
const gatherInSnapshot = (db: Db, learner: typeof studioLearner, gather: (tx: ReadTransaction, ctx: GatherContext) => GatherInput<Json> | Waiting | Promise<GatherInput<Json> | Waiting>) =>
  db.snapshot({ learner }, tx => gatherSnapshot({ ...db, snapshot: (_, read) => read(tx) }, { learner, purpose: retentionPurpose }, ctx => gather(tx, ctx)));
let defaultHost: PythonDeriverHost | undefined;
export function evaluateStudioRetention(method: NonNullable<ReturnType<typeof readAnyRetentionMethod>>, input: RetentionForecast['input'], host?: PythonDeriverHost) {
  return evaluateFrozenRetention(method, input, async (slice, version) => {
    const selected = readAnyRetentionMethod(version);
    if (!selected || !('deriver' in selected)) throw new Error('未登记的 Python 保持力方法。');
    return unwrapPythonRetentionOutcome(await (host ?? (defaultHost ??= createPythonDeriverHost())).derive(selected.deriver, slice)) as CognitionResult;
  });
}
async function requireFreshVariant(tx: ReadTransaction, target: RetentionTarget, cutoff: Tick, issuance?: FactId) {
  if (!await validatesWorkbookHistory(tx, target, throughTick(cutoff), issuance)) throw new RequestError(409, '当前不能按新变式发放或记录此题。');
}
export function openRetention(db: Db, activity: LoadedModule, method = defaultRetentionMethod, host?: PythonDeriverHost) {
  const configured = readAnyRetentionMethod(method);
  if (!configured) throw new Error('保持方法配置无效：' + method);
  const supportsVariant = 'deriver' in configured, deps = getRetentionDeps();
  const posttest = posttestWriter(db, activity, propagation, { createCommandReadContext, createCommandHandler, withinLearnerTransaction, RequestError });
  const write = <T>(run: (tx: DbTransaction) => Promise<T>) => authorizedRetention(deps, () => withLearnerLock(db, scope, run));
  const currentForecast = (tx: ReadTransaction, key: string) => currentRetentionForecast(deps, tx, key);
  const enqueueForecast = async (tx: DbTransaction, key: string, opened: Awaited<ReturnType<typeof openRetentionTarget>>,
    plan: Pick<ForecastScope, 'priorAttemptIds' | 'window' | 'sourceReconciliationKey'>, condition: RetentionTarget['condition'] = opened.target.condition) => {
    await enqueue(tx, forecastPolicy, key, { target: { ...opened.target, condition }, method, paperEpoch: opened.accessEpoch, evidenceThrough: await evidenceWatermark(tx), ...plan });
    return { key, state: 'pending' as const };
  };
  async function currentPosttest(tx: ReadTransaction, id: FactId, expectedKey?: string) {
    const { fact, issuance } = await readPosttestIssuance(tx, createCommandReadContext(tx, retentionPurpose), id);
    if (expectedKey !== undefined && issuance.forecastKey !== expectedKey) throw new RequestError(404, '后测不属于该预测。');
    const current = await currentForecast(tx, issuance.forecastKey);
    if (id !== posttestIdFor(current.frozen.derivationId) || !matchesCurrentPosttest(issuance, current)) throw new RequestError(409, forecastUnavailable);
    await requireFreshVariant(tx, current.frozen.value.input.target, await evidenceWatermark(tx), id);
    return { current, issuance, fact };
  }
  return {
    freeze(paperId: string, input: Record<string, unknown>) {
      const { requestId, itemId, priorAttemptIds, through, condition } = requestInput(() => retentionFreezeRequest(input), fail);
      const id = factId(paperId), key = forecastSlot.key({ forecastId: stableId('retention-forecast', id, requestId) });
      return write(async tx => {
        const existing = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
        if (existing) {
          if (!matchesRetentionFreezeScope(existing.scope_keys, { itemId, condition, through, priorAttemptIds })) throw new RequestError(409, '预测请求标识已使用。');
          return project(tx, key, existing);
        }
        const requestedAt = new Date().toISOString();
        if (through <= requestedAt) throw new RequestError(400, '预测截止时间须晚于当前。');
        const read = createCommandReadContext(tx, retentionPurpose), opened = await openRetentionTarget(tx, read, id, itemId), cutoff = await evidenceWatermark(tx);
        await requireFreshVariant(tx, { ...opened.target, condition }, cutoff);
        let witnessedVariant = false;
        for (const attemptId of priorAttemptIds) {
          const { evidence, novelty } = await readComparableWorkbookEvidence(tx, read, opened, attemptId, cutoff);
          witnessedVariant ||= novelty === 'isomorphic';
          if (evidence.observation.submittedAt > requestedAt) throw new RequestError(422, '交卷时间晚于预测发起时间。');
        }
        const ineligible = checkRetentionFreezeEligibility({ condition, sealed: opened.sealed, witnessedVariant, supportsVariant });
        if (ineligible) throw new RequestError(422, ineligible);
        return enqueueForecast(tx, key, opened, { priorAttemptIds, window: { requestedAt, through } }, condition);
      });
    },
    scheduleFollowup(reconciliationKey: string, input: Record<string, unknown>) {
      const { requestId, scheduledAt, through } = requestInput(() => retentionFollowupRequest(input), fail);
      const key = forecastSlot.key({ forecastId: stableId('retention-followup', reconciliationKey, requestId) });
      return write(async tx => {
        const existing = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
        if (existing) {
          if (existing.scope_keys.window.scheduledAt !== scheduledAt) throw new RequestError(409, '后测安排请求标识已使用。');
          return { key, state: (await project(tx, key, existing)).state };
        }
        const requestedAt = new Date().toISOString();
        if (scheduledAt <= requestedAt) throw new RequestError(400, '后测安排时间须晚于当前。');
        const { forecastKey, forecastId, attemptId } = await currentRetentionReconciliation(deps, tx, reconciliationKey);
        const { frozen, opened, read, window } = await currentForecast(tx, forecastKey);
        if (!opened.sealed || frozen.derivationId !== forecastId || attemptId !== posttestAttemptFor(posttestIdFor(forecastId)))
          throw new RequestError(422, '只能从原受控后测的交卷安排下一次后测。');
        const observation = await readWorkbookObservation(tx, read, opened, attemptId, forecastId);
        afterFreeze(observation, window, frozen.effectiveTick, fail);
        requireIndependentPosttest(observation, fail);
        return enqueueForecast(tx, key, opened, { priorAttemptIds: [attemptId], window: { requestedAt, scheduledAt, through }, sourceReconciliationKey: reconciliationKey });
      });
    },
    async execute(ref: WorkRef, terminal: boolean) {
      const work = await readWork(db, ref);
      const policy = work?.slotType === forecastSlot.type ? forecastPolicy : work?.slotType === reconciliationSlot.type ? reconciliationPolicy : undefined;
      if (!work || !policy || work.deriver !== policy.deriver) return;
      const learner = learnerId(ref.learner);
      const block = (reason: string) => failWork(db, ref, tx => tx.query(
        'UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [tx.learner, work.slotType, work.slotKey, JSON.stringify({ status: 'blocked', reason })]).then(() => {}));
      if (terminal) { await block('保持推导执行失败。'); return; }
      try {
        const gathered = await gatherInSnapshot(db, learner, (tx, ctx) => work.slotType === forecastSlot.type
          ? forecast.gather(ctx, async () => {
              const slot = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, work.slotKey);
              if (!slot) throw new Error('Forecast work is missing slot scope');
              const { target, window, priorAttemptIds, evidenceThrough } = slot.scope_keys, cutoff = evidenceThrough ?? ctx.snapshotTick;
              const read = workbookReadAtWatermark(tx, createCommandReadContext(tx, retentionPurpose), ctx.read, cutoff, () => new FactReadDeniedError('changed', '预测发起时该修订还不可见。'));
              const opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
              sameRetentionTarget(deps, opened, slot.scope_keys);
              await requireFreshVariant(tx, target, ctx.snapshotTick);
              const targetDimensions = await readItemDimensions(tx, read, opened.question.sourceQuestionRef, cutoff), rows: ComparableRetentionRow[] = [];
              for (const id of priorAttemptIds) {
                const comparable = await readComparableWorkbookEvidence(tx, read, opened, id, cutoff);
                if (window.scheduledAt) requireIndependentPosttest(comparable.evidence.observation, fail);
                const concepts = comparable.novelty === 'same' ? targetDimensions : await readItemDimensions(tx, read, comparable.opened.question.sourceQuestionRef, cutoff);
                rows.push({ observation: comparable.evidence.observation, helpLevel: comparable.evidence.process.helpLevel, novelty: comparable.novelty, concepts, recordedAt: comparable.evidence.recordedAt, duration: comparable.evidence.duration });
              }
              const built = buildRetentionForecastPayload({ snapshotTick: ctx.snapshotTick, cutoff, target, window, targetDimensions, rows, method: slot.scope_keys.method ?? legacyRetentionMethod });
              if (!built.ok) throw new RequestError(built.status, built.message);
              return built.value;
            })
          : reconciliation.gather(ctx, async ({ read }) => {
              const slot = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, work.slotKey);
              if (!slot) throw new Error('Reconciliation work is missing slot scope');
              const { forecastKey, forecastId, attemptId } = slot.scope_keys, row = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, forecastKey);
              if (!row) throw new RequestError(409, forecastUnavailable);
              const frozen = await project(tx, forecastKey, row);
              if (frozen.state !== 'current' || frozen.derivationId !== forecastId) throw new RequestError(409, forecastUnavailable);
              await read.slot({ learner, type: forecastSlot.type, key: forecastKey }, { mode: 'following' });
              const { target, window } = row.scope_keys, opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
              sameRetentionTarget(deps, opened, row.scope_keys);
              const observation = againstFrozenTarget(await readWorkbookObservation(tx, read, opened, attemptId, forecastId), frozen.value.input.target);
              afterFreeze(observation, window, frozen.effectiveTick, fail);
              if (!await retentionHistoryValid(tx, forecastId, observation)) throw new RequestError(409, forecastUnavailable);
              return { forecastId, forecast: frozen.value, observation };
            }));
        const sealed = await sealCandidate(db, ref, policy, gathered);
        if (sealed.kind !== 'sealed') return;
        if (work.slotType === forecastSlot.type) {
          const { method: m, ...input } = sealed.plan.data as Parameters<typeof forecast.derive>[0];
          const selected = readAnyRetentionMethod(m ?? legacyRetentionMethod);
          if (!selected) { await block('冻结预测使用了未知的保持方法。'); return; }
          const result = new Date().toISOString() < input.window.through
            ? { kind: 'value' as const, value: await evaluateStudioRetention(selected, input, host) }
            : { kind: 'failed' as const, reason: '观察窗口在预测冻结前已结束。' };
          await submitCandidate(db, ref, policy, sealed.id, result, propagation);
        } else await submitCandidate(db, ref, policy, sealed.id, reconciliation.derive(sealed.plan.data as Parameters<typeof reconciliation.derive>[0]), propagation);
      } catch (error) {
        if (!(error instanceof RequestError || isFactUnavailable(error))) throw error;
        await block(forecastUnavailable);
      }
    },
    get: (key: string) => db.snapshot(scope, tx => getRetentionSlot(deps, tx, key)),
    listPosttests: (selected: string | null = null) => db.snapshot(scope, tx => listRetentionPosttests(deps, tx, selected)),
    reconcile: (forecastKey: string, input: Record<string, unknown>) => {
      const attemptId = requestInput(() => recordId(input.attemptId), fail);
      return write(async tx => reconcileRetentionAttempt(deps, tx, await currentForecast(tx, forecastKey), attemptId));
    },
    savePosttestPaper: (input: Record<string, unknown>) => write(tx => posttest.save(tx, input)),
    startPosttest: (forecastKey: string, input: Record<string, unknown>) => {
      if (Object.keys(input).length !== 0) throw new RequestError(400, '后测发放规格由服务端冻结。');
      return write(async tx => {
        const { opened, frozen, window } = await currentForecast(tx, forecastKey);
        if (!opened.sealed || opened.target.gradingVersion !== workbookGradingVersion) throw new RequestError(422, '普通卷面缺少完整帮助见证，须从受控冻结卷开始后测。');
        await requireFreshVariant(tx, frozen.value.input.target, await evidenceWatermark(tx), posttestIdFor(frozen.derivationId));
        return posttest.start(tx, { forecastId: frozen.derivationId, forecastKey: factId(forecastKey), effectiveTick: frozen.effectiveTick,
          paper: opened.target.paper, paperEpoch: opened.accessEpoch, itemId: opened.target.itemId, gradingVersion: opened.target.gradingVersion,
          through: window.through }, opened.paper, posttestOpensAt(window));
      });
    },
    activePosttest: async (tx: ReadTransaction, id: FactId) => {
      const { current, issuance, fact } = await currentPosttest(tx, id), now = new Date().toISOString();
      if (now < issuance.startedAt || now >= issuance.through) throw new RequestError(403, '后测发放已不在观察窗口内。');
      return { paper: current.opened.paper, mount: { paper: issuance.paper, epoch: issuance.paperEpoch, issuance: { id, rev: fact.ref.rev } } };
    },
    submitPosttest: (forecastKey: string, posttestId: string, input: Record<string, unknown>) => write(async tx => {
      const { current, issuance } = await currentPosttest(tx, factId(posttestId), forecastKey);
      const attemptId = await posttest.submit(tx, factId(posttestId), issuance, current.opened.paper, input);
      const result = await reconcileRetentionAttempt(deps, tx, current, attemptId);
      return { attemptId, reconciliation: { key: result.key, state: result.state } };
    }),
  };
}
