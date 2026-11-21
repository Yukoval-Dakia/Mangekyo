import { workerConsent } from '../worker-consent.ts';
import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { configureResearch, researchEnabled, researchPurpose, researchRevision,
  researchScoutBudget, researchSettings, researchSettingsType } from '../research.ts';

export default defineCommand({
  type: configureResearch,
  destructive: true,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    return { id: factId(String(input.id)), revision: researchRevision(input.revision, 0),
      enabled: researchEnabled(input.enabled),
      workerGrant: input.workerGrant === undefined ? undefined : workerConsent(input.workerGrant),
      scoutBudget: input.scoutBudget === undefined ? undefined : researchScoutBudget(input.scoutBudget) };
  } },
  async write(ctx, { id, revision, enabled, scoutBudget, workerGrant }): Promise<readonly FactWrite[]> {
    if (enabled && workerGrant?.profile === 'deep_analyst' && workerGrant.comparisonAttemptId) {
      const source = await ctx.read.fact(workerGrant.comparisonAttemptId, { mode:'following' });
      if (!source.purpose.includes(researchPurpose) || source.ref.rev !== workerGrant.comparisonRevision ||
          source.accessEpoch !== workerGrant.comparisonAccessEpoch) throw new Error('Fact revision conflict');
    }
    if (revision === 0) {
      return [{ kind: 'create', id, factType: researchSettingsType, purpose: [researchPurpose],
        data: { enabled, ...(enabled && workerGrant && { workerGrant }), coordinatorRef: crypto.randomUUID(), ...(enabled && scoutBudget && { scoutConsent: scoutBudget }) } }];
    }
    const fact = await ctx.read.fact(id, { mode: 'following' });
    const prior = researchSettings(fact.value);
    if (fact.ref.rev !== revision) throw new Error('Fact revision conflict');
    // A plain enable operation authorizes local research. Resuming paid dispatch requires a fresh grant.
    const continuing = enabled && prior.enabled ? prior.scoutConsent : null;
    const budget = enabled ? (scoutBudget === undefined ? continuing : scoutBudget) : null;
    const grant = enabled ? (workerGrant === undefined ? prior.workerGrant : workerGrant) : null;
    if (JSON.stringify(prior.workerGrant) === JSON.stringify(grant) && prior.enabled === enabled && JSON.stringify(prior.scoutConsent) === JSON.stringify(budget)) return [];
    return [{ kind: 'correct', id, expectedRev: revision, data: { enabled, coordinatorRef: prior.coordinatorRef, scoutConsent: budget, workerGrant: grant } }];
  },
});
