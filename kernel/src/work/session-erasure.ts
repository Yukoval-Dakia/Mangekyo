import type { DbQuery } from '../db/types.ts';

export type SessionErasure = {
  slotType: string;
  readLabels: readonly string[];
  open(tx: DbQuery, learner: string, roots: readonly string[]): Promise<{
    turns: readonly string[];
    drafts: readonly {turn: string; manifest: unknown}[];
  }>;
  clearDrafts(tx: DbQuery, learner: string, turns: readonly string[]): Promise<void>;
};

const referencesDerivation = (manifest: string) => `(
  ${manifest}->'inputs' @> jsonb_build_array(jsonb_build_object('kind','slot','derivationId',a.id))
  OR ${manifest}->'inputs' @> jsonb_build_array(jsonb_build_object('kind','range',
    'members',jsonb_build_array(jsonb_build_object('derivationId',a.id))))
)`;

/** Called only inside the learner's erasure transaction. */
export async function eraseSessionPayloads(tx: DbQuery, learner: string, roots: readonly string[], tick: string, scope: SessionErasure) {
  const {slotType, readLabels} = scope;
  const {turns, drafts} = await scope.open(tx, learner, roots);
  const {rows} = await tx.query<{turn: string; derivation: string | null}>(`WITH RECURSIVE
    root_inputs(input) AS (
      SELECT jsonb_build_array(jsonb_build_object('kind','fact','id',root.id)) FROM unnest($2::text[]) root(id)
    ),
    seed_turns(turn) AS (
      SELECT unnest($4::text[])
      UNION
      SELECT slot_key FROM work WHERE learner_id=$1 AND slot_type=$3 AND family='derivation' AND payload_sources && $2::text[]
      UNION
      SELECT e.owner_id FROM effects e
      JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(e.learner_id,$3,e.owner_id)
      CROSS JOIN LATERAL (SELECT CASE WHEN e.label=ANY($5::text[]) AND jsonb_typeof(e.result)='string'
        AND pg_input_is_valid(e.result#>>'{}','jsonb') THEN (e.result#>>'{}')::jsonb END AS packet) opened
      WHERE e.learner_id=$1 AND e.owner_kind='session' AND e.label=ANY($5::text[]) AND e.state='done'
        AND EXISTS (SELECT FROM unnest($2::text[]) root(id) WHERE
          jsonb_path_query_array(packet,'$.witnesses[*].id') ? root.id OR jsonb_path_query_array(packet,'$.basis[*].id') ? root.id
          OR jsonb_path_query_array(packet,'$.retentionBasis[*].facts[*].id') ? root.id
          OR jsonb_path_query_array(packet,'$.assessmentBasis[*].facts[*].id') ? root.id)
    ),
    affected(id, turn, slot_type) AS (
      (SELECT d.id, d.slot_key, d.slot_type FROM root_inputs r JOIN derivations d
         ON d.learner_id=$1 AND d.manifest->'inputs' @> r.input
       UNION SELECT d.id, d.slot_key, d.slot_type FROM seed_turns s JOIN derivations d
         ON d.learner_id=$1 AND d.slot_type=$3 AND d.slot_key=s.turn)
      UNION
      SELECT d.id, d.slot_key, d.slot_type FROM affected a JOIN derivations d
        ON d.learner_id=$1 AND ${referencesDerivation('d.manifest')}
    )
    SELECT turn, id AS derivation FROM affected WHERE slot_type=$3
    UNION SELECT s.slot_key, NULL FROM slot_state s JOIN seed_turns seed ON seed.turn=s.slot_key
      WHERE s.learner_id=$1 AND s.slot_type=$3
    UNION SELECT draft.turn, NULL FROM jsonb_to_recordset($6::jsonb) AS draft(turn text, manifest jsonb)
      WHERE EXISTS (SELECT FROM seed_turns s WHERE s.turn=draft.turn)
        OR EXISTS (SELECT FROM root_inputs r WHERE draft.manifest->'inputs' @> r.input)
        OR EXISTS (SELECT FROM affected a WHERE ${referencesDerivation('draft.manifest')})`,
  [learner,roots,slotType,turns,readLabels,JSON.stringify(drafts)]);
  if (!rows.length) return [];
  const owners = [...new Set(rows.map(row => row.turn))];
  const derivations = rows.flatMap(row => row.derivation ? [row.derivation] : []);
  await tx.query(`UPDATE derivations SET value=NULL,error=NULL,lifecycle='stale',invalidated_tick=COALESCE(invalidated_tick,$3)
    WHERE learner_id=$1 AND id=ANY($2)`, [learner,derivations,tick]);
  await tx.query(`UPDATE slot_state SET current_id=CASE WHEN current_id=ANY($5) THEN NULL ELSE current_id END,
      pending='none',last_error=CASE WHEN last_id IS NULL THEN '{"status":"failed","message":"学习依据已永久删除。"}'::jsonb ELSE NULL END,
      changed_tick=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=ANY($3)`, [learner,slotType,owners,tick,derivations]);
  await tx.query(`WITH cancelled AS (
    UPDATE work SET state='cancelled',revision=revision+1,generation=generation+1,execution_ref=NULL,gather=NULL,gather_manifest=NULL
    WHERE learner_id=$1 AND slot_type=$2 AND slot_key=ANY($3) AND family='derivation' AND state IN ('pending','ready','waiting') RETURNING id
  ) DELETE FROM work_waits w USING cancelled c WHERE w.learner_id=$1 AND w.work_id=c.id`, [learner,slotType,owners]);
  await scope.clearDrafts(tx, learner, owners);
  return owners;
}
