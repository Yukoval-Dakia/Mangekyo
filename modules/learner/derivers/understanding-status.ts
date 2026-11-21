import { defineDeriver, factId } from '@mangekyo/kernel';
import { openWitness } from '../memory-evidence.ts';
import { openReflection, playbook, playbookGardeningProposal, playbookType, readPlaybookLift,
  understandingStatusType, verifiedStatus } from '../playbook.ts';

export default defineDeriver({
  name: 'learner/understanding-status', version: '1', slot: understandingStatusType,
  async gather(ctx, key: {playbookId: string; at?: string}) {
    const id = factId(key.playbookId);
    const fact = await ctx.read.fact(id, {mode: 'following'});
    if (fact.type !== playbookType) throw new Error('需要待核验的策略。');
    const proposal = playbook(fact.value);
    const {process} = await openReflection(ctx.read, proposal);
    const lift = await readPlaybookLift(ctx.read, ctx.learner, id, proposal);
    const status = verifiedStatus(id, proposal, lift, key.at);
    for (const ref of status.verificationRefs) await openWitness(ctx.read, ref, 'background-research');
    return {kind: 'input', data: {...status, ...(process ? {process} : {}),
      gardeningProposal: playbookGardeningProposal(id, fact.ref.rev, status)}, effects: []};
  },
  derive(status) { return {kind: 'value', value: status}; },
});
