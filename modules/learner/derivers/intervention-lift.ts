import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { interventionLiftType, measureInterventionLift, type LiftInput } from '../intervention-lift.ts';
import { openWitness } from '../memory-evidence.ts';
import { openReflection, playbook, playbookType } from '../playbook.ts';

export default defineDeriver({
  name: 'learner/intervention-lift',
  version: '1',
  slot: interventionLiftType,
  async gather(ctx, read: (ctx: GatherContext) => Promise<LiftInput>) {
    const data = await read(ctx);
    const fact = await ctx.read.fact(data.playbookId, {mode: 'following'});
    if (fact.type !== playbookType) throw new Error('需要待核验的策略。');
    const proposal = playbook(fact.value);
    if (proposal.version !== data.version || proposal.strategyId !== data.strategyId)
      throw new Error('对账必须使用当前策略版本。');
    await openReflection(ctx.read, proposal);
    const opened = new Map<string, Awaited<ReturnType<typeof openWitness>>>();
    for (const pair of data.interventions) {
      if (pair.playbookId !== data.playbookId || pair.version !== data.version || pair.strategyId !== data.strategyId)
        throw new Error('干预与策略版本不符。');
      for (const ref of [pair.intervention, pair.baseline?.submission, pair.posttest?.submission]) {
        if (!ref) continue;
        const key = JSON.stringify([ref.id, ref.rev, ref.accessEpoch]);
        const fact = opened.get(key) ?? await openWitness(ctx.read, ref, 'background-research');
        opened.set(key, fact);
        if (ref !== pair.intervention && !['activity.workbookAttempt', 'activity.retentionPosttestSubmission'].includes(fact.type))
          throw new Error('前后测需要正式交卷记录。');
      }
    }
    return { kind: 'input', data, effects: [] };
  },
  derive: measureInterventionLift,
});
