import type { Db, DbTransaction, DbQuery, LearnerId, LearnerScope, Tick } from './types.ts';

export async function lockLearner(tx: DbQuery, learner: LearnerId): Promise<void> {
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM learners WHERE id = $1 FOR UPDATE',
    [learner],
  );
  if (result.rows.length !== 1) {
    throw new Error('Learner does not exist');
  }
}

export function withLearnerLock<T>(db: Db, scope: LearnerScope, run: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.tx(scope, async tx => {
    await lockLearner(tx, tx.learner);
    return run(tx);
  });
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
  return {...db, query:tx.query, tx:nested, snapshot(scope, read, options) {
    if (options?.lockLearner) throw new Error('A locked snapshot requires a new transaction');
    return nested(scope,read);
  }};
}
