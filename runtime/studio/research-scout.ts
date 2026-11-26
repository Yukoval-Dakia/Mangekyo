import {LifecycleError, type Db, type ReadTransaction} from '../../kernel/src/index.ts';
import { scoutReceipt, type ResearchScoutHost } from '../../executors/temporal/src/research-scout.ts';
export { validateResearchScoutHost, type ResearchScoutHost } from '../../executors/temporal/src/research-scout.ts';

import type { FactId } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';

import { EffectBudgetExceeded, EffectIdentityMismatch, runEffect } from '../../kernel/src/work/effects.ts';
import type { researchScoutBudget } from '../../modules/companion/research.ts';
import { studioHost, studioLearner } from './identity.ts';
import { scoutEffectIdentity, researchDecision, type preparePaidResearchTriage } from './research-triage-host.ts';

const scope = { learner: studioLearner };
export class ScoutAuthorizationChanged extends Error {}

export async function sampleResearchScout(db: Db, settingsId: FactId, revision: number,
  budget: NonNullable<ReturnType<typeof researchScoutBudget>>, host: ResearchScoutHost,
  prepared: NonNullable<Awaited<ReturnType<typeof preparePaidResearchTriage>>>,
  authorize: (tx: ReadTransaction) => Promise<void>, signal: AbortSignal) {
  if (host.route !== budget.route || host.retentionDays > budget.maxRetentionDays ||
      host.reserveUsdMicros > budget.maxPerCallMicros) return undefined;
  const prompt = JSON.stringify(prepared.paidInput);
  const { route, reserveUsdMicros } = host;
  const maxOutputTokens = 256;
  try {
    const effect = await runEffect(db, {
      ...scope, ...scoutEffectIdentity(settingsId, prepared.intent.dedupKey), input: { revision, route, reserveUsdMicros, maxOutputTokens, prompt },
    }, async (providerEffectId, checkDispatch) => {
      let dispatched = false;
      try {
        return studioHost(db).startLockedEffect(async tx => {
          await checkDispatch(tx);
          await authorize(tx);
          if (host.retentionDays > budget.maxRetentionDays || host.route !== budget.route || reserveUsdMicros > budget.maxPerCallMicros)
            throw new ScoutAuthorizationChanged();
          signal.throwIfAborted();
          dispatched = true;
          const response = host.sample({ providerEffectId, prompt, maxOutputTokens, reserveUsdMicros },
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
          void response.catch(() => {});
          return response;
        }, async response => scoutReceipt(await response,reserveUsdMicros,raw => researchDecision(prepared,raw)));
      } catch (error) {
        if (!dispatched) return { decision: 'not_sent', actualUsdMicros: 0 };
        throw error;
      }
    }, authorize, { manifest: prepared.manifest }, { route, limitUsdMicros: budget.limitMicros, reserveUsdMicros,
      actualUsdMicros: (result: Json) =>
        result && typeof result === 'object' && 'actualUsdMicros' in result && typeof result.actualUsdMicros === 'number'
          ? result.actualUsdMicros : null,
    });
    if (effect.kind === 'unknown' && effect.inFlight) return undefined;
    const result = effect.kind === 'done' ? effect.result : null;
    return Boolean(result && typeof result === 'object' && 'decision' in result && result.decision === 'review');
  } catch (error) {
    if (error instanceof EffectBudgetExceeded || error instanceof ScoutAuthorizationChanged) return undefined;
    if (error instanceof EffectIdentityMismatch) return 'superseded' as const;
    if (error instanceof LifecycleError) return false;
    throw error;
  }
}
