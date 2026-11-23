import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createLearnerHost, derivationId, factId, parseManifest, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { failWork, finishWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import { frozenInputs, frozenValue, readComparisonPlan, selectPair, validComparisonPlan, type RetentionComparisonDeps, type RetentionComparisonPlan } from '../../modules/activity/retention-host-support.ts';
import { retentionTeachingPurpose as retentionPurpose } from '../../modules/activity/retention-posttest.ts';
import { forecastType, readAnyRetentionMethod, reconciliationType, type RetentionForecast } from '../../modules/learner/retention.ts';
import { matchesRetentionComparisonPlan, parseRetentionComparisonStart, projectRetentionComparisonState } from '../../modules/learner/retention-slice.ts';
import { retentionComparisonCase, retentionComparisonReport, type RetentionReconciliation } from '../../modules/learner/retention-view.ts';
import { stableId, studioLearner } from './identity.ts';
import { evaluateStudioRetention, retentionHistoryValid } from './retention.ts';
import { clientRequest, RequestError } from './sessions.ts';

export const retentionComparisonWork = 'studio.retentionComparisonWork';
const retentionComparisonType = 'predict.retentionComparison', comparisonDeriver = 'learner/retention-comparison@1';
const deps: RetentionComparisonDeps = {
  RequestError, retentionPurpose, forecastType, reconciliationType, retentionComparisonWork,
  retentionHistoryValid: (tx, id, obs) => retentionHistoryValid(tx, id, obs),
};
const validPlan = (tx: ReadTransaction, plan: RetentionComparisonPlan, manifest = parseManifest(plan.manifest)) =>
  validComparisonPlan(deps, tx, plan, manifest);

export function openRetentionComparison(db: Db, pythonHost?: PythonDeriverHost) {
  const host = createLearnerHost(db, studioLearner);
  const get = (key: string) => host.snapshot(async tx => {
    const job = await readComparisonPlan(deps, tx, key);
    if (!job) throw new RequestError(404, '找不到保持方法对照。');
    const valid = await validPlan(tx, job.plan);
    const row = valid && job.state === 'satisfied'
      ? (await tx.query<{ value: unknown }>('SELECT value FROM derivations WHERE learner_id=$1 AND id=$2 AND slot_type=$3 AND is_shadow', [tx.learner, key, retentionComparisonType])).rows[0]
      : undefined;
    return projectRetentionComparisonState(key, job.state, valid, row);
  });
  return {
    get,
    async start(input: Record<string, unknown>) {
      const parsed = parseRetentionComparisonStart(input, m => Boolean(readAnyRetentionMethod(m)));
      if (!parsed) throw new RequestError(400, '请选择已注册的方法和 1–32 条不同的保持对账。');
      const { method, keys } = parsed, key = factId(stableId('retention-comparison', clientRequest(input.requestId)));
      await host.lockedTx(async tx => {
        const job = await readComparisonPlan(deps, tx, key);
        if (job) { if (!matchesRetentionComparisonPlan(job.plan, method, keys)) throw new RequestError(409, '保持方法对照标识已使用。'); return; }
        const pairs = await Promise.all(keys.map(item => selectPair(deps, tx, item)));
        await tx.withLearnerWrite(async tick => {
          const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: retentionPurpose, gatherTick: tick, inputs: pairs.flatMap(pair => frozenInputs(deps, pair)) });
          if (!await validPlan(tx, { method, pairs, manifest })) throw new RequestError(409, '保持对账的依据已变化。');
          await tx.insert('slot_state', { learner_id: tx.learner, slot_type: retentionComparisonWork, slot_key: key, scope_keys: canonicalJsonString({ method, pairs, manifest }), changed_tick: tick });
          await requestWork(tx, tick, { slotType: retentionComparisonWork, slotKey: key, deriver: comparisonDeriver });
        });
      });
      return get(key);
    },
    async execute(ref: WorkRef, key: string, terminal: boolean) {
      if (terminal) return failWork(db, ref);
      const frozen = await host.snapshot(async tx => {
        const job = await readComparisonPlan(deps, tx, key);
        if (!job) throw new Error('Retention comparison plan missing');
        const manifest = parseManifest(job.plan.manifest);
        if (!await validPlan(tx, job.plan, manifest)) return;
        const method = readAnyRetentionMethod(job.plan.method);
        if (!method) throw new Error('Retention comparison method missing');
        const pairs = await Promise.all(job.plan.pairs.map(async pair => ({
          pair, recorded: await frozenValue<RetentionForecast>(tx, pair.forecastId), outcome: await frozenValue<RetentionReconciliation>(tx, pair.reconciliationId),
        })));
        return { manifest, method, pairs, plan: job.plan };
      });
      if (!frozen) return finishWork(db, ref);
      const cases = [];
      for (const { pair, recorded, outcome } of frozen.pairs)
        cases.push(retentionComparisonCase(pair, recorded, await evaluateStudioRetention(frozen.method, recorded.input, pythonHost), outcome));
      const report = retentionComparisonReport(frozen.method, cases);
      return finishWork(db, ref, async tx => {
        if (!await validPlan(tx, frozen.plan, frozen.manifest)) return;
        await tx.insert('derivations', {
          learner_id: tx.learner, id: derivationId(key), slot_type: retentionComparisonType, slot_key: key, deriver: comparisonDeriver,
          scope_keys: '{}', value: canonicalJsonString(report), manifest: canonicalJsonString(frozen.manifest),
          lifecycle: 'candidate', freshness: 'current', gather_tick: frozen.manifest.gatherTick, is_shadow: true,
        });
      });
    },
  };
}
