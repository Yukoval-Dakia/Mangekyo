import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, factId } from '../../kernel/src/declarations/ids.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { failWork, finishWork, requestWork, type WorkRef } from '../../kernel/src/work/index.ts';
import {
  frozenInputs, frozenValue, readComparisonPlan, selectPair, validComparisonPlan,
  type RetentionComparisonDeps, type RetentionComparisonPlan, type RetentionPair,
} from '../../modules/activity/retention-host-support.ts';
import { forecastType, readAnyRetentionMethod, reconciliationType, type RetentionForecast } from '../../modules/learner/retention.ts';
import { retentionComparisonCase, retentionComparisonReport, type RetentionReconciliation } from '../../modules/learner/retention-view.ts';
import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { stableId, studioLearner } from './identity.ts';
import { retentionPurpose } from './retention-workbook.ts';
import { evaluateStudioRetention, retentionHistoryValid } from './retention.ts';
import { clientRequest, RequestError } from './sessions.ts';

export const retentionComparisonWork = 'studio.retentionComparisonWork';
const retentionComparisonType = 'predict.retentionComparison';
const comparisonDeriver = 'learner/retention-comparison@1';
const scope = { learner: studioLearner };

const deps: RetentionComparisonDeps = {
  RequestError, retentionPurpose, forecastType, reconciliationType, retentionComparisonWork, retentionHistoryValid,
};
const readPlan = (tx: ReadTransaction, key: string) => readComparisonPlan(deps, tx, key);
const validPlan = (tx: ReadTransaction, plan: RetentionComparisonPlan, manifest = parseManifest(plan.manifest)) =>
  validComparisonPlan(deps, tx, plan, manifest);

export function openRetentionComparison(db: Db, pythonHost?: PythonDeriverHost) {
  async function get(key: string) {
    return db.snapshot(scope, async tx => {
      const job = await readPlan(tx, key);
      if (!job) throw new RequestError(404, '找不到保持方法对照。');
      if (!await validPlan(tx, job.plan))
        return { key, state: 'stale' as const };
      if (job.state === 'blocked') return { key, state: 'blocked' as const };
      if (job.state !== 'satisfied') return { key, state: 'pending' as const };
      const { rows: [row] } = await tx.query<{ value: unknown }>(
        `SELECT value FROM derivations WHERE learner_id=$1 AND id=$2 AND slot_type=$3 AND is_shadow`,
        [tx.learner, key, retentionComparisonType],
      );
      return row ? { key, state: 'complete' as const, ...row } : { key, state: 'stale' as const };
    });
  }

  return {
    get,
    async start(input: Record<string, unknown>) {
      const { method, reconciliationKeys } = input;
      if (typeof method !== 'string' || !readAnyRetentionMethod(method) ||
          !Array.isArray(reconciliationKeys) || !reconciliationKeys.length || reconciliationKeys.length > 32 ||
          reconciliationKeys.some(key => typeof key !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(key)) ||
          new Set(reconciliationKeys).size !== reconciliationKeys.length)
        throw new RequestError(400, '请选择已注册的方法和 1–32 条不同的保持对账。');
      const keys = [...reconciliationKeys].sort() as string[];
      const key = factId(stableId('retention-comparison', clientRequest(input.requestId)));
      await db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        const job = await readPlan(tx, key);
        if (job) {
          if (job.plan.method !== method || canonicalJsonString(job.plan.pairs.map(pair => pair.reconciliationKey)) !== canonicalJsonString(keys))
            throw new RequestError(409, '保持方法对照标识已使用。');
          return;
        }
        const pairs = await Promise.all(keys.map(item => selectPair(deps, tx, item)));
        await tx.withLearnerWrite(async tick => {
          const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: retentionPurpose,
            gatherTick: tick, inputs: pairs.flatMap(pair => frozenInputs(deps, pair)) });
          if (!await validPlan(tx, { method, pairs, manifest })) throw new RequestError(409, '保持对账的依据已变化。');
          // The scheduling row has no current or evidence eligibility. Shadow output is stored separately.
          await tx.insert('slot_state', { learner_id: tx.learner, slot_type: retentionComparisonWork, slot_key: key,
            scope_keys: canonicalJsonString({ method, pairs, manifest }), changed_tick: tick });
          await requestWork(tx, tick, { slotType: retentionComparisonWork, slotKey: key, deriver: comparisonDeriver });
        });
      });
      return get(key);
    },
    async execute(ref: WorkRef, key: string, terminal: boolean) {
      if (terminal) return failWork(db, ref);
      const frozen = await db.snapshot(scope, async tx => {
        const job = await readPlan(tx, key);
        if (!job) throw new Error('Retention comparison plan missing');
        const manifest = parseManifest(job.plan.manifest);
        if (!await validPlan(tx, job.plan, manifest)) return;
        const method = readAnyRetentionMethod(job.plan.method);
        if (!method) throw new Error('Retention comparison method missing');
        const pairs = await Promise.all(job.plan.pairs.map(async pair => ({
          pair, recorded: await frozenValue<RetentionForecast>(tx, pair.forecastId),
          outcome: await frozenValue<RetentionReconciliation>(tx, pair.reconciliationId),
        })));
        return { manifest, method, pairs, plan: job.plan };
      });
      if (!frozen) return finishWork(db, ref);
      const { manifest, method, pairs } = frozen;
      const cases = [];
      for (const { pair, recorded, outcome } of pairs) {
        const alternate = await evaluateStudioRetention(method, recorded.input, pythonHost);
        cases.push(retentionComparisonCase(pair, recorded, alternate, outcome));
      }
      const report = retentionComparisonReport(method, cases);
      return finishWork(db, ref, async tx => {
        if (!await validPlan(tx, frozen.plan, manifest)) return;
        await tx.insert('derivations', {
          learner_id: tx.learner, id: derivationId(key), slot_type: retentionComparisonType, slot_key: key,
          deriver: comparisonDeriver, scope_keys: '{}', value: canonicalJsonString(report), manifest: canonicalJsonString(manifest),
          lifecycle: 'candidate', freshness: 'current', gather_tick: manifest.gatherTick, is_shadow: true,
        });
      });
    },
  };
}
