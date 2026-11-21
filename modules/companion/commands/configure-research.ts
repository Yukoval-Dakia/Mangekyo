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
      scoutBudget: input.scoutBudget === undefined ? undefined : researchScoutBudget(input.scoutBudget) };
  } },
  async write(ctx, { id, revision, enabled, scoutBudget }): Promise<readonly FactWrite[]> {
    if (revision === 0) {
      return [{ kind: 'create', id, factType: researchSettingsType, purpose: [researchPurpose],
        data: { enabled, coordinatorRef: crypto.randomUUID(), ...(enabled && scoutBudget && { scoutConsent: scoutBudget }) } }];
    }
    const fact = await ctx.read.fact(id, { mode: 'following' });
    const prior = researchSettings(fact.value);
    if (fact.ref.rev !== revision) throw new Error('Fact revision conflict');
    // A plain enable operation authorizes local research. Resuming paid dispatch requires a fresh grant.
    const continuing = enabled && prior.enabled ? prior.scoutConsent : null;
    const budget = enabled ? (scoutBudget === undefined ? continuing : scoutBudget) : null;
    if (prior.enabled === enabled && JSON.stringify(prior.scoutConsent) === JSON.stringify(budget)) return [];
    return [{ kind: 'correct', id, expectedRev: revision, data: { enabled, coordinatorRef: prior.coordinatorRef, scoutConsent: budget } }];
  },
});
