import { PGlite } from '@electric-sql/pglite';
import { scopedInsert } from './insert.ts';
import { lockLearner, nextTick } from './learner.ts';
import type { Db, DbQuery, DbTransaction, LearnerScope, SqlValue, Tick } from './types.ts';

export function createPgliteDb(database: PGlite): Db {
  return {
    async query<Row>(sql: string, params: readonly SqlValue[] = []) {
      const result = await database.query<Row>(sql, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async schemaTransaction<Result>(run: (tx: DbQuery) => Promise<Result>) {
      return database.transaction(transaction => run({
        async query<Row>(sql: string, params: readonly SqlValue[] = []) {
          const result = await transaction.query<Row>(sql, [...params]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
      }));
    },
    async snapshot<Result>(scope: LearnerScope, read: (tx: import('./types.ts').ReadTransaction) => Promise<Result>) {
      return database.transaction(async (transaction) => {
        await transaction.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return read({ ...scope, query: async <Row>(sql: string, params: readonly SqlValue[] = []) => {
          const result = await transaction.query<Row>(sql, [...params]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        } });
      });
    },
    async tx<Result>(scope: LearnerScope, run: (tx: DbTransaction) => Promise<Result>) {
      return database.transaction(async (transaction) => {
        const tx: DbTransaction = {
          ...scope,
          async query<Row>(sql: string, params: readonly SqlValue[] = []) {
            const result = await transaction.query<Row>(sql, [...params]);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
          },
          insert: (table, values) => scopedInsert(tx, table, values),
          async withLearnerWrite<Result>(write: (tick: Tick) => Promise<Result>) {
            await lockLearner(tx, scope.learner);
            const tick = await nextTick(tx, scope.learner);
            return write(tick);
          },
        };
        return run(tx);
      });
    },
    close: () => database.close(),
  };
}
