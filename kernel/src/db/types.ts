import type { LearnerId, Tick } from '../declarations/ids.ts';

export { learnerId } from '../declarations/ids.ts';
export type { LearnerId, Tick } from '../declarations/ids.ts';

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Date | readonly SqlValue[];

export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly rowCount: number;
};

export type LearnerScope = {
  readonly learner: LearnerId;
};

export type DbQuery = {
  query<Row>(sql: string, params?: readonly SqlValue[]): Promise<QueryResult<Row>>;
};

export type ReadTransaction = DbQuery & LearnerScope;

export type DbTransaction = ReadTransaction & {
  insert<Row>(table: string, values: Readonly<Record<string, SqlValue>>): Promise<QueryResult<Row>>;
  withLearnerWrite<Result>(write: (tick: Tick) => Promise<Result>): Promise<Result>;
};

/** A learner-locked projection can be retried and must be side-effect-free. */
export type SnapshotOptions = { readonly lockLearner?: boolean };

export type Db = DbQuery & {
  schemaTransaction<Result>(run: (tx: DbQuery) => Promise<Result>): Promise<Result>;
  snapshot<Result>(scope: LearnerScope, read: (tx: ReadTransaction) => Promise<Result>, options?: SnapshotOptions): Promise<Result>;
  tx<Result>(scope: LearnerScope, run: (tx: DbTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
};
