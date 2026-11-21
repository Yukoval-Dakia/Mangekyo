import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { interventionLiftType, type LiftInput } from '../intervention-lift.ts';
import { openWitness } from '../memory-evidence.ts';
import { openReflection, playbook, playbookType } from '../playbook.ts';
import { liftPurpose, reopenWeeklyLift, weeklyLiftIdentity, type ReopenLiftCohort } from '../weekly-lift.ts';

type WeeklyLiftRun = { key: string; asOf: string; reopen: ReopenLiftCohort };

export default defineDeriver({
  name: 'learner/intervention-lift',
  version: '1',
  slot: interventionLiftType,
  async gather(ctx, run: WeeklyLiftRun | ((ctx: GatherContext) => Promise<LiftInput>)) {
    const requested = typeof run === 'function' ? {input: await run(ctx)} : {weekly: run};
    const {playbookId, version} = requested.input ?? weeklyLiftIdentity(requested.weekly.key);
    const fact = await ctx.read.fact(playbookId, {mode: 'following'});
    if (fact.type !== playbookType) throw new Error('需要待核验的策略。');
    const proposal = playbook(fact.value);
    if (proposal.version !== version || (requested.input && proposal.strategyId !== requested.input.strategyId))
      throw new Error('对账必须使用当前策略版本。');
    await openReflection(ctx.read, proposal);

    if (requested.weekly) {
      const {asOf, reopen} = requested.weekly;
      const data = await reopenWeeklyLift(ctx, {playbookId, version, strategyId: proposal.strategyId}, asOf, reopen);
      return {kind: 'input', data, effects: []};
    }
    const input = requested.input;
    const opened = new Map<string, Awaited<ReturnType<typeof openWitness>>>();
    for (const pair of input.interventions) {
      if (pair.playbookId !== playbookId || pair.version !== version || pair.strategyId !== proposal.strategyId)
        throw new Error('干预与策略版本不符。');
      for (const ref of [pair.intervention, pair.baseline?.submission, pair.posttest?.submission]) {
        if (!ref) continue;
        const key = JSON.stringify([ref.id, ref.rev, ref.accessEpoch]);
        const fact = opened.get(key) ?? await openWitness(ctx.read, ref, liftPurpose);
        opened.set(key, fact);
        if (ref !== pair.intervention && !['activity.workbookAttempt', 'activity.retentionPosttestSubmission'].includes(fact.type))
          throw new Error('前后测需要正式交卷记录。');
      }
    }
    return {kind: 'input', data: input, effects: []};
  },
  derive(_input: LiftInput) { throw new Error('Lift 需要冻结输入和 Python 执行器。'); },
});
