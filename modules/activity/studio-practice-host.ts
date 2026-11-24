import {
  commandId, createCommandReadContext, factId, isFactReadDenied, LifecycleError, matchKernelError,
  type Db, type FactId, type ReadTransaction,
} from '@mangekyo/kernel';
import {
  practiceInput, practiceSubmission, ridingPaper, ridingPracticeCommand, ridingPracticePurpose, ridingPracticeType,
  type PracticeAttempt, type PracticeInput, type PracticeView,
} from './practice-values.ts';

type LoadedModule = any;
export type StudioPracticeDeps = {
  readonly stableId: (...parts: string[]) => string;
  readonly studioHost: (db: Db) => any;
  readonly createStudioCommandHooks: () => any;
  readonly clientRequest: (value: unknown) => string;
  readonly RequestError: new (status: number, message: string) => Error;
  readonly submittedWatermark: (input: unknown) => string;
  readonly assertDeletionWatermark: (tx: ReadTransaction, expected: string) => Promise<void>;
  readonly assertUnburned: (tx: ReadTransaction, kind: 'command' | 'fact', ids: readonly string[]) => Promise<void>;
};

export function openPractice(deps: StudioPracticeDeps, db: Db, activity: LoadedModule, hooks = deps.createStudioCommandHooks()) {
  const host = deps.studioHost(db);
  const handle = host.boundHandler([activity], hooks);

  async function read(selected?: FactId): Promise<PracticeView> {
    return host.snapshot(async (tx: ReadTransaction) => {
      const { rows } = await tx.query<{ id: string }>(
        'SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick, id', [tx.learner, ridingPracticeType]);
      const history: PracticeAttempt[] = [], context = createCommandReadContext(tx, ridingPracticePurpose);
      for (const row of rows) {
        try { history.push({ id: row.id, ...practiceSubmission((await context.fact(factId(row.id), { mode: 'following' })).value) }); }
        catch (error) { if (!isFactReadDenied(error)) throw error; }
      }
      const submission = selected ? history.find(({ id }: PracticeAttempt) => id === selected) : history.at(-1);
      if (selected && !submission) throw new deps.RequestError(403, '这份练习记录当前不可读取。');
      return { paper: ridingPaper, submission: submission ?? null, history };
    });
  }

  async function replay(attemptId: FactId, input: unknown): Promise<PracticeView | null> {
    let archived;
    try {
      archived = await host.snapshot(async (tx: ReadTransaction) => {
        await deps.assertUnburned(tx, 'fact', [attemptId]); await deps.assertDeletionWatermark(tx, deps.submittedWatermark(input));
        return practiceSubmission((await createCommandReadContext(tx, ridingPracticePurpose).fact(attemptId, { mode: 'following' })).value);
      });
    } catch (error) {
      return matchKernelError(error, {
        not_found: () => null, denied: () => { throw new deps.RequestError(403, '这份练习记录当前不可读取。'); },
        otherwise: err => { throw err.cause; },
      });
    }
    let data: PracticeInput;
    try { data = practiceInput(input, archived.paper); }
    catch { throw new deps.RequestError(409, '同一个提交标识已经用于不同的作答。'); }
    if (archived.feedback.some(({ questionId, answer }: { questionId: string; answer: unknown }) => data.answers[questionId] !== answer))
      throw new deps.RequestError(409, '同一个提交标识已经用于不同的作答。');
    return read(attemptId);
  }

  return {
    read: () => read(),
    async submit(input: unknown): Promise<PracticeView> {
      const request = deps.clientRequest((input as { requestId?: unknown } | null)?.requestId);
      const attemptId = factId(deps.stableId('starter-practice', 'riding', request));
      const submissionId = commandId(deps.stableId('submit-starter-practice', attemptId));
      const prior = await replay(attemptId, input);
      if (prior) return prior;
      let data: PracticeInput;
      try { data = practiceInput(input); }
      catch (error) {
        if (error instanceof LifecycleError) throw error;
        const accepted = await replay(attemptId, input);
        if (accepted) return accepted;
        throw new deps.RequestError(400, error instanceof Error ? error.message : '练习提交格式无效。');
      }
      try {
        await handle({ purpose: ridingPracticePurpose, type: ridingPracticeCommand, id: submissionId,
          deletionWatermark: deps.submittedWatermark(input), input: { id: attemptId, data } });
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
