import type { DbQuery } from '../db/types.ts';

async function migrateDraftCorrectionTodos(tx: DbQuery) {
  // The v13 Studio draft recorded its settings fact as the wake slot key. Its
  // Todo spec carries the correction, original question, grant and frozen paper.
  // Recover the deletion fence from those revisions and their saved sources.
  await tx.query(`WITH RECURSIVE draft AS (
    SELECT w.learner_id,w.id,w.spec,wake.slot_key AS settings_id
    FROM work w JOIN work wake ON wake.learner_id=w.learner_id
      AND wake.slot_type='companion.researchWake' AND wake.deriver='studio/research-wake-v1'
    WHERE w.family='todo' AND w.slot_type='working.todo' AND w.state IN ('pending','ready','waiting')
      AND w.deriver='deterministic_compute' AND w.trigger='scheduled'
      AND w.spec#>>'{sourceFactRev,revision}'='1'
      AND w.dedup_key='correction-retest:' || (w.spec#>>'{sourceFactRev,id}') || ':1'
  ), witnesses AS (
    SELECT d.learner_id,d.id AS work_id,ref->>'id' AS fact_id,(ref->>'revision')::integer AS rev,
      ref->>'accessEpoch' AS epoch,purpose,following
    FROM draft d CROSS JOIN LATERAL (VALUES
      (d.spec->'sourceFactRev','storage',true),
      (d.spec#>'{refs,0}','teaching',false),
      (d.spec#>'{refs,1}','background-research',true),
      (d.spec#>'{refs,2}','storage',false)
    ) saved(ref,purpose,following)
  ), basis(learner_id,work_id,fact_id,rev) AS (
    SELECT learner_id,work_id,fact_id,rev FROM witnesses WHERE fact_id IS NOT NULL
    UNION
    SELECT b.learner_id,b.work_id,dependency.id,dependency.rev FROM basis b
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(b.learner_id,b.fact_id,b.rev)
    JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
    CROSS JOIN LATERAL (SELECT CASE f.type WHEN 'activity.workbookPaper' THEN r.data
      WHEN 'activity.workbookAttempt' THEN r.data->'paper' END) paper(data)
    CROSS JOIN LATERAL (
      SELECT paper.data->>'materialId' AS id, NULL::integer AS rev
      UNION ALL
      SELECT ref->>'id',(ref->>'rev')::integer FROM jsonb_array_elements(paper.data->'questions') question
      CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(question->'sourceQuestionRef') ||
        COALESCE(question->'sourceBasis','[]'::jsonb)) ref
      WHERE question->>'kind'='bank'
      UNION ALL
      SELECT ref->>'id',(ref->>'rev')::integer FROM jsonb_array_elements(CASE
        WHEN f.type IN ('content.asset','content.textbookPage','activity.workspaceEntry') THEN r.data->'basis' END) ref
    ) dependency WHERE dependency.id IS NOT NULL
  ), erasure AS (
    SELECT learner_id,work_id,array_agg(DISTINCT fact_id ORDER BY fact_id) AS ids
    FROM basis GROUP BY learner_id,work_id
  ), recovered AS (
    -- Use the saved attempt revision and access epoch even if permission is currently enabled again.
    -- An inactive row keeps its execution identity but is excluded by the relay's ready-state filter.
    SELECT d.learner_id,d.id,d.settings_id,e.ids,
      EXISTS (SELECT FROM tombstones t WHERE t.learner_id=d.learner_id AND t.kind='fact'
        AND (t.id=ANY(e.ids) OR t.id=d.settings_id))
      OR EXISTS (SELECT FROM witnesses saved WHERE (saved.learner_id,saved.work_id)=(d.learner_id,d.id)
        AND NOT EXISTS (SELECT FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id)=(f.learner_id,f.id)
          WHERE (f.learner_id,f.id,r.rev)=(saved.learner_id,saved.fact_id,saved.rev)
            AND (NOT saved.following OR f.current_rev=saved.rev) AND f.access_epoch::text=saved.epoch
            AND f.retracted_rev IS NULL AND r.kind='value'
            AND (saved.purpose=ANY(f.purpose) OR 'all'=ANY(f.purpose))
            AND (saved.purpose=ANY(r.purpose) OR (saved.purpose<>'background-research' AND 'all'=ANY(r.purpose)))))
      OR NOT EXISTS (SELECT FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
        WHERE (f.learner_id,f.id)=(d.learner_id,d.settings_id) AND f.type='companion.researchSettings'
          AND f.current_rev::text=d.spec->>'settingsRevision' AND f.retracted_rev IS NULL
          AND r.kind='value' AND f.purpose && ARRAY['background-research','all']
          AND r.purpose && ARRAY['background-research','all']
          AND r.data->'enabled'='true'::jsonb) AS invalid
    FROM draft d JOIN erasure e ON (e.learner_id,e.work_id)=(d.learner_id,d.id)
  ), migrated AS (
    UPDATE work w SET family='routed_todo',deriver='studio/correction-retest-v1',
      erasure_basis=r.ids,settings_fact_id=r.settings_id,
      state=CASE WHEN r.invalid THEN 'cancelled' ELSE w.state END,
      revision=CASE WHEN r.invalid THEN w.revision+1 ELSE w.revision END
    FROM recovered r WHERE (w.learner_id,w.id)=(r.learner_id,r.id)
    RETURNING w.learner_id,w.slot_type,w.slot_key,r.invalid
  )
  UPDATE slot_state s SET pending='none',last_error=NULL FROM migrated m
  WHERE m.invalid AND (s.learner_id,s.slot_type,s.slot_key)=(m.learner_id,m.slot_type,m.slot_key)`);
  // Existing execution refs may already be on the default Temporal queue, even
  // before relay acknowledgement. Keep their original outbox lane and history.
  // If the recovered execution defers, its next dispatch uses the routed lane.
}

export async function migrateRoutedTodos(tx: DbQuery) {
  // Hold the same table boundary as learner writes before changing work and its fences.
  await tx.query('LOCK TABLE learners IN EXCLUSIVE MODE');
  // Separate the scheduled scan from ordinary Todos. Existing Work Runs still
  // use their original queues and must be rebound to the new Worker.
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
  await migrateDraftCorrectionTodos(tx);
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
  // The v13 Studio checks this only at startup. Stop old pollers before migrating.
  await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=14');
}
