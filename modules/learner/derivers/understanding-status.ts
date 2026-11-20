import { defineDeriver, factId } from '@mangekyo/kernel';
import { openWitness } from '../memory-evidence.ts';
import { liftType, openReflection, playbook, playbookType, understandingStatusType, verifiedStatus } from '../playbook.ts';

export default defineDeriver({
  name: 'learner/understanding-status', version: '1', slot: understandingStatusType,
  async gather(ctx, key: {playbookId: string}) {
    const id = factId(key.playbookId);
    const fact = await ctx.read.fact(id, {mode: 'following'});
    if (fact.type !== playbookType) throw new Error('需要待核验的策略。');
    const proposal = playbook(fact.value);
    await openReflection(ctx.read, proposal);
    const lift = await ctx.read.slot({learner: ctx.learner, type: liftType, key: JSON.stringify([id, proposal.version])}, {mode: 'following'});
    const status = verifiedStatus(id, proposal, lift);
    for (const ref of status.verificationRefs) await openWitness(ctx.read, ref, 'background-research');
    return {kind: 'input', data: status, effects: []};
  },
  derive(status) { return {kind: 'value', value: status}; },
});
