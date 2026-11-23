import type { ReadTransaction } from '../../kernel/src/index.ts';
import { FLOW_DERIVATION_SLOT_TYPES, FLOW_FACT_TYPES, indexRecordFlowSnapshot, projectRecordFlow, type FlowGraphSnapshot, type RawFlowDerivation, type RawFlowFact } from '../../modules/learner/record-flow.ts';

export async function loadRecordFlowSnapshot(tx: ReadTransaction, excludedIds: ReadonlySet<string>): Promise<FlowGraphSnapshot> {
  const [factsRes, derivRes] = await Promise.all([
    tx.query<RawFlowFact>(
      `SELECT f.id, f.type, f.current_rev AS rev, born.author, f.created_tick::text AS "createdTick", r.data FROM facts f
       JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
       JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
       WHERE f.learner_id=$1 AND f.retracted_rev IS NULL AND f.type = ANY($2::text[])`,
      [tx.learner, [...FLOW_FACT_TYPES]],
    ),
    tx.query<RawFlowDerivation>(
      `SELECT d.id, s.slot_type AS "slotType", s.slot_key AS "slotKey", d.value, d.manifest, d.effective_tick::text AS "effectiveTick" FROM slot_state s
       JOIN derivations d ON (d.learner_id, d.slot_type, d.slot_key, d.id)=(s.learner_id, s.slot_type, s.slot_key, s.current_id)
       WHERE s.learner_id=$1 AND s.slot_type = ANY($2::text[]) AND d.lifecycle='effective' AND NOT d.is_shadow AND d.invalidated_tick IS NULL`,
      [tx.learner, [...FLOW_DERIVATION_SLOT_TYPES]],
    ),
  ]);
  return indexRecordFlowSnapshot(factsRes.rows.filter((row) => !excludedIds.has(row.id)), derivRes.rows);
}

export async function readWorkspaceRecordFlow(tx: ReadTransaction, id: string, excludedIds: ReadonlySet<string>) {
  return projectRecordFlow(id, await loadRecordFlowSnapshot(tx, excludedIds));
}
