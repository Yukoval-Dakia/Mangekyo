import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { withLearnerLock } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, factId, learnerId, type DerivationId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { GatherContext, GatherInput, Json, JsonObject, ReadContext, Waiting } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  insideFrozenPosttestWindow, matchesCurrentPosttest, posttestOpensAt, posttestSubmissionType,
  retentionFollowupRequest, retentionFreezeRequest,
} from '../../modules/activity/retention-posttest.ts';
import {
  findWorkbookRetentionSlot as findSlot, workbookEvidenceWatermark as evidenceWatermark, listWorkbookPosttestSlots,
  type SlotRow, type PosttestListItem, recordedWorkbookForecast, validWorkbookMethod, verifiesOriginalSitting, verifyFrozenWorkbookClaims,
} from '../../modules/activity/retention-history.ts';
import { activityEvidenceSlice, type ActivityEvidenceObservation } from '../../modules/activity/evidence-slice.ts';
import { throughTick, validatesWorkbookHistory, workbookWitnessesBy, workbookReadAtWatermark } from '../../modules/activity/evidence-read.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readWork, requestCatalogedWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { sameWorkbookJson, workbookGradingVersion } from '../../modules/activity/workbook-values.ts';
import forecast from '../../modules/learner/derivers/retention-forecast.ts';
import reconciliation from '../../modules/learner/derivers/retention-reconciliation.ts';
import forecastSlot from '../../modules/learner/slots/forecast.ts';
import reconciliationSlot from '../../modules/learner/slots/reconciliation.ts';
import {
  defaultRetentionMethod, evaluateFrozenRetention, readAnyRetentionMethod,
  type RetentionForecast, type RetentionObservation, type RetentionTarget,
} from '../../modules/learner/retention.ts';
import { againstFrozenTarget } from '../../modules/learner/retention-view.ts';
import { createPythonDeriverHost, type PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import type { CognitionResult } from '../../executors/python-deriver/schema.ts';
import { stableId, studioLearner } from './identity.ts';
import { posttestAttemptFor, posttestIdFor, posttestWriter, readPosttestIssuance } from './retention-posttest.ts';
import {
  openRetentionTarget, readComparableWorkbookEvidence, readItemDimensions, readWorkbookObservation, retentionPurpose,
} from './retention-workbook.ts';
import { RequestError } from './sessions.ts';

const forecastPolicy = { slot: forecastSlot, purpose: retentionPurpose, deriver: forecast.name + '@' + forecast.version };
const reconciliationPolicy = { slot: reconciliationSlot, purpose: retentionPurpose, deriver: reconciliation.name + '@' + reconciliation.version };
const propagation = createPropagationHooks([]);
const scope = { learner: studioLearner };
const forecastUnavailable = '预测的冻结依据已变化或不可读取。';

type ForecastScope = {
  target: RetentionTarget;
  method?: string;
  paperEpoch: Tick;
  evidenceThrough?: Tick;
  priorAttemptIds: FactId[];
  window: RetentionForecast['input']['window'];
  sourceReconciliationKey?: string;
};
type ReconciliationScope = { forecastKey: string; forecastId: DerivationId; attemptId: FactId };
type ReconciliationValue = Extract<Awaited<ReturnType<typeof reconciliation.derive>>, { kind: 'value' }>['value'];
export async function retentionHistoryValid(tx: ReadTransaction, id: DerivationId, observation?: RetentionObservation) {
  const row = await recordedWorkbookForecast(tx, forecastSlot.type, id);
  if (!row || !validWorkbookMethod(row.forecast, readAnyRetentionMethod)) return false;
  const { input } = row.forecast;
  if (!await validatesWorkbookHistory(tx, input.target, observation?.admittedAt ?? row.effective_tick, posttestIdFor(id),
    observation?.exposure.kind === 'independent')) return false;
  const read = createCommandReadContext(tx, retentionPurpose);
  const unavailable = (error: unknown) => error instanceof RequestError ||
    error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
  if (observation?.exposure.kind === 'exposed') {
    try {
      const opened = await openRetentionTarget(tx,read,input.target.paper.id,input.target.itemId);
      const actual = await readWorkbookObservation(tx,read,opened,observation.submission.id,id);
      if (actual.submission.rev !== observation.submission.rev || actual.admittedAt !== observation.admittedAt ||
          actual.exposure.kind !== 'exposed' || !sameWorkbookJson(actual.exposure.refs,observation.exposure.refs)) return false;
    } catch (error) {
      if (unavailable(error)) return false;
      throw error;
    }
  }
  return verifyFrozenWorkbookClaims(tx, row, read, parseManifest(row.manifest).inputs,
    async (read, cutoff) => {
      const target = await openRetentionTarget(tx, read, input.target.paper.id, input.target.itemId);
      if (target.target.paper.rev !== input.target.paper.rev || target.target.gradingVersion !== input.target.gradingVersion) return;
      return async attemptId => {
        const found = await readComparableWorkbookEvidence(tx, read, target, attemptId, cutoff);
        const valid = await verifiesOriginalSitting(tx, forecastSlot.type, found.evidence,
          readAnyRetentionMethod, posttestIdFor, posttestAttemptFor);
        return valid ? found : undefined;
      };
    }, unavailable);
}

async function project<T extends RetentionForecast | ReconciliationValue>(tx: ReadTransaction, key: string, row: SlotRow<T, unknown>) {
  if (row.current_id && row.effective_tick && row.value?.kind === 'value') {
    const manifest = parseManifest(row.manifest);
    const verdict = await revalidateManifest(tx, manifest, retentionPurpose);
    const value = row.value.value;
    if (verdict.kind === 'valid' && ('observation' in value
      ? await retentionHistoryValid(tx, value.forecastId, value.observation)
      : await retentionHistoryValid(tx, derivationId(row.current_id)))) {
      return { key, state: 'current' as const, derivationId: derivationId(row.current_id),
        effectiveTick: row.effective_tick, freshness: verdict.freshness, value: row.value.value, basis: manifest };
    }
    return { key, state: 'stale' as const, reason: forecastUnavailable };
  }
  if (row.last_id) return { key, state: 'stale' as const, reason: forecastUnavailable };
  if (row.last_error) return { key, state: 'blocked' as const, reason: row.last_error.reason };
  return { key, state: 'pending' as const };
}

function requestInput<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new RequestError(400, '保持预测请求格式无效。'); }
}

function recordId(value: unknown) {
  if (typeof value !== 'string') throw new Error('需要记录标识。');
  return factId(value);
}

async function authorized<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (error instanceof FactNotFoundError) throw new RequestError(404, '找不到保持预测的依据。');
    if (error instanceof FactReadDeniedError) throw new RequestError(403, '保持预测的依据当前未开放教学用途。');
    throw error;
  }
}

function afterFreeze(observation: RetentionObservation, window: ForecastScope['window'], effectiveTick: Tick) {
  if (!insideFrozenPosttestWindow(observation, window, effectiveTick)) {
    throw new RequestError(409, '这次交卷不在预测冻结后的观察窗口内。');
  }
}

function requireIndependentPosttest(observation: RetentionObservation) {
  if (observation.exposure.kind !== 'independent' || observation.result === 'unknown') {
    throw new RequestError(422, '需要有判分结果的独立受控后测，才能安排下一次后测。');
  }
}

async function enqueue(tx: DbTransaction, policy: CandidatePolicy, key: string, scopeKeys: JsonObject) {
  await tx.withLearnerWrite(tick => requestCatalogedWork(tx,tick,
    {slotType:policy.slot.type,slotKey:key,deriver:policy.deriver},canonicalJsonString(scopeKeys),{reuseSlot:true}));
}

function sameTarget(actual: Awaited<ReturnType<typeof openRetentionTarget>>, expected: ForecastScope) {
  if (canonicalJsonString({ ...actual.target, condition: expected.target.condition }) !== canonicalJsonString(expected.target) ||
      actual.accessEpoch !== expected.paperEpoch) {
    throw new RequestError(409, forecastUnavailable);
  }
}

function reconciliationKeyFor(forecast: DerivationId, attempt: FactId) {
  return reconciliationSlot.key({ reconciliationId: stableId('retention-reconcile', forecast, attempt) });
}

function gatherInSnapshot(
  db: Db, learner: typeof studioLearner,
  gather: (tx: ReadTransaction, ctx: GatherContext) => GatherInput<Json> | Waiting | Promise<GatherInput<Json> | Waiting>,
) {
  // Activity audit metadata and tracked kernel inputs must come from one snapshot.
  const scope = { learner, purpose: retentionPurpose };
  return db.snapshot(scope, tx => gatherSnapshot({ ...db, snapshot: (_, read) => read(tx) }, scope, ctx => gather(tx, ctx)));
}

const legacyRetentionMethod = 'last-independent-result@1';
let defaultHost: PythonDeriverHost | undefined;

export async function evaluateStudioRetention(method: NonNullable<ReturnType<typeof readAnyRetentionMethod>>,
  input: RetentionForecast['input'], host?: PythonDeriverHost) {
  return evaluateFrozenRetention(method, input, async (slice, version) => {
    const selected = readAnyRetentionMethod(version);
    if (!selected || !('deriver' in selected)) throw new Error('未登记的 Python 保持力方法。');
    const response = await (host ?? (defaultHost ??= createPythonDeriverHost())).derive(selected.deriver, slice);
    if (response.kind === 'failed') throw new Error(response.reason);
    if (response.outcome.kind !== 'value') throw new Error('Python 保持力方法未返回计算结果。');
    return response.outcome.value as CognitionResult;
  });
}

async function requireFreshVariant(tx: ReadTransaction, target: RetentionTarget, cutoff: Tick, issuance?: FactId) {
  if (!await validatesWorkbookHistory(tx, target, throughTick(cutoff), issuance)) {
    throw new RequestError(409, '当前不能按新变式发放或记录此题。');
  }
}

export function openRetention(db: Db, activity: LoadedModule, method = defaultRetentionMethod,
  host?: PythonDeriverHost) {
  const configured = readAnyRetentionMethod(method);
  if (!configured) throw new Error('保持方法配置无效：' + method);
  const supportsVariant = 'deriver' in configured;
  const posttest = posttestWriter(db, activity);

  function write<T>(run: (tx: DbTransaction) => Promise<T>) {
    return authorized(() => withLearnerLock(db, scope, run));
  }

  async function enqueueForecast(
    tx: DbTransaction, key: string, opened: Awaited<ReturnType<typeof openRetentionTarget>>,
    plan: Pick<ForecastScope, 'priorAttemptIds' | 'window' | 'sourceReconciliationKey'>,
    condition: RetentionTarget['condition'] = opened.target.condition,
  ) {
    await enqueue(tx, forecastPolicy, key, {
      target: { ...opened.target, condition }, method, paperEpoch: opened.accessEpoch,
      evidenceThrough: await evidenceWatermark(tx), ...plan,
    });
    return { key, state: 'pending' as const };
  }

  async function freeze(paperId: string, input: Record<string, unknown>) {
    const { requestId, itemId, priorAttemptIds, through, condition } = requestInput(() => retentionFreezeRequest(input));
    const id = factId(paperId);
    const key = forecastSlot.key({ forecastId: stableId('retention-forecast', id, requestId) });
    return write(async tx => {
      const existing = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
      if (existing) {
        const stored = existing.scope_keys;
        if (stored.target.itemId !== itemId || stored.target.condition !== condition || stored.window.through !== through ||
            canonicalJsonString(stored.priorAttemptIds) !== canonicalJsonString(priorAttemptIds)) {
          throw new RequestError(409, '预测请求标识已使用。');
        }
        return project(tx, key, existing);
      }
      const requestedAt = new Date().toISOString();
      if (through <= requestedAt) throw new RequestError(400, '预测截止时间须晚于当前。');
      const read = createCommandReadContext(tx, retentionPurpose);
      const opened = await openRetentionTarget(tx, read, id, itemId);
      const cutoff = await evidenceWatermark(tx);
      await requireFreshVariant(tx, { ...opened.target, condition }, cutoff);
      let witnessedVariant = false;
      for (const attemptId of priorAttemptIds) {
        const { evidence, novelty } = await readComparableWorkbookEvidence(tx, read, opened, attemptId, cutoff);
        witnessedVariant ||= novelty === 'isomorphic';
        if (evidence.observation.submittedAt > requestedAt) throw new RequestError(422, '交卷时间晚于预测发起时间。');
      }
      if (condition === 'variant' && (!opened.sealed || !witnessedVariant || !supportsVariant)) {
        throw new RequestError(422, '变式保持预测需要受控题、有依据的变式交卷及支持变式的方法。');
      }
      return enqueueForecast(tx, key, opened, { priorAttemptIds, window: { requestedAt, through } }, condition);
    });
  }

  async function get(key: string) {
    return db.snapshot(scope, async tx => {
      const forecast = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
      if (forecast) return { slot: forecastSlot.type, ...await project(tx, key, forecast) };
      const reconciliation = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, key);
      if (reconciliation) return { slot: reconciliationSlot.type, ...await project(tx, key, reconciliation) };
      throw new RequestError(404, '找不到保持预测或对账记录。');
    });
  }

  async function currentForecast(tx: ReadTransaction, key: string) {
    const row = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
    if (!row) throw new RequestError(404, '找不到保持预测。');
    const frozen = await project(tx, key, row);
    if (frozen.state !== 'current') throw new RequestError(409, '预测当前没有可用的冻结版本。');
    const read = createCommandReadContext(tx, retentionPurpose);
    const { target, window, sourceReconciliationKey } = row.scope_keys;
    if (sourceReconciliationKey) await currentReconciliation(tx, sourceReconciliationKey);
    const opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
    sameTarget(opened, row.scope_keys);
    return { frozen, read, window, opened, sourceReconciliationKey };
  }

  async function currentReconciliation(tx: ReadTransaction, key: string) {
    const source = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, key);
    if (!source) throw new RequestError(404, '找不到原后测对账记录。');
    const current = await project(tx, key, source);
    if (current.state !== 'current') throw new RequestError(409, '原后测当前没有可用的对账记录。');
    return source.scope_keys;
  }

  async function scheduleFollowup(reconciliationKey: string, input: Record<string, unknown>) {
    const { requestId, scheduledAt, through } = requestInput(() => retentionFollowupRequest(input));
    const key = forecastSlot.key({ forecastId: stableId('retention-followup', reconciliationKey, requestId) });
    return write(async tx => {
      const existing = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
      if (existing) {
        if (existing.scope_keys.window.scheduledAt !== scheduledAt) throw new RequestError(409, '后测安排请求标识已使用。');
        const { state } = await project(tx, key, existing);
        return { key, state };
      }
      const requestedAt = new Date().toISOString();
      if (scheduledAt <= requestedAt) throw new RequestError(400, '后测安排时间须晚于当前。');
      const { forecastKey, forecastId, attemptId } = await currentReconciliation(tx, reconciliationKey);
      const { frozen, opened, read, window } = await currentForecast(tx, forecastKey);
      if (!opened.sealed || frozen.derivationId !== forecastId || attemptId !== posttestAttemptFor(posttestIdFor(forecastId))) {
        throw new RequestError(422, '只能从原受控后测的交卷安排下一次后测。');
      }
      const observation = await readWorkbookObservation(tx, read, opened, attemptId, forecastId);
      afterFreeze(observation, window, frozen.effectiveTick);
      requireIndependentPosttest(observation);
      return enqueueForecast(tx, key, opened, {
        priorAttemptIds: [attemptId], window: { requestedAt, scheduledAt, through }, sourceReconciliationKey: reconciliationKey,
      });
    });
  }

  async function listPosttests(selected: string | null = null) {
    return db.snapshot(scope, async tx => {
      const readRows = (forecastKey: string | null, parent: string | null) =>
        listWorkbookPosttestSlots<ForecastScope>(tx,forecastSlot.type,forecastKey,parent);
      const initial = await readRows(selected, null);
      const rows = [...initial.rows];
      const now = new Date().toISOString();
      const items: PosttestListItem[] = [];
      for (const { slot_key: forecastKey, scope_keys: scheduled, current_id: currentId } of rows) {
        try {
          if (!currentId) {
            const { target, sourceReconciliationKey, window: { scheduledAt, through } } = scheduled;
            if (!sourceReconciliationKey || !scheduledAt || through <= now) continue;
            await currentReconciliation(tx, sourceReconciliationKey);
            const read = createCommandReadContext(tx, retentionPurpose);
            const opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
            sameTarget(opened, scheduled);
            items.push({ forecastKey, title: opened.paper.title, through, scheduledAt, sourceReconciliationKey, state: 'preparing' });
            continue;
          }
          const { frozen, opened, read, window, sourceReconciliationKey } = await currentForecast(tx, forecastKey);
          const { scheduledAt, through } = window;
          const entry = { forecastKey, title: opened.paper.title, through, ...(scheduledAt ? { scheduledAt } : {}),
            ...(sourceReconciliationKey ? { sourceReconciliationKey } : {}) };
          const attemptId = posttestAttemptFor(posttestIdFor(frozen.derivationId));
          try {
            const attempt = await read.fact(attemptId, { mode: 'following' });
            if (attempt.type === posttestSubmissionType) {
              const reconciliationKey = reconciliationKeyFor(frozen.derivationId, attemptId);
              items.push({ ...entry, state: 'submitted', reconciliationKey });
              if (forecastKey === selected) {
                const followups = await readRows(null, reconciliationKey);
                rows.push(...followups.rows.filter(child => child.slot_key !== selected));
              }
            }
          } catch (error) {
            if (!(error instanceof FactNotFoundError)) throw error;
            await requireFreshVariant(tx, frozen.value.input.target, await evidenceWatermark(tx), posttestIdFor(frozen.derivationId));
            if (scheduledAt && now < scheduledAt) items.push({ ...entry, state: 'scheduled', scheduledAt });
            else if (posttestOpensAt(window) <= now && now < through) items.push({ ...entry, state: 'ready' });
          }
        } catch (error) {
          if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError || error instanceof RequestError)) throw error;
        }
      }
      return { items };
    });
  }

  async function reconcileAttempt(tx: DbTransaction, current: Awaited<ReturnType<typeof currentForecast>>, attemptId: FactId) {
    const { frozen, read, window, opened } = current;
    const observation = againstFrozenTarget(await readWorkbookObservation(tx, read, opened, attemptId, frozen.derivationId),
      frozen.value.input.target);
    afterFreeze(observation, window, frozen.effectiveTick);
    if (!await retentionHistoryValid(tx, frozen.derivationId, observation)) throw new RequestError(409, forecastUnavailable);
    const key = reconciliationKeyFor(frozen.derivationId, attemptId);
    const existing = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, key);
    if (existing) {
      const latest = await project(tx, key, existing);
      if (existing.pending !== 'none') return { key, state: 'pending' as const };
      if (latest.state === 'current' &&
          canonicalJsonString(latest.value.observation) === canonicalJsonString(observation)) return latest;
    }
    await enqueue(tx, reconciliationPolicy, key, { forecastKey: frozen.key, forecastId: frozen.derivationId, attemptId });
    return { key, state: 'pending' as const };
  }

  async function reconcile(forecastKey: string, input: Record<string, unknown>) {
    const attemptId = requestInput(() => recordId(input.attemptId));
    return write(async tx => reconcileAttempt(tx, await currentForecast(tx, forecastKey), attemptId));
  }

  async function startPosttest(forecastKey: string, input: Record<string, unknown>) {
    if (Object.keys(input).length !== 0) throw new RequestError(400, '后测发放规格由服务端冻结。');
    return write(async tx => {
      const { opened, frozen, window } = await currentForecast(tx, forecastKey);
      if (!opened.sealed || opened.target.gradingVersion !== workbookGradingVersion) {
        throw new RequestError(422, '普通卷面缺少完整帮助见证，须从受控冻结卷开始后测。');
      }
      await requireFreshVariant(tx, frozen.value.input.target, await evidenceWatermark(tx), posttestIdFor(frozen.derivationId));
      return posttest.start(tx, {
        forecastId: frozen.derivationId, forecastKey: factId(forecastKey), effectiveTick: frozen.effectiveTick,
        paper: opened.target.paper, paperEpoch: opened.accessEpoch, itemId: opened.target.itemId,
        gradingVersion: opened.target.gradingVersion, through: window.through,
      }, opened.paper, posttestOpensAt(window));
    });
  }

  async function currentPosttest(tx: ReadTransaction, id: FactId, expectedKey?: string) {
    const { fact, issuance } = await readPosttestIssuance(tx, createCommandReadContext(tx,retentionPurpose), id);
    if (expectedKey !== undefined && issuance.forecastKey !== expectedKey) throw new RequestError(404,'后测不属于该预测。');
    const current = await currentForecast(tx,issuance.forecastKey);
    if (id !== posttestIdFor(current.frozen.derivationId) || !matchesCurrentPosttest(issuance,current))
      throw new RequestError(409,forecastUnavailable);
    await requireFreshVariant(tx,current.frozen.value.input.target,await evidenceWatermark(tx),id);
    return { current, issuance, fact };
  }

  async function activePosttest(tx: ReadTransaction, id: FactId) {
    const { current, issuance, fact } = await currentPosttest(tx,id);
    const now = new Date().toISOString();
    if (now < issuance.startedAt || now >= issuance.through) throw new RequestError(403,'后测发放已不在观察窗口内。');
    return { paper:current.opened.paper,
      mount:{paper:issuance.paper,epoch:issuance.paperEpoch,issuance:{id,rev:fact.ref.rev}} };
  }

  async function submitPosttest(forecastKey: string, posttestId: string, input: Record<string, unknown>) {
    return write(async tx => {
      const { current, issuance } = await currentPosttest(tx,factId(posttestId),forecastKey);
      const { opened } = current;
      const attemptId = await posttest.submit(tx, factId(posttestId), issuance, opened.paper, input);
      const result = await reconcileAttempt(tx, current, attemptId);
      return { attemptId, reconciliation: { key: result.key, state: result.state } };
    });
  }

  async function execute(ref: WorkRef, terminal: boolean) {
    const work = await readWork(db, ref);
    if (!work) return;
    const policy = work.slotType === forecastSlot.type ? forecastPolicy
      : work.slotType === reconciliationSlot.type ? reconciliationPolicy : undefined;
    if (!policy || work.deriver !== policy.deriver) return;
    const learner = learnerId(ref.learner);
    const block = (reason: string) => failWork(db, ref, async tx => {
      await tx.query('UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [tx.learner, work.slotType, work.slotKey, JSON.stringify({ status: 'blocked', reason })]);
    });
    if (terminal) { await block('保持推导执行失败。'); return; }
    try {
      const gathered = await gatherInSnapshot(db, learner, (tx, ctx) => {
        if (work.slotType === forecastSlot.type) return forecast.gather(ctx, async () => {
          const slot = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, work.slotKey);
          if (!slot) throw new Error('Forecast work is missing slot scope');
          const { target, window, priorAttemptIds, evidenceThrough } = slot.scope_keys;
          const cutoff = evidenceThrough ?? ctx.snapshotTick;
          const read = workbookReadAtWatermark(tx,createCommandReadContext(tx,retentionPurpose),ctx.read,cutoff,
            () => new FactReadDeniedError('changed','预测发起时该修订还不可见。'));
          const opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
          sameTarget(opened, slot.scope_keys);
          await requireFreshVariant(tx, target, ctx.snapshotTick);
          const observations: RetentionObservation[] = [];
          const evidenceRows: ActivityEvidenceObservation[] = [];
          const targetDimensions = await readItemDimensions(tx, read, opened.question.sourceQuestionRef, cutoff);
          for (const id of priorAttemptIds) {
            const comparable = await readComparableWorkbookEvidence(tx, read, opened, id, cutoff);
            const { evidence, novelty } = comparable;
            const { observation, process } = evidence;
            if (observation.submittedAt > window.requestedAt || BigInt(evidence.recordedAt) > BigInt(cutoff)) {
              throw new RequestError(409, '交卷在预测发起时尚未登记。');
            }
            if (window.scheduledAt) requireIndependentPosttest(observation);
            if (novelty === 'same') observations.push(observation);
            const dimensions = novelty === 'same' ? targetDimensions
              : await readItemDimensions(tx, read, comparable.opened.question.sourceQuestionRef, cutoff);
            evidenceRows.push({
              submission: observation.submission, occurredAt: observation.submittedAt,
              concepts: dimensions, novelty, helpLevel: process.helpLevel, result: observation.result,
              ...(observation.result === 'unknown' ? {} : { score: observation.scoreNorm ?? (observation.result === 'correct' ? 1 : 0) }),
              ...(observation.errorStage === undefined ? {} : { errorStage: observation.errorStage }), ...(evidence.duration === undefined ? {} : { duration: evidence.duration }),
            });
          }
          observations.sort((a, b) => BigInt(a.admittedAt) < BigInt(b.admittedAt) ? -1 : 1);
          const canonicalEvidence = activityEvidenceSlice(ctx.snapshotTick, window.requestedAt,
            { ref: target.paper.id, at: window.through }, evidenceRows);
          const [kcId] = targetDimensions;
          return {
            target: kcId && targetDimensions.length === 1 ? { ...target, dimensions: { kcId } } : target,
            window, observations, canonicalEvidence, method: slot.scope_keys.method ?? legacyRetentionMethod,
          };
        });
        return reconciliation.gather(ctx, async ({ read }) => {
          const slot = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, work.slotKey);
          if (!slot) throw new Error('Reconciliation work is missing slot scope');
          const { forecastKey, forecastId, attemptId } = slot.scope_keys;
          const row = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, forecastKey);
          if (!row) throw new RequestError(409, forecastUnavailable);
          const frozen = await project(tx, forecastKey, row);
          if (frozen.state !== 'current' || frozen.derivationId !== forecastId) throw new RequestError(409, forecastUnavailable);
          await read.slot({ learner, type: forecastSlot.type, key: forecastKey }, { mode: 'following' });
          const { target, window } = row.scope_keys;
          const opened = await openRetentionTarget(tx, read, target.paper.id, target.itemId);
          sameTarget(opened, row.scope_keys);
          const observation = againstFrozenTarget(await readWorkbookObservation(tx, read, opened, attemptId, forecastId),
            frozen.value.input.target);
          afterFreeze(observation, window, frozen.effectiveTick);
          if (!await retentionHistoryValid(tx, forecastId, observation)) throw new RequestError(409, forecastUnavailable);
          return { forecastId, forecast: frozen.value, observation };
        });
      });
      const sealed = await sealCandidate(db, ref, policy, gathered);
      if (sealed.kind !== 'sealed') return;
      if (work.slotType === forecastSlot.type) {
        const { method, ...input } = sealed.plan.data as Parameters<typeof forecast.derive>[0];
        const selected = readAnyRetentionMethod(method ?? legacyRetentionMethod);
        if (!selected) { await block('冻结预测使用了未知的保持方法。'); return; }
        const result = new Date().toISOString() < input.window.through
          ? { kind: 'value' as const, value: await evaluateStudioRetention(selected, input, host) }
          : { kind: 'failed' as const, reason: '观察窗口在预测冻结前已结束。' };
        await submitCandidate(db, ref, policy, sealed.id, result, propagation);
      } else {
        const input = sealed.plan.data as Parameters<typeof reconciliation.derive>[0];
        await submitCandidate(db, ref, policy, sealed.id, reconciliation.derive(input), propagation);
      }
    } catch (error) {
      if (!(error instanceof RequestError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      await block(forecastUnavailable);
    }
  }

  return { activePosttest, freeze, scheduleFollowup, get, reconcile, execute, listPosttests,
    savePosttestPaper: (input: Record<string, unknown>) => write(tx => posttest.save(tx, input)), startPosttest, submitPosttest };
}

export function isRetentionSlot(type: string) {
  return type === forecastSlot.type || type === reconciliationSlot.type;
}
