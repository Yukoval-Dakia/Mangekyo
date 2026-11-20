import type { Db, DbTransaction, DbQuery, LearnerId, Tick } from './types.ts';

export async function lockLearner(tx: DbQuery, learner: LearnerId): Promise<void> {
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM learners WHERE id = $1 FOR UPDATE',
    [learner],
  );
  if (result.rows.length !== 1) {
    throw new Error('Learner does not exist');
  }
}

export async function nextTick(tx: DbQuery, learner: LearnerId): Promise<Tick> {
  const result = await tx.query<{ clock: string | bigint | number }>(
    'UPDATE learners SET clock = clock + 1 WHERE id = $1 RETURNING clock',
    [learner],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Learner does not exist');
  }
  return row.clock.toString() as Tick;
}

export function withinLearnerTransaction(db: Db, tx: DbTransaction): Db {
  const nested: Db['tx'] = async (scope, run) => {
    if (scope.learner !== tx.learner) throw new Error('Transaction learner mismatch');
    return run(tx);
  };
  return {...db, query: tx.query, snapshot: nested, tx: nested};
}
