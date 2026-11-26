import { assertDeletionWatermark, assertUnburned } from '../../kernel/src/lifecycle.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import {
  commandId, createCommandReadContext, factId, isFactReadDenied, LifecycleError, mapKernelError, type CommandHooks, type Db, type FactId,
} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  practiceInput, practiceSubmission, ridingPaper, ridingPracticeCommand, ridingPracticePurpose, ridingPracticeType,
  type PracticeAttempt, type PracticeInput, type PracticeView,
} from '../../modules/activity/practice-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { readFactCollection } from '../../kernel/src/commands/fact-collection.ts';
import { stableId, studioHost } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export function openPractice(db: Db, activity: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) {
  const host = studioHost(db), handle = host.boundHandler([activity], hooks);
  const read = (selected?: FactId): Promise<PracticeView> => host.snapshot(async tx => {
    const history: PracticeAttempt[] = [], context = createCommandReadContext(tx, ridingPracticePurpose);
    for await (const fact of readFactCollection(tx, context, [ridingPracticeType]))
      history.push({ id: fact.ref.id, ...practiceSubmission(fact.value) });
    const submission = selected ? history.find(({ id }) => id === selected) : history.at(-1);
    if (selected && !submission) throw new RequestError(403, '这份练习记录当前不可读取。');
    return { paper: ridingPaper, submission: submission ?? null, history };
  });
  async function replay(attemptId: FactId, input: unknown): Promise<PracticeView | null> {
    let archived;
    try {
      archived = await host.snapshot(async tx => {
        await assertUnburned(tx, 'fact', [attemptId]);
        await assertDeletionWatermark(tx, submittedWatermark(input));
        return practiceSubmission((await createCommandReadContext(tx, ridingPracticePurpose).fact(attemptId, { mode: 'following' })).value);
      });
    } catch (error) {
      return mapKernelError(error, { not_found: () => null, denied: () => { throw new RequestError(403, '这份练习记录当前不可读取。'); } });
    }
    let data: PracticeInput;
    try { data = practiceInput(input, archived.paper); } catch { throw new RequestError(409, '同一个提交标识已经用于不同的作答。'); }
    if (archived.feedback.some(({ questionId, answer }) => data.answers[questionId] !== answer))
      throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
    return read(attemptId);
  }
  return {
    read: () => read(),
    async submit(input: unknown): Promise<PracticeView> {
      const request = clientRequest((input as { requestId?: unknown } | null)?.requestId);
      const attemptId = factId(stableId('starter-practice', 'riding', request));
      const prior = await replay(attemptId, input);
      if (prior) return prior;
      const run = async <T>(work: () => T | Promise<T>, onFail?: (e: unknown) => never) => {
        try { return await work(); } catch (error) {
          if (error instanceof LifecycleError) throw error;
          const accepted = await replay(attemptId, input);
          if (accepted) return accepted;
          if (onFail) onFail(error);
          throw error;
        }
      };
      const data = await run(() => practiceInput(input), error => {
        throw new RequestError(400, error instanceof Error ? error.message : '练习提交格式无效。');
      });
      if ('submission' in data) return data;
      await run(() => handle({ purpose: ridingPracticePurpose, type: ridingPracticeCommand,
        id: commandId(stableId('submit-starter-practice', attemptId)), deletionWatermark: submittedWatermark(input),
        input: { id: attemptId, data } }));
      return read(attemptId);
    },
  };
}
