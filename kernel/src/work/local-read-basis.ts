import type { ReadTransaction } from '../db/types.ts';

export async function readLocalReceiptBases<T>(tx: ReadTransaction, turns: readonly string[], label: string, key: string) {
  const {rows} = await tx.query<{basis:T}>(
    `SELECT receipt->($4::text) AS basis FROM effects
     CROSS JOIN LATERAL (SELECT CASE WHEN label=$3 AND jsonb_typeof(result)='string' THEN (result #>> '{}')::jsonb END AS receipt) decoded
     WHERE learner_id=$1 AND owner_kind='session' AND owner_id=ANY($2::text[])
       AND label=$3 AND state='done' AND receipt ? $4`, [tx.learner, turns, label, key]);
  return rows.map(({basis}) => basis);
}
