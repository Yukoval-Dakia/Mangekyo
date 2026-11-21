import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { resumeCare, resumeCareInput, resumeCareWrite, carePauseValue } from '../care-pause.ts';

export default defineCommand({
  type: resumeCare,
  destructive: true,
  schema: { parse: resumeCareInput },
  async write(ctx, { id, revision }): Promise<readonly FactWrite[]> {
    const fact = await ctx.read.fact(id, { mode: 'following' });
    if (fact.ref.rev !== revision) throw new Error('Fact revision conflict');
    return resumeCareWrite(carePauseValue(fact.value), id, revision);
  },
});
