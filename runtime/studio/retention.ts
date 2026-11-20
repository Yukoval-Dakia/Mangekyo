import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, factId, learnerId, type DerivationId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { GatherContext, GatherInput, Json, JsonObject, Outcome, Waiting } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { workbookRequestId } from '../../modules/activity/workbook-values.ts';
import forecast from '../../modules/learner/derivers/retention-forecast.ts';
import reconciliation from '../../modules/learner/derivers/retention-reconciliation.ts';
import forecastSlot from '../../modules/learner/slots/forecast.ts';
import reconciliationSlot from '../../modules/learner/slots/reconciliation.ts';
import type { RetentionForecast, RetentionObservation, RetentionTarget } from '../../modules/learner/retention.ts';
import { stableId, studioLearner } from './identity.ts';
import { openRetentionTarget, readWorkbookObservation, retentionPurpose } from './retention-workbook.ts';
import { RequestError } from './sessions.ts';

const forecastPolicy = { slot: forecastSlot, purpose: retentionPurpose, deriver: forecast.name + '@' + forecast.version };
const reconciliationPolicy = { slot: reconciliationSlot, purpose: retentionPurpose, deriver: reconciliation.name + '@' + reconciliation.version };
const propagation = createPropagationHooks([]);
const scope = { learner: studioLearner };
const forecastUnavailable = '预测的冻结依据已变化或不可读取。';

type ForecastScope = {
  target: RetentionTarget;
  paperEpoch: Tick;
  priorAttemptIds: FactId[];
  window: RetentionForecast['input']['window'];
};
type ReconciliationScope = { forecastKey: string; forecastId: DerivationId; attemptId: FactId };
type ReconciliationValue = Extract<Awaited<ReturnType<typeof reconciliation.derive>>, { kind: 'value' }>['value'];
type SlotRow<T, S> = {
  scope_keys: S;
  pending: string;
  last_id: string | null;
  last_error: { reason: string } | null;
  current_id: string | null;
  effective_tick: Tick | null;
  value: Outcome<T> | null;
  manifest: unknown;
};

async function findSlot<T, S>(tx: ReadTransaction, type: string, key: string) {
  const { rows: [row] } = await tx.query<SlotRow<T, S>>(
    `SELECT s.scope_keys, s.pending, s.last_id, s.last_error, d.id AS current_id, d.value, d.manifest, d.effective_tick::text
     FROM slot_state s LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       AND d.slot_type=s.slot_type AND d.slot_key=s.slot_key
       AND d.lifecycle='effective' AND d.invalidated_tick IS NULL AND NOT d.is_shadow
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
    [tx.learner, type, key],
  );
  return row;
}

async function project<T>(tx: ReadTransaction, key: string, row: SlotRow<T, unknown>) {
  if (row.current_id && row.effective_tick && row.value?.kind === 'value') {
    const manifest = parseManifest(row.manifest);
    const verdict = await revalidateManifest(tx, manifest, retentionPurpose);
    if (verdict.kind === 'valid') {
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

function deadline(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) throw new Error('需要 UTC 截止时间。');
  return value;
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
  if (BigInt(observation.admittedAt) <= BigInt(effectiveTick) ||
      observation.submittedAt < window.requestedAt || observation.submittedAt > window.through) {
    throw new RequestError(409, '这次交卷不在预测冻结后的观察窗口内。');
  }
}

async function enqueue(tx: DbTransaction, policy: CandidatePolicy, key: string, scopeKeys: JsonObject) {
  await tx.withLearnerWrite(async tick => {
    await tx.query(
      `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tx.learner, policy.slot.type, key, canonicalJsonString(scopeKeys), tick],
    );
    await requestWork(tx, tick, { slotType: policy.slot.type, slotKey: key, deriver: policy.deriver });
  });
}

function sameTarget(actual: Awaited<ReturnType<typeof openRetentionTarget>>, expected: ForecastScope) {
  if (canonicalJsonString(actual.target) !== canonicalJsonString(expected.target) || actual.accessEpoch !== expected.paperEpoch) {
    throw new RequestError(409, forecastUnavailable);
  }
}

function gatherInSnapshot(
  db: Db, learner: typeof studioLearner,
  gather: (tx: ReadTransaction, ctx: GatherContext) => GatherInput<Json> | Waiting | Promise<GatherInput<Json> | Waiting>,
) {
  // Activity audit metadata and tracked kernel inputs must come from one snapshot.
  const scope = { learner, purpose: retentionPurpose };
  return db.snapshot(scope, tx => gatherSnapshot({ ...db, snapshot: (_, read) => read(tx) }, scope, ctx => gather(tx, ctx)));
}

export function openRetention(db: Db) {
  async function freeze(paperId: string, input: Record<string, unknown>) {
    const { requestId, itemId, priorAttemptIds, through } = requestInput(() => {
      const { requestId, itemId, priorAttemptIds = [], through } = input;
      if (typeof itemId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(itemId) ||
          !Array.isArray(priorAttemptIds) || priorAttemptIds.length > 10 ||
          new Set(priorAttemptIds).size !== priorAttemptIds.length) throw new Error();
      return { requestId: workbookRequestId(requestId), itemId, priorAttemptIds: priorAttemptIds.map(recordId).sort(),
        through: deadline(through) };
    });
    const id = factId(paperId);
    const key = forecastSlot.key({ forecastId: stableId('retention-forecast', id, requestId) });
    return authorized(() => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const existing = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, key);
      if (existing) {
        const stored = existing.scope_keys;
        if (stored.target.itemId !== itemId || stored.window.through !== through ||
            canonicalJsonString(stored.priorAttemptIds) !== canonicalJsonString(priorAttemptIds)) {
          throw new RequestError(409, '预测请求标识已使用。');
        }
        return project(tx, key, existing);
      }
      const requestedAt = new Date().toISOString();
      if (through <= requestedAt) throw new RequestError(400, '预测截止时间须晚于当前。');
      const read = createCommandReadContext(tx, retentionPurpose);
      const opened = await openRetentionTarget(read, id, itemId);
      for (const attemptId of priorAttemptIds) await readWorkbookObservation(tx, read, opened, attemptId);
      await enqueue(tx, forecastPolicy, key, {
        target: opened.target, paperEpoch: opened.accessEpoch, priorAttemptIds, window: { requestedAt, through },
      });
      return { key, state: 'pending' as const };
    }));
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

  async function reconcile(forecastKey: string, input: Record<string, unknown>) {
    const attemptId = requestInput(() => recordId(input.attemptId));
    return authorized(() => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const row = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, forecastKey);
      if (!row) throw new RequestError(404, '找不到保持预测。');
      const frozen = await project(tx, forecastKey, row);
      if (frozen.state !== 'current') throw new RequestError(409, '预测当前没有可用的冻结版本。');
      const read = createCommandReadContext(tx, retentionPurpose);
      const { target, window } = row.scope_keys;
      const opened = await openRetentionTarget(read, target.paper.id, target.itemId);
      sameTarget(opened, row.scope_keys);
      const observation = await readWorkbookObservation(tx, read, opened, attemptId);
      afterFreeze(observation, window, frozen.effectiveTick);
      const key = reconciliationSlot.key({ reconciliationId: stableId('retention-reconcile', frozen.derivationId, attemptId) });
      const existing = await findSlot<ReconciliationValue, ReconciliationScope>(tx, reconciliationSlot.type, key);
      if (existing) {
        const latest = await project(tx, key, existing);
        if (existing.pending !== 'none') return { key, state: 'pending' as const };
        if (latest.state === 'current' &&
            canonicalJsonString(latest.value.observation) === canonicalJsonString(observation)) return latest;
      }
      await enqueue(tx, reconciliationPolicy, key, { forecastKey, forecastId: frozen.derivationId, attemptId });
      return { key, state: 'pending' as const };
    }));
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
        if (work.slotType === forecastSlot.type) return forecast.gather(ctx, async ({ read }) => {
          const slot = await findSlot<RetentionForecast, ForecastScope>(tx, forecastSlot.type, work.slotKey);
          if (!slot) throw new Error('Forecast work is missing slot scope');
          const { target, window, priorAttemptIds } = slot.scope_keys;
          const opened = await openRetentionTarget(read, target.paper.id, target.itemId);
          sameTarget(opened, slot.scope_keys);
          const observations = [];
          for (const id of priorAttemptIds) observations.push(await readWorkbookObservation(tx, read, opened, id));
          observations.sort((a, b) => BigInt(a.admittedAt) < BigInt(b.admittedAt) ? -1 : 1);
          return { target, window, observations };
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
          const opened = await openRetentionTarget(read, target.paper.id, target.itemId);
          sameTarget(opened, row.scope_keys);
          const observation = await readWorkbookObservation(tx, read, opened, attemptId);
          afterFreeze(observation, window, frozen.effectiveTick);
          return { forecastId, forecast: frozen.value, observation };
        });
      });
      const sealed = await sealCandidate(db, ref, policy, gathered);
      if (sealed.kind !== 'sealed') return;
      if (work.slotType === forecastSlot.type) {
        const input = sealed.plan.data as RetentionForecast['input'];
        const result = new Date().toISOString() < input.window.through ? forecast.derive(input)
          : { kind: 'failed', reason: '观察窗口在预测冻结前已结束。' };
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

  return { freeze, get, reconcile, execute };
}

export function isRetentionSlot(type: string) {
  return type === forecastSlot.type || type === reconciliationSlot.type;
}
