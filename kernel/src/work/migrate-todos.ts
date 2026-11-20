import type { DbQuery } from '../db/types.ts';

/** V7 keeps both public identities: slot_key is the todo ID, id is the durable workflow's work ID. */
export async function migrateTodoWork(tx: DbQuery) {
  await tx.query('LOCK TABLE working_todos, work IN ACCESS EXCLUSIVE MODE');
  await tx.query(`ALTER TABLE work
    DROP CONSTRAINT work_state_check,
    ADD COLUMN family text NOT NULL DEFAULT 'derivation' CHECK (family IN ('derivation','todo')),
    ADD COLUMN spec jsonb,
    ADD COLUMN trigger text GENERATED ALWAYS AS (COALESCE(spec #>> '{trigger,kind}', 'immediate')) STORED,
    ADD COLUMN fire_at bigint GENERATED ALWAYS AS ((spec #>> '{trigger,fireAtMs}')::bigint) STORED,
    ADD COLUMN event_match jsonb GENERATED ALWAYS AS (spec #> '{trigger,event}') STORED,
    ADD COLUMN dedup_key text GENERATED ALWAYS AS (spec->>'dedupKey') STORED,
    ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 2),
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN chain_id text,
    ADD COLUMN hop_count integer CHECK (hop_count BETWEEN 0 AND 3),
    ADD COLUMN registered_tick bigint,
    ADD COLUMN result_id text,
    ADD CHECK (state IN ('pending','ready','waiting','satisfied','cancelled','blocked','unavailable','denied'))`);
  // A previously completed publication may still be awaiting its final finishWork callback.
  // Preserve its result and fence the already delivered workflow in the same commit.
  await tx.query(`UPDATE work w SET family='todo', spec=t.spec, revision=t.revision,
    chain_id=t.chain_id, hop_count=t.hop_count, registered_tick=t.registered_tick, result_id=t.result_id,
    state=CASE t.state WHEN 'pending' THEN 'pending' WHEN 'completed' THEN 'satisfied'
      WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'blocked' ELSE w.state END
    FROM working_todos t WHERE w.learner_id=t.learner_id AND w.slot_type='working.todo' AND w.slot_key=t.todo_id`);
  await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,scope_keys,changed_tick)
    SELECT learner_id,'working.todo',todo_id,'{}',registered_tick FROM working_todos ON CONFLICT DO NOTHING`);
  await tx.query(`INSERT INTO work (learner_id,id,slot_type,slot_key,deriver,state,family,spec,revision,
    chain_id,hop_count,registered_tick,requested_tick,result_id)
    SELECT learner_id,todo_id,'working.todo',todo_id,spec->>'workerProfile',
      CASE state WHEN 'pending' THEN 'pending' WHEN 'completed' THEN 'satisfied'
        WHEN 'cancelled' THEN 'cancelled' WHEN 'failed' THEN 'blocked' END,
      'todo',spec,revision,chain_id,hop_count,registered_tick,registered_tick,result_id
    FROM working_todos t WHERE NOT EXISTS (SELECT 1 FROM work w WHERE
      w.learner_id=t.learner_id AND w.slot_type='working.todo' AND w.slot_key=t.todo_id)`);
  await tx.query(`UPDATE slot_state s SET pending='none' FROM work w WHERE w.family='todo'
    AND w.state NOT IN ('ready','waiting') AND (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key)`);
  await tx.query(`ALTER TABLE work ADD CHECK (family <> 'todo' OR
    (slot_type='working.todo' AND spec IS NOT NULL AND dedup_key IS NOT NULL AND chain_id IS NOT NULL
      AND hop_count IS NOT NULL AND registered_tick IS NOT NULL AND (state='satisfied')=(result_id IS NOT NULL)))`);
  await tx.query(`CREATE UNIQUE INDEX work_active_todo ON work (learner_id,dedup_key)
    WHERE family='todo' AND state IN ('pending','ready','waiting')`);
  await tx.query('DROP TABLE working_todos');
  await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=7');
}
