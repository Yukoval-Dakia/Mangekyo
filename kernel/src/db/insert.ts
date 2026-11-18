import type { DbTransaction, QueryResult, SqlValue } from './types.ts';

export async function scopedInsert<Row>(
  tx: DbTransaction,
  table: string,
  values: Readonly<Record<string, SqlValue>>,
): Promise<QueryResult<Row>> {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) {
    throw new Error('Invalid table name');
  }
  const entries = Object.entries(values);
  if (entries.length === 0 || entries.some(([column]) => !/^[a-z][a-z0-9_]*$/.test(column))) {
    throw new Error('Insert requires valid columns');
  }
  const learner = values.learner_id;
  if (learner !== tx.learner) {
    throw new Error('Insert learner does not match transaction scope');
  }
  const columns = entries.map(([column]) => column).join(', ');
  const parameters = entries.map((_, index) => `$${index + 1}`).join(', ');
  return tx.query<Row>(
    `INSERT INTO ${table} (${columns}) VALUES (${parameters})`,
    entries.map(([, value]) => value),
  );
}
