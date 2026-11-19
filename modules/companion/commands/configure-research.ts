import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { configureResearch, researchEnabled, researchPurpose, researchRevision,
  researchSettings, researchSettingsType } from '../research.ts';

export default defineCommand({
  type: configureResearch,
  destructive: true,
  schema: { parse(value: unknown) {
    const input = value as Record<string, unknown>;
    return { id: factId(String(input.id)), revision: researchRevision(input.revision, 0),
      enabled: researchEnabled(input.enabled) };
  } },
  async write(ctx, { id, revision, enabled }): Promise<readonly FactWrite[]> {
    if (revision === 0) {
      return [{ kind: 'create', id, factType: researchSettingsType, purpose: [researchPurpose],
        data: { enabled, coordinatorRef: crypto.randomUUID() } }];
    }
    const fact = await ctx.read.fact(id, { mode: 'following' });
    const prior = researchSettings(fact.value);
    if (fact.ref.rev !== revision) throw new Error('Fact revision conflict');
    if (prior.enabled === enabled) return [];
    return [{ kind: 'correct', id, expectedRev: revision, data: { ...prior, enabled } }];
  },
});
