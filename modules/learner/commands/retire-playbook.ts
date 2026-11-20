import { defineCommand, factId, type FactWrite, type Revision } from '@mangekyo/kernel';
import { integer, openWitness, record, text } from '../memory-evidence.ts';
import { openReflection, playbook, playbookType, readPlaybookLift, retirePlaybookCommand, verifiedStatus } from '../playbook.ts';

export default defineCommand({
  type: retirePlaybookCommand,
  destructive: true,
  schema: {parse(value) {
    const input = record(value);
    return {id: factId(text(input.id, 26)), expectedRev: integer(input.expectedRev, 1) as Revision,
      version: integer(input.version, 1)};
  }},
  async write(ctx, {id, expectedRev, version}): Promise<readonly FactWrite[]> {
    const fact = await ctx.read.fact(id, {mode: 'following'});
    if (fact.type !== playbookType || fact.ref.rev !== expectedRev) throw new Error('策略版本已变化。');
    const proposal = playbook(fact.value);
    if (proposal.version !== version) throw new Error('策略版本已变化。');
    await openReflection(ctx.read, proposal);
    const current = verifiedStatus(id, proposal, await readPlaybookLift(ctx.read, ctx.learner, id, proposal));
    if (current.status !== 'demoted') throw new Error('当前策略缺少显著负 Lift。');
    for (const ref of current.verificationRefs) await openWitness(ctx.read, ref, 'background-research');
    return [{kind: 'retract', id, expectedRev}];
  },
});
