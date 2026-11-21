import { defineCommand, factId, type FactWrite } from '@mangekyo/kernel';
import { packCandidates } from '../offline-pack.ts';
import { planRule, planRuleType, sameWarmupOpen, TomorrowWarmupConflict } from '../rules.ts';
import { tomorrowWarmupDay } from '../tomorrow-warmup.ts';
import { object, target, text } from '../validation.ts';

export default defineCommand({
  type: 'plan.saveRule',
  destructive: true,
  schema: {
    parse(input: unknown) {
      const raw = object(input);
      const ref = raw.expectedRev === null ? { id: factId(text(raw.id)), expectedRev: null } : target(raw);
      const data = raw.data === null ? null : planRule(raw.data);
      if (!data && ref.expectedRev === null) throw new Error('请提供要撤销的约束版本。');
      return { ...ref, data };
    },
  },
  async write(ctx, { id, expectedRev, data }): Promise<FactWrite[]> {
    if (data?.kind === 'lock' && data.warmup) {
      const { open, timeZone } = data.warmup;
      if (data.date !== tomorrowWarmupDay(new Date().toISOString(), timeZone).day)
        throw new TomorrowWarmupConflict('热身日期已变化。');
      if (open.kind === 'pack') {
        if (!packCandidates().some(candidate => candidate.id === data.activityId && sameWarmupOpen(candidate.open, open)))
          throw new TomorrowWarmupConflict('热身包版本已变化。');
      } else {
        const artifact = await ctx.read.fact(factId(open.id), { mode: 'following' });
        if (!artifact.type.startsWith('activity.') || artifact.ref.rev !== open.rev)
          throw new TomorrowWarmupConflict('热身活动版本已变化。');
      }
    }
    if (expectedRev === null && data)
      return [{ kind: 'create', id, factType: planRuleType, data, purpose: ['storage'] }];
    if (expectedRev === null || (await ctx.read.fact(id, { mode: 'following' })).type !== planRuleType)
      throw new Error('规划约束不存在。');
    return [data ? { kind: 'correct', id, expectedRev, data } : { kind: 'retract', id, expectedRev }];
  },
});
