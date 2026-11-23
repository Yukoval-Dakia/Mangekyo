import { factId, type FactSnapshot, type ReadTransaction, type Revision, type Tick } from '../../kernel/src/index.ts';
import { FLOW_DERIVATION_SLOT_TYPES, FLOW_FACT_TYPES, indexRecordFlowSnapshot, projectRecordFlow, type FlowGraphSnapshot, type RawFlowDerivation, type RawFlowFact } from '../../modules/learner/record-flow.ts';

type FactRow = RawFlowFact & { purpose: string[]; accessEpoch: string };
const toSnapshot = (tx: ReadTransaction, row: FactRow): FactSnapshot => ({
  ref: { learner: tx.learner, id: factId(row.id), rev: row.rev as Revision },
  type: row.type, value: row.data as FactSnapshot['value'], purpose: row.purpose, accessEpoch: row.accessEpoch as Tick,
});

export async function loadRecordFlowSnapshot(tx: ReadTransaction, excludedIds: ReadonlySet<string> = new Set()): Promise<FlowGraphSnapshot> {
  return (await loadAuthorizedRecordFlowSnapshot(tx, { excludedIds })).snap;
}

export async function loadAuthorizedRecordFlowSnapshot(
  tx: ReadTransaction,
  options: { purpose?: string; maySend?: (fact: FactSnapshot) => boolean; excludedIds?: ReadonlySet<string> } = {},
): Promise<{ snap: FlowGraphSnapshot; snapshots: ReadonlyMap<string, FactSnapshot> }> {
  const [factsRes, derivRes] = await Promise.all([
    tx.query<FactRow>(
      `SELECT f.id, f.type, f.current_rev AS rev, born.author, f.created_tick::text AS "createdTick", f.purpose, f.access_epoch::text AS "accessEpoch", r.data FROM facts f
       JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
       JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
       WHERE f.learner_id=$1 AND f.retracted_rev IS NULL AND f.type = ANY($2::text[])` + (options.purpose ? ` AND f.purpose && ARRAY[$3::text, 'all']` : ''),
      options.purpose ? [tx.learner, [...FLOW_FACT_TYPES], options.purpose] : [tx.learner, [...FLOW_FACT_TYPES]],
    ),
    tx.query<RawFlowDerivation>(
      `SELECT d.id, s.slot_type AS "slotType", s.slot_key AS "slotKey", d.value, d.manifest, d.effective_tick::text AS "effectiveTick" FROM slot_state s
       JOIN derivations d ON (d.learner_id, d.slot_type, d.slot_key, d.id)=(s.learner_id, s.slot_type, s.slot_key, s.current_id)
       WHERE s.learner_id=$1 AND s.slot_type = ANY($2::text[]) AND d.lifecycle='effective' AND NOT d.is_shadow AND d.invalidated_tick IS NULL`,
      [tx.learner, [...FLOW_DERIVATION_SLOT_TYPES]],
    ),
  ]);
  const snapshots = new Map<string, FactSnapshot>(), allowed: RawFlowFact[] = [];
  for (const row of factsRes.rows) {
    if (options.excludedIds?.has(row.id)) continue;
    const snapshot = toSnapshot(tx, row);
    if (options.maySend && !options.maySend(snapshot)) continue;
    snapshots.set(row.id, snapshot);
    allowed.push(row);
  }
  return { snap: indexRecordFlowSnapshot(allowed, derivRes.rows), snapshots };
}

export async function readWorkspaceRecordFlow(tx: ReadTransaction, id: string, excludedIds: ReadonlySet<string> = new Set()) {
  return projectRecordFlow(id, await loadRecordFlowSnapshot(tx, excludedIds));
}
