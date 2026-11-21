import pg from 'pg';
import { scopedInsert } from './insert.ts';
import { lockLearner, nextTick } from './learner.ts';
import type { Db, DbQuery, DbTransaction, LearnerScope, ReadTransaction, SnapshotOptions, SqlValue, Tick } from './types.ts';

export function createPgDb(
  pool: pg.Pool,
  options: { readonly schema?: string } = {},
): Db {
  if (options.schema !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(options.schema)) {
    throw new Error('Invalid PostgreSQL schema');
  }
  const initialize = async (client: pg.PoolClient) => {
    if (options.schema) await client.query(`SET search_path TO ${options.schema}`);
  };
  const connect = async () => {
    const client = await pool.connect();
    try {
      await initialize(client);
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  };
  return {
    async query<Row>(sql: string, params: readonly SqlValue[] = []) {
      const client = await connect();
      try {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
      } finally {
        client.release();
      }
    },
    async schemaTransaction<Result>(run: (tx: DbQuery) => Promise<Result>) {
      const client = await connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const result = await run({
          async query<Row>(sql: string, params: readonly SqlValue[] = []) {
            const result = await client.query(sql, [...params]);
            return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async snapshot<Result>(scope: LearnerScope, read: (tx: ReadTransaction) => Promise<Result>,
      {lockLearner: locked = false}: SnapshotOptions = {}) {
      for (let attempt = 1; ; attempt++) {
        const client = await connect();
        try {
          // PostgreSQL needs a writable transaction to acquire the row lock.
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ' + (locked ? '' : ' READ ONLY'));
          const tx: ReadTransaction = { ...scope, query: async <Row>(sql: string, params: readonly SqlValue[] = []) => {
            const result = await client.query(sql, [...params]);
            return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
          } };
          if (locked) await lockLearner(tx,scope.learner);
          const result = await read(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          // Waiting behind a writer can invalidate the snapshot used to acquire the lock.
          if (!(locked && attempt < 3 && error instanceof pg.DatabaseError && error.code === '40001')) throw error;
        } finally {
          client.release();
        }
      }
    },
    async tx<Result>(scope: LearnerScope, run: (tx: DbTransaction) => Promise<Result>) {
      const client = await connect();
      try {
        await client.query('BEGIN');
        const tx: DbTransaction = {
          ...scope,
          async query<Row>(sql: string, params: readonly SqlValue[] = []) {
            const result = await client.query(sql, [...params]);
            return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
          },
          insert: (table, values) => scopedInsert(tx, table, values),
          async withLearnerWrite<Result>(write: (tick: Tick) => Promise<Result>) {
            await lockLearner(tx, scope.learner);
            const tick = await nextTick(tx, scope.learner);
            return write(tick);
          },
        };
        const result = await run(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
