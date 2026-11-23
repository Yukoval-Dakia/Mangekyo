import type {Db, ReadTransaction} from '../../kernel/src/index.ts';
import {createCommandHandler, createPropagationHooks, withLearnerLock} from '../../kernel/src/index.ts';
import { planReview, readEligibleReview, reviewDedupKey } from '../../modules/companion/worksheet-policy.ts';
import { generateResearchDraft, ResearchDispatchDenied, type WorkerTariff } from '../../executors/teaching/research-worker.ts';

import { learnerId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { cancelWork, failWork, readReadyWork, type WorkRef, type WorkRequest } from '../../kernel/src/work/index.ts';
import { completeTodo, enqueueWork, readTodo, readLatestTodoUnavailable, rememberTodoUnavailable } from '../../kernel/src/work/todos.ts';
import type { FactRevisionBasis } from '../../kernel/src/declarations/fact-basis.ts';
import { researchPurpose, ResearchBasisChanged, publishWorksheet, worksheetDraft } from '../../modules/companion/research.ts';
import { readWorksheet, reviewAccess, worksheetPublication, whenAvailable } from '../studio/research-sources.ts';

import { EffectBudgetExceeded } from '../../kernel/src/work/effects.ts';
import { bindWorkPayload } from '../../kernel/src/work/payload.ts';
import { workerCall, workerCap } from './worker-dispatch.ts';
import type { TodoSpec } from '../../kernel/src/work/todos.ts';
import { isWorksheetProfile, type WorkerConsent } from '../../modules/companion/worker-consent.ts';

export function modelReviewSpec(tx: ReadTransaction, spec: TodoSpec, grant: WorkerConsent | null, tariff?: WorkerTariff) {
  return planReview(reviewAccess(tx), spec, grant, grant ? workerCap(grant, tariff) : 0);
}
export function eligibleBasis(tx: ReadTransaction, spec: TodoSpec, settingsId: FactId, tariff?: WorkerTariff) {
  return whenAvailable(() => readEligibleReview(reviewAccess(tx),spec,settingsId,grant => workerCap(grant,tariff)));
}

export async function worksheetView(tx: ReadTransaction, source: FactSnapshot | null, settingsRevision?: number) {
  const opened = source && await readWorksheet(tx, source);
  const worksheet = opened?.worksheet ?? null;
  if (worksheet || !source?.purpose.includes(researchPurpose) || settingsRevision === undefined) return { worksheet };
  const dedup = reviewDedupKey({id:source.ref.id, revision:source.ref.rev, accessEpoch:source.accessEpoch});
  const reason = await readLatestTodoUnavailable(tx, dedup, settingsRevision);
  return {worksheet, ...(reason === 'model_unavailable' && {failure:reason})};
}

function sameAttachmentBasis(left: readonly FactRevisionBasis[], right: readonly FactRevisionBasis[]): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.id === right[index]?.id && entry.rev === right[index]?.rev && entry.epoch === right[index]?.epoch);
}

export async function executeWorksheet(db: Db, companion: LoadedModule, ref: WorkRef, todoId: FactId, settingsId: FactId,
  wake: WorkRequest, tariff: WorkerTariff | undefined, signal: AbortSignal) {
  const scope = {learner:learnerId(ref.learner)};
  const prepared = await withLearnerLock(db, scope, async tx => {
    if (!(await readReadyWork(tx, ref))) return null;
    const todo = await readTodo(tx, todoId);
    if (todo?.state !== 'dispatched') return null;
    // Source authorization must succeed before recording a failure for a missing live quote.
    const eligible = await whenAvailable(() => readEligibleReview(reviewAccess(tx), todo.spec, settingsId));
    if (!eligible) return null;
    const { basis, evidence, retention } = eligible;
    const { attemptId, revision, accessEpoch } = basis.source;
    const publication = await worksheetPublication(tx, attemptId, revision, accessEpoch);
    if (!await bindWorkPayload(tx, ref, eligible.sourceIds, publication)) return null;
    return { todo, publication, basis, evidence, retention, grant: eligible.grant, comparison: eligible.comparison, attachmentBasis: eligible.attachmentBasis } as const;
  });
  if (!prepared) {
    await cancelWork(db, ref);
    return true;
  }
  const profile = prepared.todo.spec.workerProfile;
  const { factId: id, commandId } = prepared.publication;
  const liveStill = async (tx: ReadTransaction) => {
    const current = await readTodo(tx, todoId);
    const live = current && await eligibleBasis(tx, current.spec, settingsId, tariff);
    return current && live && current.revision === prepared.todo.revision &&
      sameAttachmentBasis(live.attachmentBasis, prepared.attachmentBasis) ? current : null;
  };
  const check = async (tx: ReadTransaction) => {
    if (!await liveStill(tx) || !await readReadyWork(tx, ref)) throw new ResearchBasisChanged('教研授权失效。');
  };
  const { grant, todo, evidence, retention, comparison } = prepared;
  const unavailable = async () => {
    await failWork(db, ref, (tx, tick) => rememberTodoUnavailable(tx, tick, todoId, 'model_unavailable'));
    return true;
  };
  if ((!evidence && !retention) || !isWorksheetProfile(profile) || (retention && profile !== 'heavy_tutor_prep') || !grant || !tariff || workerCap(grant, tariff) !== todo.spec.budgetCap)
    return unavailable();

  const runner = workerCall(db, todoId, prepared.basis.source.attemptId, grant, tariff, check, signal, ref);
  let draft;
  try {
    draft = worksheetDraft(await generateResearchDraft(profile, JSON.stringify({source:evidence ?? retention, comparison}), runner.call, Boolean(retention)));
  } catch (error) {
    if (error instanceof EffectBudgetExceeded || error instanceof ResearchDispatchDenied) return unavailable();
    throw error;
  }
  const propagation = createPropagationHooks([]);
  const publish = createCommandHandler(db, {
    modules: [companion],
    hooks: { async onFactsChanged(tx, tick, changes) {
      await propagation.onFactsChanged(tx, tick, changes);
      const current = await liveStill(tx);
      if (!current || !(await readReadyWork(tx, ref)) || !await completeTodo(tx, tick, ref, current, id))
        throw new ResearchBasisChanged('工作单已失效。');
      await enqueueWork(tx, tick, wake);
    } },
  });
  const receipt = await whenAvailable(() => publish({
    ...scope, actor: 'companion', purpose: researchPurpose, type: publishWorksheet,
    id: commandId,
    input: { id, todoId, basis: prepared.basis, draft,
      ...(prepared.attachmentBasis.length ? { attachmentBasis: prepared.attachmentBasis } : {}),
      actualUsdMicros:runner.actualUsdMicros(), references:todo.spec.refs.map(({id, revision, accessEpoch, anchor}) => ({id,revision,accessEpoch,anchor:anchor!})),
      method:profile, questionNumber:evidence?.questionNumber ?? 1 },
  }));
  if (!receipt) await cancelWork(db, ref);
  return true;
}
