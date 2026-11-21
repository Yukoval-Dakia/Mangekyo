import type { DbQuery } from '../db/types.ts';

export async function migrateWorkPayloads(tx: DbQuery) {
  await tx.query('LOCK TABLE learners IN EXCLUSIVE MODE');
  await tx.query(`ALTER TABLE work ADD COLUMN payload_sources text[],
    ADD COLUMN publication_fact_id text, ADD COLUMN publication_command_id text,
    ADD CHECK ((publication_fact_id IS NULL)=(publication_command_id IS NULL))`);
  await tx.query('CREATE INDEX work_payload_sources_idx ON work USING gin(payload_sources)');
  await tx.query(`CREATE INDEX work_payload_publication_idx ON work
    (learner_id,COALESCE(result_id,publication_fact_id)) WHERE payload_sources IS NOT NULL`);
  await tx.query(`ALTER TABLE effects ADD COLUMN payload_work_id text,
    ADD FOREIGN KEY (learner_id, payload_work_id) REFERENCES work (learner_id, id)`);
  await tx.query(`CREATE INDEX effects_payload_work_idx ON effects (learner_id,payload_work_id)
    WHERE payload_work_id IS NOT NULL`);
  await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=15');
}

export async function erasePayloads(tx: DbQuery, learner: string, ids: readonly string[], tick: string,
  commandTypes: readonly string[] = []) {
  const {rows} = await tx.query<{id: string}>(`WITH RECURSIVE affected(id) AS (
    SELECT unnest($2::text[])
    UNION
    SELECT w.result_id FROM affected a JOIN work w ON w.learner_id=$1
      AND w.payload_sources @> ARRAY[a.id] WHERE w.result_id IS NOT NULL
  ) SELECT id FROM affected`, [learner,ids]);
  const erased = rows.map(row => row.id);
  await tx.query(`INSERT INTO tombstones SELECT $1,id,'fact',$3::bigint FROM unnest($2::text[]) AS id
    ON CONFLICT DO NOTHING`, [learner,erased,tick]);
  const { rows: commands } = await tx.query<{id: string}>(`SELECT c.id FROM fact_revs r
    JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
    WHERE r.learner_id=$1 AND r.fact_id=ANY($2)
    UNION
    SELECT id FROM commands WHERE learner_id=$1 AND type=ANY($3::text[])
      AND (input #>> '{input,intakeId}'=ANY($2) OR input #>> '{input,materialId}'=ANY($2))`,
  [learner,erased,commandTypes]);
  const commandIds = commands.map(row => row.id);
  await tx.query(`INSERT INTO tombstones SELECT $1,id,'command',$3::bigint FROM unnest($2::text[]) AS id
    ON CONFLICT DO NOTHING`, [learner,commandIds,tick]);
  await tx.query('DELETE FROM proposals WHERE learner_id=$1 AND command_id=ANY($2)', [learner,commandIds]);
  await tx.query('DELETE FROM commands WHERE learner_id=$1 AND id=ANY($2)', [learner,commandIds]);
  await tx.query('DELETE FROM fact_revs WHERE learner_id=$1 AND fact_id=ANY($2)', [learner,erased]);
  await tx.query('DELETE FROM facts WHERE learner_id=$1 AND id=ANY($2)', [learner,erased]);
  const {rows: affectedWork} = await tx.query<{id:string}>(`SELECT id FROM work WHERE learner_id=$1
    AND payload_sources IS NOT NULL
    AND (payload_sources && $2::text[] OR COALESCE(result_id,publication_fact_id)=ANY($2))`, [learner,erased]);
  const works = affectedWork.map(row => row.id);
  await tx.query(`WITH removed AS (
    DELETE FROM effects WHERE learner_id=$1 AND (payload_work_id=ANY($4::text[])
      OR owner_id=ANY($2::text[]))
    RETURNING *
  )
  INSERT INTO erased_effect_receipts(learner_id,provider_effect_id,owner_id,started_tick,erased_tick,settlement,
    reserved_usd_micros,actual_usd_micros,budget_route,owner_kind,step_key,label)
  SELECT $1,provider_effect_id,owner_id,started_tick,$3,CASE WHEN state='done' THEN 'done' ELSE 'unknown' END,
    reserved_usd_micros,actual_usd_micros,budget_route,
    CASE WHEN owner_id<>ALL($2) THEN owner_kind END,
    CASE WHEN owner_id<>ALL($2) THEN step_key END,
    CASE WHEN owner_id<>ALL($2) THEN label END
  FROM removed WHERE provider_effect_id IS NOT NULL`, [learner,erased,tick,works]);
  await tx.query(`WITH cancelled AS (
    UPDATE work SET state='cancelled',revision=revision+1,generation=generation+1,
      execution_ref=NULL,gather=NULL,gather_manifest=NULL
    WHERE learner_id=$1 AND id=ANY($2) AND state IN ('pending','ready','waiting') RETURNING id,slot_type,slot_key
  ), cleared AS (
    DELETE FROM work_waits WHERE learner_id=$1 AND work_id IN (SELECT id FROM cancelled)
  )
  UPDATE slot_state s SET pending='none',last_error=NULL,changed_tick=GREATEST(s.changed_tick,$3) FROM cancelled c
  WHERE s.learner_id=$1 AND (s.slot_type,s.slot_key)=(c.slot_type,c.slot_key)`, [learner,works,tick]);
}
