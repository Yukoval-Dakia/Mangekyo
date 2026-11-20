import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteDb } from '../src/db/pglite.ts';
import { createPgDb } from '../src/db/pg.ts';
import type { Db } from '../src/db/types.ts';
import { applyKernelSchema } from '../src/schema.ts';

export const testDatabaseUrl = process.env.MANGEKYO_TEST_DATABASE_URL;

export async function withLearnerDatabase(learner: string, run: (db: Db) => Promise<void>,
  { postgres = true, initialize = applyKernelSchema, max = 10, connectionString = testDatabaseUrl } = {}) {
  if (postgres && !connectionString) throw new Error('Missing PostgreSQL test URL');
  const schema = 'test_' + randomBytes(8).toString('hex');
  const db = postgres
    ? createPgDb(new pg.Pool({ connectionString, max }), { schema })
    : createPgliteDb(new PGlite());
  try {
    if (postgres) await db.query('CREATE SCHEMA ' + schema);
    try {
      await initialize(db);
      await db.query('INSERT INTO learners (id) VALUES ($1)', [learner]);
      await run(db);
    } finally {
      if (postgres) await db.query('DROP SCHEMA ' + schema + ' CASCADE');
    }
  } finally {
    await db.close();
  }
}
