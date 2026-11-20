import { installErasureFence, migrateLifecycle, requireLifecycleCutover } from './lifecycle.ts';
import type { Db, DbQuery } from './db/types.ts';
import { newUlid } from './work/identity.ts';
import { migrateTodoWork } from './work/migrate-todos.ts';
import { migrateWorkingState } from './work/todos.ts';

// Version 1 also describes databases created before migrations were recorded.
export const kernelSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS learners (
    id text PRIMARY KEY,
    clock bigint NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS facts (
    learner_id text NOT NULL REFERENCES learners(id),
    id text NOT NULL,
    type text NOT NULL,
    current_rev integer NOT NULL,
    access_epoch bigint NOT NULL DEFAULT 0,
    purpose text[] NOT NULL DEFAULT '{storage}',
    sticky boolean NOT NULL DEFAULT false,
    retracted_rev integer,
    created_tick bigint NOT NULL,
    changed_tick bigint NOT NULL,
    PRIMARY KEY (learner_id, id),
    UNIQUE (id, learner_id),
    CHECK (current_rev > 0),
    CHECK (retracted_rev IS NULL OR retracted_rev = current_rev)
  )`,
  `CREATE TABLE IF NOT EXISTS fact_revs (
    learner_id text NOT NULL,
    fact_id text NOT NULL,
    rev integer NOT NULL,
    data jsonb NOT NULL,
    purpose text[] NOT NULL,
    sticky boolean NOT NULL,
    source_derivation_id text,
    kind text NOT NULL,
    author text NOT NULL,
    command_id text NOT NULL,
    tick bigint NOT NULL,
    corrects_rev integer,
    PRIMARY KEY (learner_id, fact_id, rev),
    FOREIGN KEY (fact_id, learner_id) REFERENCES facts(id, learner_id),
    CHECK (rev > 0),
    CHECK (kind IN ('value', 'retraction'))
  )`,
  `CREATE TABLE IF NOT EXISTS commands (
    learner_id text NOT NULL REFERENCES learners(id),
    id text NOT NULL,
    type text NOT NULL,
    input jsonb NOT NULL,
    state text NOT NULL,
    receipt jsonb,
    tick bigint,
    undo_command_id text,
    PRIMARY KEY (learner_id, id),
    CHECK (state IN ('done', 'undone', 'proposed', 'rejected'))
  )`,
  `CREATE TABLE IF NOT EXISTS proposals (
    learner_id text NOT NULL,
    command_id text NOT NULL,
    source_derivation_id text,
    input jsonb NOT NULL,
    state text NOT NULL,
    created_tick bigint NOT NULL,
    decided_tick bigint,
    error jsonb,
    PRIMARY KEY (learner_id, command_id),
    FOREIGN KEY (command_id, learner_id) REFERENCES commands(id, learner_id),
    CHECK (state IN ('pending', 'confirmed', 'rejected', 'conflict'))
  )`,
  `CREATE TABLE IF NOT EXISTS derivations (
    learner_id text NOT NULL REFERENCES learners(id),
    id text NOT NULL,
    slot_type text NOT NULL,
    slot_key text NOT NULL,
    deriver text NOT NULL,
    scope_keys jsonb NOT NULL,
    value jsonb,
    lifecycle text NOT NULL,
    freshness text NOT NULL,
    gather_tick bigint NOT NULL,
    effective_tick bigint,
    selection_ended_tick bigint,
    invalidated_tick bigint,
    manifest jsonb NOT NULL,
    error jsonb,
    is_shadow boolean NOT NULL DEFAULT false,
    PRIMARY KEY (learner_id, id),
    UNIQUE (id, learner_id),
    CHECK (lifecycle IN ('candidate', 'effective', 'superseded', 'stale', 'rejected', 'failed')),
    CHECK (freshness IN ('current', 'behind')),
    CHECK (lifecycle <> 'effective' OR effective_tick IS NOT NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS slot_state (
    learner_id text NOT NULL REFERENCES learners(id),
    slot_type text NOT NULL,
    slot_key text NOT NULL,
    current_id text,
    last_id text,
    pending text NOT NULL DEFAULT 'none',
    last_error jsonb,
    changed_tick bigint NOT NULL DEFAULT 0,
    scope_keys jsonb NOT NULL,
    evidence_eligible boolean NOT NULL DEFAULT false,
    PRIMARY KEY (learner_id, slot_type, slot_key),
    UNIQUE (slot_type, slot_key, learner_id),
    FOREIGN KEY (current_id, learner_id) REFERENCES derivations(id, learner_id),
    FOREIGN KEY (last_id, learner_id) REFERENCES derivations(id, learner_id),
    CHECK (pending IN ('none', 'queued', 'running', 'waiting'))
  )`,
  `CREATE TABLE IF NOT EXISTS work (
    learner_id text NOT NULL REFERENCES learners(id),
    id text NOT NULL,
    slot_type text NOT NULL,
    slot_key text NOT NULL,
    deriver text NOT NULL,
    state text NOT NULL,
    gather jsonb,
    gather_manifest jsonb,
    attempt integer NOT NULL DEFAULT 0,
    token text,
    lease_expires_at timestamptz,
    PRIMARY KEY (learner_id, id),
    UNIQUE (learner_id, slot_type, slot_key),
    FOREIGN KEY (slot_type, slot_key, learner_id) REFERENCES slot_state(slot_type, slot_key, learner_id),
    CHECK (state IN ('ready', 'running', 'waiting'))
  )`,
  `CREATE TABLE IF NOT EXISTS work_waits (
    learner_id text NOT NULL,
    work_id text NOT NULL,
    slot_type text NOT NULL,
    slot_key text NOT NULL,
    observed_change_tick bigint NOT NULL,
    PRIMARY KEY (learner_id, work_id, slot_type, slot_key),
    FOREIGN KEY (work_id, learner_id) REFERENCES work(id, learner_id)
  )`,
  `CREATE TABLE IF NOT EXISTS effects (
    learner_id text NOT NULL REFERENCES learners(id),
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    step_key text NOT NULL,
    label text NOT NULL,
    input_digest text NOT NULL,
    provider_effect_id text,
    state text NOT NULL,
    result jsonb,
    error jsonb,
    started_tick bigint NOT NULL,
    ended_tick bigint,
    PRIMARY KEY (learner_id, owner_kind, owner_id, step_key, label),
    CHECK (owner_kind IN ('derivation', 'session')),
    CHECK (state IN ('started', 'done', 'unknown'))
  )`,
] as const;

async function migrateDurableWork(tx: DbQuery): Promise<void> {
  await tx.query(`ALTER TABLE work
    ADD COLUMN generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
    ADD COLUMN requested_tick bigint NOT NULL DEFAULT 0,
    ADD COLUMN execution_ref text UNIQUE,
    DROP CONSTRAINT work_state_check`);
  // A legacy attempt cannot carry its lease or old snapshot across the cutover.
  // If it might already have paid for an effect, keep it blocked for reconciliation.
  await tx.query(`UPDATE work w
    SET state = CASE WHEN (w.state = 'running' OR w.attempt > 0) AND EXISTS (
      SELECT 1 FROM effects e
      LEFT JOIN derivations d ON d.learner_id = e.learner_id AND d.id = e.owner_id
      WHERE e.learner_id = w.learner_id AND e.owner_kind = 'derivation'
        AND (d.id IS NULL OR (d.slot_type = w.slot_type AND d.slot_key = w.slot_key))
    ) THEN 'blocked' ELSE 'ready' END,
    gather = NULL, gather_manifest = NULL
    WHERE w.state IN ('ready', 'running')`);
  await tx.query(`UPDATE slot_state s SET pending = CASE w.state
    WHEN 'ready' THEN 'queued' WHEN 'waiting' THEN 'waiting' ELSE 'none' END
    FROM work w
    WHERE s.learner_id = w.learner_id AND s.slot_type = w.slot_type AND s.slot_key = w.slot_key`);
  await tx.query(`ALTER TABLE work
    DROP COLUMN attempt, DROP COLUMN token, DROP COLUMN lease_expires_at,
    ADD CHECK (state IN ('ready', 'waiting', 'satisfied', 'cancelled', 'blocked', 'unavailable', 'denied'))`);
  await tx.query(`CREATE TABLE work_outbox (
    learner_id text NOT NULL,
    intent_id text NOT NULL,
    work_id text NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    state text NOT NULL CHECK (state IN ('pending', 'delivered')),
    PRIMARY KEY (learner_id, intent_id),
    UNIQUE (learner_id, work_id, generation),
    FOREIGN KEY (learner_id, work_id) REFERENCES work(learner_id, id)
  )`);
  await tx.query("CREATE INDEX work_outbox_pending_idx ON work_outbox(intent_id) WHERE state = 'pending'");

  const { rows } = await tx.query<{ learner_id: string; id: string }>(
    "SELECT learner_id, id FROM work WHERE state = 'ready'",
  );
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await tx.query(`WITH allocated AS (
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(learner_id, id, intent_id)
    ), ready AS (
      UPDATE work w SET execution_ref = a.intent_id FROM allocated a
      WHERE w.learner_id = a.learner_id AND w.id = a.id
      RETURNING w.learner_id, w.execution_ref, w.id, w.generation
    )
    INSERT INTO work_outbox (learner_id, intent_id, work_id, generation, state)
    SELECT learner_id, execution_ref, id, generation, 'pending' FROM ready`,
    [batch.map(row => row.learner_id), batch.map(row => row.id), batch.map(() => newUlid())]);
  }
  await tx.query("ALTER TABLE work ADD CHECK (state <> 'ready' OR execution_ref IS NOT NULL)");
}

const migrations = [
  async (tx: DbQuery) => {
    for (const statement of kernelSchemaStatements) await tx.query(statement);
  },
  migrateDurableWork,
  async (tx: DbQuery) => {
    await tx.query('ALTER TABLE work_outbox ADD CONSTRAINT work_outbox_intent_unique UNIQUE (intent_id)');
  },
  async (tx: DbQuery) => {
    await tx.query(`CREATE TABLE kernel_runtime_identity (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      store_id text NOT NULL UNIQUE,
      minimum_worker_schema integer NOT NULL CHECK (minimum_worker_schema > 0)
    )`);
    await tx.query('INSERT INTO kernel_runtime_identity(store_id, minimum_worker_schema) VALUES ($1, $2)', [newUlid(), 4]);
  },
  async (tx: DbQuery) => {
    await tx.query("ALTER TABLE facts ALTER COLUMN purpose SET DEFAULT '{storage}'");
  },
  migrateWorkingState,
  migrateTodoWork,
  migrateLifecycle,
  async (tx: DbQuery) => {
    await tx.query(`ALTER TABLE work_outbox DROP CONSTRAINT work_outbox_state_check,
      ADD CHECK (state IN ('pending', 'capability_pending', 'delivered'))`);
    await tx.query("CREATE INDEX work_outbox_capability_pending_idx ON work_outbox(intent_id) WHERE state='capability_pending'");
  },
  async (tx: DbQuery) => {
    await tx.query(`ALTER TABLE work_outbox DROP CONSTRAINT work_outbox_state_check,
      ADD CHECK (state IN ('pending', 'capability_pending', 'delivered', 'routed_pending', 'routed_delivered'))`);
    await tx.query("CREATE INDEX work_outbox_routed_pending_idx ON work_outbox(intent_id) WHERE state='routed_pending'");
  },
  async (tx: DbQuery) => {
    for (const ledger of ['effects', 'erased_effect_receipts']) {
      await tx.query(`ALTER TABLE ${ledger}
        ADD COLUMN reserved_usd_micros bigint CHECK (reserved_usd_micros > 0),
        ADD COLUMN actual_usd_micros bigint CHECK (actual_usd_micros IS NULL OR (actual_usd_micros >= 0 AND reserved_usd_micros IS NOT NULL)),
        ADD COLUMN budget_route text,
        ADD CHECK ((budget_route IS NULL) = (reserved_usd_micros IS NULL))`);
      await tx.query(`CREATE INDEX ${ledger}_budget_idx ON ${ledger}(learner_id) WHERE reserved_usd_micros IS NOT NULL`);
    }
    // An older erasure writer would discard the monetary fields during compaction.
    await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=11');
  },
  async (tx: DbQuery) => {
    await tx.query(`ALTER TABLE effects
      ADD COLUMN consumed_tick bigint,
      ADD COLUMN consumer_todo_id text,
      ADD CHECK (consumed_tick IS NULL OR (reserved_usd_micros IS NOT NULL AND state<>'started')),
      ADD CHECK (consumer_todo_id IS NULL OR (consumed_tick IS NOT NULL AND state='done'))`);
    await installErasureFence(tx, true);
    await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=12');
  },
] as const;

/** A compatible older build may resume work while a newer process owns migrations. */
export async function workerStorage(db: DbQuery): Promise<string> {
  const { rows: [row] } = await db.query<{ store_id: string; minimum_worker_schema: number; version: number }>(
    `SELECT store_id, minimum_worker_schema, (SELECT max(version) FROM kernel_schema_migrations) AS version
     FROM kernel_runtime_identity WHERE singleton`,
  );
  if (!row || row.version < migrations.length || row.minimum_worker_schema > migrations.length) {
    throw new Error('Worker is incompatible with the installed kernel schema');
  }
  return row.store_id;
}

export async function applyKernelSchema(db: Db): Promise<void> {
  await db.schemaTransaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(7264040, hashtext(current_schema()::text))');
    await tx.query('CREATE TABLE IF NOT EXISTS kernel_schema_migrations (version integer PRIMARY KEY CHECK (version > 0))');
    const { rows: applied } = await tx.query<{ version: number }>(
      'SELECT version FROM kernel_schema_migrations ORDER BY version',
    );
    if (applied.length > migrations.length || applied.some((row, index) => row.version !== index + 1)) {
      throw new Error('Unsupported kernel schema version');
    }
    if (applied.length >= 6 && applied.length < 8) await requireLifecycleCutover(tx);
    for (const [index, migrate] of migrations.entries()) {
      if (index < applied.length) continue;
      await migrate(tx);
      await tx.query('INSERT INTO kernel_schema_migrations (version) VALUES ($1)', [index + 1]);
    }
  });
}
