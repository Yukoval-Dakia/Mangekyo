import { assertDeletionWatermark, assertUnburned } from '../../kernel/src/lifecycle.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import {
  commandId, createCommandReadContext, createLearnerHost, factId, isFactReadDenied, LifecycleError, matchKernelError,
  type CommandHooks, type Db, type FactId,
} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  practiceInput,
  practiceSubmission,
  ridingPaper,
  ridingPracticeCommand,
  ridingPracticePurpose,
  ridingPracticeType,
  type PracticeAttempt,
  type PracticeInput,
  type PracticeView,
} from '../../modules/activity/practice-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export function openPractice(db: Db, activity: LoadedModule, hooks: CommandHooks = createStudioCommandHooks()) {
  const host = createLearnerHost(db, studioLearner);
  const handle = host.boundHandler([activity], hooks);

  async function read(selected?: FactId): Promise<PracticeView> {
    return host.snapshot(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick, id',
        [tx.learner, ridingPracticeType],
      );
      const history: PracticeAttempt[] = [];
      const context = createCommandReadContext(tx, ridingPracticePurpose);
      for (const row of rows) {
        try {
          const fact = await context.fact(factId(row.id), { mode: 'following' });
          history.push({ id: row.id, ...practiceSubmission(fact.value) });
        } catch (error) {
          if (!isFactReadDenied(error)) throw error;
        }
      }
      const submission = selected ? history.find(({ id }) => id === selected) : history.at(-1);
      if (selected && !submission) throw new RequestError(403, '这份练习记录当前不可读取。');
      return { paper: ridingPaper, submission: submission ?? null, history };
    });
  }

  async function replay(attemptId: FactId, input: unknown): Promise<PracticeView | null> {
    let archived;
    try {
      archived = await host.snapshot(async (tx) => {
        await assertUnburned(tx, 'fact', [attemptId]);
        await assertDeletionWatermark(tx,submittedWatermark(input));
        const fact = await createCommandReadContext(tx, ridingPracticePurpose)
          .fact(attemptId, { mode: 'following' });
        return practiceSubmission(fact.value);
      });
    } catch (error) {
      return matchKernelError(error, {
        not_found: () => null,
        denied: () => { throw new RequestError(403, '这份练习记录当前不可读取。'); },
        otherwise: err => { throw err.cause; },
      });
    }
    let data: PracticeInput;
    try {
      data = practiceInput(input, archived.paper);
    } catch {
      throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
    }
    if (archived.feedback.some(({ questionId, answer }) => data.answers[questionId] !== answer))
      throw new RequestError(409, '同一个提交标识已经用于不同的作答。');
    return read(attemptId);
  }

  return {
    read: () => read(),
    async submit(input: unknown): Promise<PracticeView> {
      const request = clientRequest((input as { requestId?: unknown } | null)?.requestId);
      const attemptId = factId(stableId('starter-practice', 'riding', request));
      const submissionId = commandId(stableId('submit-starter-practice', attemptId));
      const prior = await replay(attemptId, input);
      if (prior) return prior;
      let data: PracticeInput;
      try {
        data = practiceInput(input);
      } catch (error) {
        if (error instanceof LifecycleError) throw error;
        const accepted = await replay(attemptId, input);
        if (accepted) return accepted;
        throw new RequestError(400, error instanceof Error ? error.message : '练习提交格式无效。');
      }
      try {
        await handle({purpose: ridingPracticePurpose, type: ridingPracticeCommand, id: submissionId,
          deletionWatermark: submittedWatermark(input), input: { id: attemptId, data }});
      } catch (error) {
        if (error instanceof LifecycleError) throw error;
        const accepted = await replay(attemptId, input);
        if (accepted) return accepted;
        throw error;
      }
      return read(attemptId);
    },
  };
}
