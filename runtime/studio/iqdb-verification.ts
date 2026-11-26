import { openLocalQuestionVerifiers } from '../../executors/teaching/iqdb-local-effect.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { readCurrentSlotOutcome } from '../../kernel/src/derivations/revalidate.ts';
import {
  createPropagationHooks, FactNotFoundError, guardAccess, readSlotStatus, revalidateManifest,
  type Db, type DbTransaction, type ReadContext, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { failWork, readReadyWork, requestCatalogedWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import deriver from '../../modules/content/derivers/question-verification.ts';
import { bindQuestionExecution, independentQuestionExecutions, matchesQuestionExecution, verificationSteps } from '../../modules/content/question-effects.ts';
import { parseQuestionVerificationKey, readQuestionState } from '../../modules/content/question-state.ts';
import { gather, questionVerificationEffectResult, questionVerificationKey, questionVerificationType, settle, type QuestionVerificationEffectReceipt } from '../../modules/content/question-verification.ts';
import { purpose, studioHost } from './identity.ts';
const policy: CandidatePolicy = { slot: { type: questionVerificationType }, deriver: deriver.name, purpose }, propagation = createPropagationHooks([]);
type QuestionVersion = NonNullable<ReturnType<typeof parseQuestionVerificationKey>>;
export async function openLocalQuestionEffects(setting?: string) {
  if (!setting) return undefined;
  try {
    const targets = await openLocalQuestionVerifiers(setting, verificationSteps.map(step => step.stepKey));
    if (!independentQuestionExecutions([...targets.values()].map(target => target.execution))) throw new Error('多个核验步骤使用了同一可执行模块。');
    return targets;
  } catch { console.error('题库独立核验不可用。请为三次求解和契约验收分别配置本机核验模块。'); return undefined; }
}
export function readCurrentQuestionVerification(tx: ReadTransaction): ReadContext['slot'] {
  return async <Value>(slot: Parameters<ReadContext['slot']>[0], { mode }: Parameters<ReadContext['slot']>[1]) => {
    if (mode !== 'following' || slot.type !== questionVerificationType || slot.learner !== tx.learner) throw new FactNotFoundError('核验槽不可用。');
    const outcome = await readCurrentSlotOutcome<Value>(tx, slot, policy.deriver, purpose);
    if (!outcome) throw new FactNotFoundError('需要当前有效的独立核验。');
    return outcome;
  };
}
export async function enqueueQuestionVerification(tx: DbTransaction, version: QuestionVersion) {
  const slotKey = questionVerificationKey(version), order = { slotType: questionVerificationType, slotKey, deriver: policy.deriver };
  if (await readSlotStatus(tx, order.slotType, slotKey)) return;
  await tx.withLearnerWrite(tick => requestCatalogedWork(tx, tick, order, JSON.stringify(version)));
}
export async function executeQuestionVerification(db: Db, ref: WorkRef, host: Awaited<ReturnType<typeof openLocalQuestionEffects>>, terminal = false) {
  if (!host || terminal) return void await failWork(db, ref);
  const learnerHost = studioHost(db), scope = { learner: learnerHost.learner, purpose };
  const work = await learnerHost.snapshot(tx => readReadyWork(tx, ref));
  if (!work || work.deriver !== policy.deriver || work.slotType !== policy.slot.type) return;
  const version = parseQuestionVerificationKey(work.slotKey);
  if (!version) return void await failWork(db, ref);
  const snapshot = await gatherSnapshot(db, scope, async ctx => {
    if ((await readQuestionState(ctx.read, version.id)).state.recheck !== version.recheck) throw new FactNotFoundError('题目复验代次已变。');
    const plan = await gather(ctx, version);
    return { ...plan, effects: plan.effects.map(request => bindQuestionExecution(request, host.get(request.stepKey)!.execution)) };
  });
  const sealed = await sealCandidate(db, ref, policy, snapshot);
  if (sealed.kind !== 'sealed') return;
  const failCandidate = (reason: string) => submitCandidate(db, ref, policy, sealed.id, { kind: 'failed', reason }, propagation);
  const targets = sealed.plan.effects.map(request => ({ request, target: host.get(request.stepKey) }));
  if (targets.some(({ request, target }) => !target || !matchesQuestionExecution(request, target.execution)))
    return void await failCandidate('已封存的核验模块已变更，请重新核验。');
  const receipts: QuestionVerificationEffectReceipt[] = [];
  for (const { request, target } of targets) {
    if (!target) throw new Error('缺少已封存的核验模块。');
    const authorize = async (tx: ReadTransaction) => {
      if (!await readReadyWork(tx, ref) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid') throw new FactNotFoundError('核验依据已变化。');
      for (const input of sealed.manifest.inputs) {
        if (input.kind !== 'fact') throw new Error('核验依据必须是已打开的事实。');
        await guardAccess(tx, input, { purpose, maySend: () => true });
      }
    };
    const receipt = await runEffect(db, { ...scope, ownerKind: 'derivation', ownerId: sealed.id, ...request }, async invocationId => {
      const { result } = await learnerHost.lockedTx(async tx => {
        await authorize(tx);
        return { result: target.invoke(request, invocationId).then(value => ({ value }), () => null) };
      });
      const reply = await result;
      if (!reply) throw new Error('核验接收方未给出确定回执。');
      return questionVerificationEffectResult(invocationId, reply.value, target.execution);
    }, authorize, { manifest: sealed.manifest, work: ref });
    if (receipt.kind === 'unknown') return void await failCandidate('独立核验回执待核对。');
    receipts.push({ ownerId: sealed.id, request, state: 'done', result: receipt.result });
  }
  await submitCandidate(db, ref, policy, sealed.id, settle(sealed, receipts), propagation);
}
