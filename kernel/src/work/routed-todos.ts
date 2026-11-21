import type { DbQuery } from '../db/types.ts';

export async function migrateRoutedTodos(tx: DbQuery) {
  // Old, already running coordinators scan family='todo' without checking the deriver.
  // Isolate both the pending scan and the outbox delivery from those executors.
  await tx.query(`ALTER TABLE work DROP CONSTRAINT work_family_check,
    ADD COLUMN erasure_basis text[], ADD COLUMN settings_fact_id text,
    ADD CHECK (family IN ('derivation','todo','routed_todo')),
    ADD CHECK (family <> 'routed_todo' OR (slot_type='working.todo' AND spec IS NOT NULL
      AND dedup_key IS NOT NULL AND chain_id IS NOT NULL AND hop_count IS NOT NULL AND registered_tick IS NOT NULL
      AND (state='satisfied')=(result_id IS NOT NULL) AND cardinality(erasure_basis)>0
      AND erasure_basis IS NOT NULL AND settings_fact_id IS NOT NULL))`);
  await tx.query('DROP INDEX work_active_todo');
  await tx.query(`CREATE UNIQUE INDEX work_active_todo ON work (learner_id,dedup_key)
    WHERE family IN ('todo','routed_todo') AND state IN ('pending','ready','waiting')`);
  // Both boundaries are held by the existing learner write, including old Studio.
  await tx.query(`CREATE FUNCTION cancel_routed_todos() RETURNS trigger
    LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
    BEGIN
      WITH cancelled AS (
        UPDATE work w SET state='cancelled', revision=revision+1
        WHERE family='routed_todo' AND state IN ('pending','ready','waiting')
          AND EXISTS (SELECT FROM changed c WHERE c.learner_id=w.learner_id AND
            CASE WHEN TG_TABLE_NAME='tombstones' THEN c.id=ANY(w.erasure_basis) AND to_jsonb(c)->>'kind'='fact'
              ELSE c.id=w.settings_fact_id AND (to_jsonb(c)->>'current_rev')::integer <> (w.spec->>'settingsRevision')::integer END)
        RETURNING learner_id,slot_type,slot_key
      )
      UPDATE slot_state s SET pending='none',last_error=NULL FROM cancelled c
      WHERE (s.learner_id,s.slot_type,s.slot_key)=(c.learner_id,c.slot_type,c.slot_key);
      RETURN NULL;
    END $$`);
  await tx.query(`CREATE TRIGGER cancel_erased_routed_todos AFTER INSERT ON tombstones
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION cancel_routed_todos()`);
  await tx.query(`CREATE TRIGGER cancel_superseded_routed_todos AFTER UPDATE ON facts
    REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION cancel_routed_todos()`);
}
