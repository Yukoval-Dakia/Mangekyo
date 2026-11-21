import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import { LifecycleError } from '../../kernel/src/lifecycle.ts';
import { EffectBudgetExceeded, EffectIdentityMismatch, runEffect } from '../../kernel/src/work/effects.ts';
import type { researchScoutBudget } from '../../modules/companion/research.ts';
import { studioLearner } from './identity.ts';
import { scoutEffectIdentity, researchDecision, type preparePaidResearchTriage } from './research-triage-host.ts';

const scope = { learner: studioLearner };
const maxReplyBytes = 8192;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;

/** Trusted host. The route versions both the recipient and its dispatch/pricing policy. */
export type ResearchScoutHost = Readonly<{
  route: string;
  reserveUsdMicros: number;
  retentionDays: number;
  /** Start one bounded dispatch synchronously. Enforce the quoted hard cap and do not retry. */
  sample(input: {
    providerEffectId: string;
    prompt: string;
    maxOutputTokens: number;
    reserveUsdMicros: number;
  }, signal: AbortSignal): Promise<{ reply: string; actualUsdMicros?: number; servedModel?: string }>;
}>;

export function validateResearchScoutHost(host: ResearchScoutHost) {
  if (!host || typeof host.route !== 'string' || !identifier.test(host.route) ||
      !Number.isSafeInteger(host.reserveUsdMicros) || host.reserveUsdMicros <= 0 ||
      typeof host.sample !== 'function')
    throw new Error('前哨宿主须声明版本化服务标识、正数 USD 微元硬上限、留存天数与采样函数。');
  // A previously installed host without a retention policy can keep serving local research.
  if (host.retentionDays === undefined) return undefined;
  if (!Number.isSafeInteger(host.retentionDays) || host.retentionDays < 0)
    throw new Error('前哨宿主的留存天数无效。');
  return host;
}

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
        const { response } = await db.tx(scope, async tx => {
          await lockLearner(tx, tx.learner);
          await checkDispatch(tx);
          await authorize(tx);
          if (host.retentionDays > budget.maxRetentionDays || host.route !== budget.route || reserveUsdMicros > budget.maxPerCallMicros)
            throw new ScoutAuthorizationChanged();
          signal.throwIfAborted();
          dispatched = true;
          const response = host.sample({ providerEffectId, prompt, maxOutputTokens, reserveUsdMicros },
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
          void response.catch(() => {});
          return { response };
        });
        const receipt = await response;
        const reported = receipt?.actualUsdMicros;
        const cost = typeof reported === 'number' && Number.isSafeInteger(reported) && reported >= 0 ? reported : null;
        const decision = cost !== null && cost > reserveUsdMicros ? 'price_exceeded'
          : typeof receipt?.reply === 'string' && Buffer.byteLength(receipt.reply) <= maxReplyBytes
            ? researchDecision(prepared, receipt.reply) : 'invalid_reply';
        return {
          decision,
          actualUsdMicros: cost,
          servedModel: typeof receipt?.servedModel === 'string' && identifier.test(receipt.servedModel)
            ? receipt.servedModel : null,
        };
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
