import type { Db, ReadTransaction } from '../db/types.ts';
import { learnerId } from '../declarations/ids.ts';
import type { Json } from '../declarations/types.ts';
import { EffectBudgetExceeded, effectBudgetUsage, recordLocalRead, runEffect, type EffectBudget, type EffectRequest } from './effects.ts';

export async function runPricedOutput<Account>(db: Db, request: EffectRequest, outputLabel: string,
  authorize: (tx: ReadTransaction) => Promise<Account>, budget: EffectBudget, firstStageCap: number,
  invoke: (dispatch: <Response>(start: (account: Account) => Response) => Promise<Response>,
    save: (output: string) => Promise<string>, id: string) => Promise<Json>) {
  const scope = { learner: learnerId(request.learner) };
  const output = {...request,label:outputLabel};
  const recheck = async (tx: ReadTransaction) => { await authorize(tx); };
  const receipt = await runEffect(db, request, (id, checkDispatch) => invoke(start => db.tx(scope, async tx => {
    await checkDispatch(tx);
    return start(await authorize(tx));
  }), body => recordLocalRead(db, output, async () => body, async tx => {
    await checkDispatch(tx);
    await recheck(tx);
  }), id), async tx => {
    await recheck(tx);
    if (firstStageCap && !(await tx.query(`SELECT 1 FROM effects
      WHERE (learner_id,owner_kind,owner_id,step_key,label)=($1,$2,$3,$4,$5)`,
    [tx.learner, request.ownerKind, request.ownerId, request.stepKey, request.label])).rowCount) {
      const {held, settled} = await effectBudgetUsage(tx);
      if (held + settled + BigInt(firstStageCap) > BigInt(budget.limitUsdMicros)) throw new EffectBudgetExceeded();
    }
  }, undefined, budget);
  const result = receipt.kind === 'done' ? receipt.result : null;
  if (!result || typeof result !== 'object' || !('saved' in result) || result.saved !== true)
    throw new Error('Priced effect has no recoverable output');
  const body = await recordLocalRead(db, output, async () => { throw new Error('Priced effect output is missing'); }, recheck);
  return {body, actualUsdMicros: budget.actualUsdMicros(result)};
}
