import { FactNotFoundError, guardAccess } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, learnerId } from '../../kernel/src/declarations/ids.ts';
import type { Outcome, ReadContext } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, requestWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { parseQuestionVerificationKey, readQuestionState } from '../../modules/content/question-state.ts';
import {
  gather, questionVerificationEffectResult, questionVerificationKey, questionVerificationType, settle,
  type QuestionVerificationEffectReceipt,
} from '../../modules/content/question-verification.ts';
import deriver from '../../modules/content/derivers/question-verification.ts';
import { purpose } from './identity.ts';
import { openLocalQuestionVerifier } from '../../executors/teaching/iqdb-local-effect.ts';
import { bindQuestionExecution, independentQuestionExecutions, matchesQuestionExecution, verificationSteps } from '../../modules/content/question-effects.ts';

const policy: CandidatePolicy = { slot: { type: questionVerificationType }, deriver: deriver.name, purpose };
const propagation = createPropagationHooks([]);
type QuestionVersion = NonNullable<ReturnType<typeof parseQuestionVerificationKey>>;

export async function openLocalQuestionEffects(setting?: string) {
  if (!setting) return undefined;
  try {
    const paths: unknown = JSON.parse(setting);
    if (!paths || typeof paths !== 'object' || Array.isArray(paths) || Object.keys(paths).length !== verificationSteps.length)
      throw new Error('核验需要四个独立模块。');
    const entries = await Promise.all(verificationSteps.map(async ({stepKey}) =>
      [stepKey, await openLocalQuestionVerifier(Reflect.get(paths, stepKey))] as const));
    if (!independentQuestionExecutions(entries.map(([, target]) => target.execution)))
      throw new Error('多个核验步骤使用了同一可执行模块。');
    const targets: ReadonlyMap<string, Awaited<ReturnType<typeof openLocalQuestionVerifier>>> = new Map(entries);
    return targets;
  } catch {
    console.error('题库独立核验不可用。请为三次求解和契约验收分别配置本机核验模块。');
    return undefined;
  }
}

export function readCurrentQuestionVerification(tx: ReadTransaction): ReadContext['slot'] {
  return async <Value>(slot: Parameters<ReadContext['slot']>[0], { mode }: Parameters<ReadContext['slot']>[1]) => {
    if (mode !== 'following' || slot.type !== questionVerificationType || slot.learner !== tx.learner)
      throw new FactNotFoundError('核验槽不可用。');
    const { rows: [current] } = await tx.query<{ id: string; value: Outcome<Value>; manifest: unknown; gather_tick: string }>(
      `SELECT d.id,d.value,d.manifest,d.gather_tick::text FROM slot_state s JOIN derivations d
       ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND s.last_error IS NULL
         AND d.deriver=$4 AND d.lifecycle='effective' AND d.freshness='current' AND NOT d.is_shadow
         AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NULL AND d.effective_tick>=d.gather_tick`,
      [tx.learner, slot.type, slot.key, policy.deriver],
    );
    const manifest = current && parseManifest(current.manifest);
    if (!current || manifest?.purpose !== purpose || manifest.gatherTick !== current.gather_tick ||
        (await revalidateManifest(tx, manifest)).kind !== 'valid')
      throw new FactNotFoundError('需要当前有效的独立核验。');
    return { id: derivationId(current.id), slot, outcome: current.value };
  };
}

export async function enqueueQuestionVerification(tx: DbTransaction, version: QuestionVersion) {
  const slotKey = questionVerificationKey(version);
  const order = { slotType: questionVerificationType, slotKey, deriver: policy.deriver };
  if ((await tx.query('SELECT 1 FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
    [tx.learner, order.slotType, slotKey])).rowCount) return;
  await tx.withLearnerWrite(async tick => {
    const inserted = await tx.query(
      `INSERT INTO slot_state(learner_id,slot_type,slot_key,scope_keys,evidence_eligible,changed_tick)
       VALUES($1,$2,$3,$4,false,$5) ON CONFLICT DO NOTHING`,
      [tx.learner, order.slotType, slotKey, JSON.stringify(version), tick],
    );
    if (inserted.rowCount === 1) await requestWork(tx, tick, order);
  });
}

export async function executeQuestionVerification(
  db: Db, ref: WorkRef, host: Awaited<ReturnType<typeof openLocalQuestionEffects>>, terminal = false,
) {
  if (!host || terminal) { await failWork(db, ref); return; }
  const scope = { learner: learnerId(ref.learner), purpose };
  const work = await db.snapshot(scope, tx => readReadyWork(tx, ref));
  if (!work || work.deriver !== policy.deriver || work.slotType !== policy.slot.type) return;
  const version = parseQuestionVerificationKey(work.slotKey);
  if (!version) { await failWork(db, ref); return; }
  const snapshot = await gatherSnapshot(db, scope, async ctx => {
    const { state } = await readQuestionState(ctx.read, version.id);
    if (state.recheck !== version.recheck) throw new FactNotFoundError('题目复验代次已变。');
    const plan = await gather(ctx, version);
    return { ...plan, effects: plan.effects.map(request => bindQuestionExecution(request, host.get(request.stepKey)!.execution)) };
  });
  const sealed = await sealCandidate(db, ref, policy, snapshot);
  if (sealed.kind !== 'sealed') return;
  const targets = sealed.plan.effects.map(request => ({request, target: host.get(request.stepKey)}));
  if (targets.some(({request, target}) => !target || !matchesQuestionExecution(request, target.execution))) {
    await submitCandidate(db, ref, policy, sealed.id, {kind:'failed', reason:'已封存的核验模块已变更，请重新核验。'}, propagation);
    return;
  }
  const receipts: QuestionVerificationEffectReceipt[] = [];
  for (const { request, target } of targets) {
    if (!target) throw new Error('缺少已封存的核验模块。');
    const authorize = async (tx: ReadTransaction) => {
      if (!await readReadyWork(tx, ref) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid')
        throw new FactNotFoundError('核验依据已变化。');
      for (const input of sealed.manifest.inputs) {
        if (input.kind !== 'fact') throw new Error('核验依据必须是已打开的事实。');
        await guardAccess(tx, input, { purpose, maySend: () => true });
      }
    };
    const receipt = await runEffect(db, { ...scope, ownerKind: 'derivation', ownerId: sealed.id, ...request }, async invocationId => {
      const { result } = await db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await authorize(tx);
        return { result: target.invoke(request, invocationId).then(value => ({ value }), () => null) };
      });
      const reply = await result;
      if (!reply) throw new Error('核验接收方未给出确定回执。');
      return questionVerificationEffectResult(invocationId, reply.value, target.execution);
    }, authorize, { manifest: sealed.manifest, work: ref });
    if (receipt.kind === 'unknown') {
      await submitCandidate(db, ref, policy, sealed.id, { kind: 'failed', reason: '独立核验回执待核对。' }, propagation);
      return;
    }
    receipts.push({ ownerId: sealed.id, request, state: 'done', result: receipt.result });
  }
  await submitCandidate(db, ref, policy, sealed.id, settle(sealed, receipts), propagation);
}
