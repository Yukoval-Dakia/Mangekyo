import type { DbQuery } from '../db/types.ts';

// Only the v6 SQL adapter needs to allocate identities inside PostgreSQL.
// 48-bit Unix milliseconds followed by 80 random bits, encoded as 26 Crockford digits.
export async function installWorkIdAllocator(tx: DbQuery) {
  await tx.query(`CREATE FUNCTION kernel_work_ulid() RETURNS text LANGUAGE sql VOLATILE AS $$
    WITH entropy AS MATERIALIZED (
      SELECT B'00' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::bit(48)
        || ('x' || left(replace(gen_random_uuid()::text, '-', ''), 12)
                || right(replace(gen_random_uuid()::text, '-', ''), 8))::bit(80) AS bits
    )
    SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
      1 + substring(bits FROM i FOR 5)::integer, 1), '' ORDER BY i)
    FROM entropy, generate_series(1, 126, 5) i
    $$`);
}

/** V6 workers can keep their pinned deployment, including a restart while a coordinator sleeps. */
export async function installLegacyTodoView(tx: DbQuery) {
  await tx.query(`CREATE VIEW working_todos AS SELECT learner_id, slot_key AS todo_id, dedup_key,
    spec - 'priority' AS spec, revision,
    CASE state WHEN 'pending' THEN 'pending' WHEN 'ready' THEN 'dispatched' WHEN 'waiting' THEN 'dispatched'
      WHEN 'satisfied' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END AS state,
    chain_id, hop_count, registered_tick, result_id FROM work WHERE family='todo'`);
  await tx.query(`CREATE FUNCTION write_v6_working_todo() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
    DECLARE
      current_tick bigint;
      new_intent text;
      work_row work%ROWTYPE;
    BEGIN
      IF NEW.spec->>'dedupKey' IS DISTINCT FROM NEW.dedup_key THEN
        RAISE EXCEPTION 'working_todos dedup key mismatch for %', NEW.todo_id;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'pending' THEN RAISE EXCEPTION 'v6 todo insertion requires pending'; END IF;
        INSERT INTO slot_state(learner_id,slot_type,slot_key,scope_keys,changed_tick)
          VALUES (NEW.learner_id,'working.todo',NEW.todo_id,'{}',NEW.registered_tick);
        INSERT INTO work(learner_id,id,slot_type,slot_key,family,deriver,state,spec,chain_id,hop_count,
                         registered_tick,requested_tick)
          VALUES (NEW.learner_id,kernel_work_ulid(),'working.todo',NEW.todo_id,'todo',NEW.spec->>'workerProfile',
                  'pending',NEW.spec,NEW.chain_id,NEW.hop_count,NEW.registered_tick,NEW.registered_tick);
        RETURN NEW;
      END IF;
      SELECT * INTO work_row FROM work WHERE learner_id=OLD.learner_id AND family='todo'
        AND slot_key=OLD.todo_id AND revision=OLD.revision FOR UPDATE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      IF OLD.state='pending' AND NEW.state='dispatched' THEN
        -- v6 immediately calls requestWork in this transaction. Matching requested_tick,
        -- deriver and ready state makes that call return this generation unchanged.
        SELECT clock INTO STRICT current_tick FROM learners WHERE id=OLD.learner_id;
        new_intent := kernel_work_ulid();
        UPDATE work SET state='ready', revision=NEW.revision, execution_ref=new_intent, requested_tick=current_tick
          WHERE learner_id=OLD.learner_id AND id=work_row.id;
        INSERT INTO work_outbox(learner_id,intent_id,work_id,generation,state)
          VALUES (OLD.learner_id,new_intent,work_row.id,work_row.generation,'pending');
        UPDATE slot_state SET pending='queued' WHERE learner_id=OLD.learner_id
          AND slot_key=OLD.todo_id AND slot_type='working.todo';
      ELSIF OLD.state='pending' AND NEW.state='pending' THEN
        UPDATE work SET spec=NEW.spec || CASE WHEN work_row.spec ? 'priority'
          THEN jsonb_build_object('priority', work_row.priority) ELSE '{}'::jsonb END,
          deriver=NEW.spec->>'workerProfile', registered_tick=NEW.registered_tick, revision=NEW.revision
          WHERE learner_id=OLD.learner_id AND id=work_row.id;
      ELSIF OLD.state IN ('pending','dispatched') AND
          (NEW.state='cancelled' OR OLD.state='dispatched' AND NEW.state IN ('completed','failed')) THEN
        UPDATE work SET state=CASE NEW.state WHEN 'completed' THEN 'satisfied' WHEN 'failed' THEN 'blocked'
          ELSE 'cancelled' END, result_id=NEW.result_id, revision=NEW.revision
          WHERE learner_id=OLD.learner_id AND id=work_row.id;
        UPDATE slot_state SET pending='none' WHERE learner_id=OLD.learner_id
          AND slot_key=OLD.todo_id AND slot_type='working.todo';
      ELSE
        RAISE EXCEPTION 'Unsupported v6 working_todos transition % to %', OLD.state, NEW.state;
      END IF;
      RETURN NEW;
    END $$`);
  await tx.query(`CREATE TRIGGER v6_todo_write INSTEAD OF INSERT OR UPDATE ON working_todos
    FOR EACH ROW EXECUTE FUNCTION write_v6_working_todo()`);
  // A v6 closeWork cancels/fails the work row directly, before reading its todo.
  await tx.query(`CREATE FUNCTION advance_v6_work_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END $$`);
  await tx.query(`CREATE TRIGGER v6_direct_close BEFORE UPDATE OF state ON work FOR EACH ROW
    WHEN (OLD.family='todo' AND OLD.state<>NEW.state AND NEW.state IN ('cancelled','blocked')
      AND NEW.revision=OLD.revision) EXECUTE FUNCTION advance_v6_work_revision()`);
}
