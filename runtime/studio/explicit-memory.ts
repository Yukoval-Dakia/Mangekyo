import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { applyClaimCommand, ClaimTargetError, explicitClaimRequest } from '../../modules/companion/claim.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purpose, stableId, studioLearner } from './identity.ts';

const loadCompanion = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
let declarations: ReturnType<typeof loadCompanion> | undefined;

export async function applyExplicitMemory(db: Db, turnId: string, quote: string,
  authorize: (tx: ReadTransaction) => Promise<void>) {
  const action = explicitClaimRequest(quote);
  if (!action) return undefined;
  const turn = factId(turnId);
  const readSource = async (tx: ReadTransaction) => {
    const fact = await createCommandReadContext(tx, purpose).fact(turn, { mode: 'following' });
    const { rows: [origin] } = await tx.query<{ author: string }>(
      'SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3', [tx.learner, turn, fact.ref.rev]);
    if (fact.type !== 'activity.studyTurn' || origin?.author !== 'learner') throw new ClaimTargetError('缺少本轮本人原话。');
    const submission = studyTurn(fact.value);
    if (submission.caseId !== 'companion' || submission.answer !== quote) throw new ClaimTargetError('缺少本轮本人原话。');
    return { id: turn, rev: fact.ref.rev, accessEpoch: fact.accessEpoch };
  };
  try {
    const source = await db.snapshot({ learner: studioLearner }, readSource);
    const id = factId(stableId('explicit-claim', turn));
    const handle = createCommandHandler(db, { modules: [await (declarations ??= loadCompanion())],
      hooks: createStudioCommandHooks({ async afterFactsChanged(tx) {
        await authorize(tx);
        const current = await readSource(tx);
        if (current.rev !== source.rev || current.accessEpoch !== source.accessEpoch)
          throw new ClaimTargetError('原话版本已变化。');
      } }),
    });
    const receipt = await handle({ learner: studioLearner, actor: 'learner', purpose: 'storage',
      id: commandId(stableId('explicit-claim-command', turn)), type: applyClaimCommand, input: { id, source, quote } });
    const written = receipt.wrote.find(ref => ref.id === id);
    if (receipt.state !== 'done' || !written) return { message: '没有完成这次记忆修改。' };
    const label = action.action === 'forget' ? '已忘掉该条记忆' : action.action === 'correct' ? '已纠正记忆' : '已记住';
    return { message: `${label}。记录 ${written.id}，回执 ${receipt.commandId}。`, receipt: receipt.commandId };
  } catch (error) {
    if (error instanceof ClaimTargetError || error instanceof FactNotFoundError || error instanceof FactReadDeniedError)
      return { message: '没有修改记忆。请确认原话和当前有效的记忆记录。' };
    throw error;
  }
}
