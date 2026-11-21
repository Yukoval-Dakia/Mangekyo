import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { pauseCare, pauseCareInput, pauseCareWrite, carePauseValue } from '../care-pause.ts';

export default defineCommand({
  type: pauseCare,
  destructive: true,
  schema: { parse: pauseCareInput },
  async write(ctx, { id, now }): Promise<readonly FactWrite[]> {
    const current = await ctx.read.fact(id, { mode: 'following' }).then(
      fact => ({ value: carePauseValue(fact.value), rev: fact.ref.rev }),
      () => null,
    );
    return pauseCareWrite(current?.value ?? null, id, now, current?.rev);
  },
});
