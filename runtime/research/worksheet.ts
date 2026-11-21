import { planReview, readEligibleReview, retentionReviewDraft, deterministicReview, type ResearchAgent } from '../../modules/companion/worksheet-policy.ts';
import { generateResearchDraft, type WorkerTariff } from '../../executors/teaching/research-worker.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { learnerId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { cancelWork, readReadyWork, type WorkRef, type WorkRequest } from '../../kernel/src/work/index.ts';
import { completeTodo, enqueueWork, readTodo } from '../../kernel/src/work/todos.ts';
import { researchPurpose, ResearchBasisChanged, publishWorksheet, worksheetDraft } from '../../modules/companion/research.ts';
import { reviewAccess, worksheetPublication, whenAvailable } from '../studio/research-sources.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
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

export async function executeWorksheet(db: Db, companion: LoadedModule, ref: WorkRef, todoId: FactId, settingsId: FactId,
  wake: WorkRequest, agent: ResearchAgent | undefined, tariff: WorkerTariff | undefined, signal: AbortSignal) {
  const scope = {learner:learnerId(ref.learner)};
  const prepared = await db.tx(scope, async tx => {
    await lockLearner(tx, tx.learner);
    if (!(await readReadyWork(tx, ref))) return null;
    const todo = await readTodo(tx, todoId);
    if (todo?.state !== 'dispatched') return null;
    const eligible = await eligibleBasis(tx, todo.spec, settingsId, tariff);
    if (!eligible) return null;
    const { basis, evidence } = eligible;
    const { attemptId, revision, accessEpoch } = basis.source;
    const publication = await worksheetPublication(tx, attemptId, revision, accessEpoch);
    if (!await bindWorkPayload(tx, ref, eligible.sourceIds, publication)) return null;
    return { todo, publication, basis, evidence, grant: eligible.grant, comparison:eligible.comparison } as const;
  });
  if (!prepared) {
    await cancelWork(db, ref);
    return true;
  }
  const profile = prepared.todo.spec.workerProfile;
  const { factId: id, commandId } = prepared.publication;
  const check = async (tx: ReadTransaction) => {
    const current = await readTodo(tx, todoId);
    if (current?.revision !== prepared.todo.revision || !await readReadyWork(tx, ref) ||
        !await eligibleBasis(tx, current.spec, settingsId, tariff)) throw new ResearchBasisChanged('教研授权失效。');
  };
  const runner = prepared.grant && tariff && workerCall(db, todoId, prepared.basis.source.attemptId, prepared.grant, tariff, check, signal, ref);
  const model = isWorksheetProfile(profile) && runner;
  const draft = worksheetDraft(model ? await generateResearchDraft(profile, JSON.stringify({
    source: prepared.evidence, comparison: prepared.comparison}), runner.call)
    : prepared.evidence ? await (agent ?? deterministicReview)(prepared.evidence) : retentionReviewDraft);
  const publish = createCommandHandler(db, {
    modules: [companion],
    hooks: { async onFactsChanged(tx, tick) {
      const current = await readTodo(tx, todoId);
      if (current?.revision !== prepared.todo.revision || !(await readReadyWork(tx, ref)) ||
          !(await eligibleBasis(tx, current.spec, settingsId, tariff)) || !await completeTodo(tx, tick, ref, current, id))
        throw new ResearchBasisChanged('工作单已失效。');
      await enqueueWork(tx, tick, wake);
    } },
  });
  const receipt = await whenAvailable(() => publish({
    ...scope, actor: 'companion', purpose: researchPurpose, type: publishWorksheet,
    id: commandId,
    input: { id, todoId, basis: prepared.basis, draft,
      ...(model && {actualUsdMicros:runner.actualUsdMicros(), references:prepared.todo.spec.refs.map(({id, revision, accessEpoch, anchor}) => ({id,revision,accessEpoch,anchor:anchor!}))}),
      method: model ? profile : agent && prepared.evidence ? 'local-agent' : 'deterministic-v1', questionNumber: prepared.evidence?.questionNumber ?? 1 },
  }));
  if (!receipt) await cancelWork(db, ref);
  return true;
}
