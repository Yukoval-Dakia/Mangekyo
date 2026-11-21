import { runPricedOutput } from '../../kernel/src/work/priced-output.ts';
import type { WorkRef } from '../../kernel/src/work/index.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { workerOffers, workerAccount, workerPricing, workerStage, totalWorkerCost, ResearchDispatchDenied, type WorkerTariff } from '../../executors/teaching/research-worker.ts';
import { loadSettings } from '../studio/settings.ts';
import type { WorkerConsent } from '../../modules/companion/worker-consent.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { comparisonWitness } from '../../modules/companion/worksheet-policy.ts';
import { reviewAccess } from '../studio/research-sources.ts';
import { RequestError } from '../studio/sessions.ts';
import { studioLearner } from '../studio/identity.ts';

export { workerCap } from '../../executors/teaching/research-worker.ts';
export const workerOffer = (tariff: WorkerTariff) => workerOffers(tariff, loadSettings);

export function grantHooks(hooks: CommandHooks, grant: WorkerConsent, tariff?: WorkerTariff): CommandHooks {
  return { ...hooks, async onFactsChanged(tx, tick, changes) {
    if (!tariff || grant.maxPerCallMicros !== tariff.reserveUsdMicros || grant.maxRetentionDays !== tariff.retentionDays ||
        (grant.profile === 'deep_analyst' && !await comparisonWitness(reviewAccess(tx), grant)))
      throw new RequestError(409, '报价或对照作答已更新，请重新确认。');
    try { await workerAccount(grant, tariff, loadSettings); }
    catch (error) { if (error instanceof ResearchDispatchDenied) throw new RequestError(409, error.message); throw error; }
    await hooks.onFactsChanged(tx, tick, changes);
  } };
}

export function workerCall(db: Db, todoId: string, sourceId: string, grant: WorkerConsent,
  tariff: WorkerTariff, check: (tx: ReadTransaction) => Promise<void>, signal: AbortSignal, payloadWork?: WorkRef) {
  const authorize = async (tx: ReadTransaction) => {
    signal.throwIfAborted();
    await check(tx);
    return workerAccount(grant, tariff, loadSettings);
  };
  const totals = new Map<string, number | null>();
  return {
    async call(stage: string, instructions: string, input: string) {
      const result = await runPricedOutput(db, {learner:studioLearner, ownerKind:'derivation', ownerId:sourceId,
        stepKey:todoId + ':' + stage, label:'research-worker-v1', ...(payloadWork && {payloadWork}),
        input:{grant, instructions, input, reserve:tariff.reserveUsdMicros}}, 'research-worker-output-v1', authorize,
      workerPricing(grant, tariff, todoId, stage),
      (dispatch, save, id) => workerStage(dispatch, save, tariff, id, instructions, input, signal));
      totals.set(stage, result.actualUsdMicros);
      return result.body;
    },
    actualUsdMicros: () => totalWorkerCost(totals.values()),
  };
}
