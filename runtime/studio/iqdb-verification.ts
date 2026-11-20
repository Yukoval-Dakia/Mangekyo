import { FactNotFoundError, guardAccess } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { derivationId, factId, learnerId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { EffectRequest, FactSnapshot, Json, Outcome, ReadContext } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, requestWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { readQuestionState } from '../../modules/content/question-state.ts';
import {
  gather, questionVerificationEffectResult, questionVerificationKey, questionVerificationType, settle,
  type QuestionVerificationEffectReceipt,
} from '../../modules/content/question-verification.ts';
import deriver from '../../modules/content/derivers/question-verification.ts';
import { purpose } from './identity.ts';

export type QuestionEffectHost = {
  mayReceive(request: EffectRequest, fact: FactSnapshot): boolean;
  invoke(request: EffectRequest, invocationId: string): Promise<Json>;
};

const policy: CandidatePolicy = { slot: { type: questionVerificationType }, deriver: deriver.name, purpose };
const propagation = createPropagationHooks([]);
type QuestionVersion = { id: FactId; rev: Revision; recheck: number };

export function readCurrentQuestionVerification(tx: ReadTransaction): ReadContext['slot'] {
  return async <Value>(slot: Parameters<ReadContext['slot']>[0], { mode }: Parameters<ReadContext['slot']>[1]) => {
    if (mode !== 'following' || slot.type !== questionVerificationType || slot.learner !== tx.learner)
      throw new FactNotFoundError('核验槽不可用。');
    const { rows: [current] } = await tx.query<{ id: string; value: Outcome<Value>; manifest: unknown }>(
      `SELECT d.id,d.value,d.manifest FROM slot_state s JOIN derivations d
       ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
       WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND s.last_error IS NULL
         AND d.deriver=$4 AND d.lifecycle='effective' AND d.freshness='current' AND NOT d.is_shadow
         AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NULL AND d.effective_tick IS NOT NULL`,
      [tx.learner, slot.type, slot.key, policy.deriver],
    );
    const manifest = current && parseManifest(current.manifest);
    if (!current || manifest?.purpose !== purpose || (await revalidateManifest(tx, manifest)).kind !== 'valid')
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

export async function executeQuestionVerification(db: Db, ref: WorkRef, host?: QuestionEffectHost, terminal = false) {
  if (!host || terminal) { await failWork(db, ref); return; }
  const scope = { learner: learnerId(ref.learner), purpose };
  const work = await db.snapshot(scope, tx => readReadyWork(tx, ref));
  if (!work || work.deriver !== policy.deriver || work.slotType !== policy.slot.type) return;
  const [question, revision, generation] = work.slotKey.split(':');
  const version = { id: factId(question ?? ''), rev: Number(revision) as Revision, recheck: Number(generation) };
  if (!Number.isInteger(version.rev) || version.rev < 1 || !Number.isSafeInteger(version.recheck) ||
      version.recheck < 0 || questionVerificationKey(version) !== work.slotKey) {
    await failWork(db, ref); return;
  }
  const snapshot = await gatherSnapshot(db, scope, async ctx => {
    const { state } = await readQuestionState(ctx.read, version.id);
    if (state.recheck !== version.recheck) throw new FactNotFoundError('题目复验代次已变。');
    return gather(ctx, version);
  });
  const sealed = await sealCandidate(db, ref, policy, snapshot);
  if (sealed.kind !== 'sealed') return;
  const receipts: QuestionVerificationEffectReceipt[] = [];
  for (const request of sealed.plan.effects) {
    const authorize = async (tx: ReadTransaction) => {
      if (!await readReadyWork(tx, ref) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid')
        throw new FactNotFoundError('核验依据已变化。');
      for (const input of sealed.manifest.inputs) {
        if (input.kind !== 'fact') throw new Error('核验依据必须是已打开的事实。');
        await guardAccess(tx, input, { purpose, maySend: fact => host.mayReceive(request, fact) });
      }
    };
    const receipt = await runEffect(db, { ...scope, ownerKind: 'derivation', ownerId: sealed.id, ...request }, async invocationId => {
      const { result } = await db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await authorize(tx);
        return { result: host.invoke(request, invocationId).then(value => ({ value }), () => null) };
      });
      const reply = await result;
      if (!reply) throw new Error('核验接收方未给出确定回执。');
      return questionVerificationEffectResult(invocationId, reply.value);
    }, authorize);
    receipts.push(receipt.kind === 'done'
      ? { ownerId: sealed.id, request, state: 'done', result: receipt.result }
      : { ownerId: sealed.id, request, state: 'unknown' });
  }
  await submitCandidate(db, ref, policy, sealed.id, settle(sealed, receipts), propagation);
}
