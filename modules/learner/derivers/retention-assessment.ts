import { defineDeriver, type GatherContext } from '@mangekyo/kernel';
import { freezeExam, freezeDuration, type ExamInput, type DurationInput } from '../retention-assessment.ts';
import { forecastType } from '../retention.ts';

type Request = { kind: 'exam'; input: Omit<ExamInput, 'observedThrough'> }
  | { kind: 'duration'; input: Omit<DurationInput, 'observedThrough'> };

export default defineDeriver({
  name: 'learner/retention-assessment', version: '1', slot: forecastType,
  async gather(ctx, read: (ctx: GatherContext) => Promise<Request>) {
    return { kind: 'input', data: { request: await read(ctx), observedThrough: ctx.snapshotTick }, effects: [] };
  },
  derive({ request, observedThrough }) {
    const value = request.kind === 'exam' ? freezeExam({ ...request.input, observedThrough })
      : freezeDuration({ ...request.input, observedThrough });
    return { kind: 'value', value };
  },
});
