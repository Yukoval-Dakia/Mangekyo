import type { DbQuery } from '../db/types.ts';
import { installErasureFence } from '../lifecycle.ts';
import { erasePayloads } from './payload-erasure.ts';

import { migrateRoutedTodos } from './routed-todos.ts';

async function installReceiptKeys(tx: DbQuery) {
  await tx.query(`ALTER TABLE erased_effect_receipts ADD COLUMN owner_kind text,
    ADD COLUMN step_key text, ADD COLUMN label text,
    ADD CHECK ((owner_kind IS NULL AND step_key IS NULL AND label IS NULL) OR
      (owner_kind IS NOT NULL AND step_key IS NOT NULL AND label IS NOT NULL))`);
  await tx.query(`CREATE UNIQUE INDEX erased_effect_identity_idx ON erased_effect_receipts
    (learner_id,owner_kind,owner_id,step_key,label) WHERE owner_kind IS NOT NULL`);
}

export async function finishWorkPayloadCutover(tx: DbQuery) {
  await tx.query('LOCK TABLE learners IN EXCLUSIVE MODE');
  const {rows:[layout]} = await tx.query<{routed:number; cancel:number; keys:number; keyed:boolean}>(`
    SELECT (SELECT count(*)::int FROM pg_attribute WHERE attrelid='work'::regclass AND NOT attisdropped
              AND attname IN ('erasure_basis','settings_fact_id')) AS routed,
           (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND
              ((tgrelid='tombstones'::regclass AND tgname='cancel_erased_routed_todos') OR
               (tgrelid='facts'::regclass AND tgname='cancel_superseded_routed_todos'))) AS cancel,
           (SELECT count(*)::int FROM pg_attribute WHERE attrelid='erased_effect_receipts'::regclass
              AND NOT attisdropped AND attname IN ('owner_kind','step_key','label')) AS keys,
           to_regclass('erased_effect_identity_idx') IS NOT NULL AS keyed`);
  if (layout?.routed === 2 && layout.cancel === 2 && layout.keys === 0 && !layout.keyed) {
    await installReceiptKeys(tx);
  } else if (layout?.routed === 0 && layout.cancel === 0 && layout.keys === 3 && layout.keyed) {
    // The stopped S02 draft recorded its own v14, and may already have recorded v15.
    // Install the published routed migration under this forward version and keep the original journal rows.
    await migrateRoutedTodos(tx);
  } else {
    throw new Error('Unrecognized routed-work or S02 receipt schema; keep Studio stopped');
  }
  await installErasureFence(tx, true, true);
  await backfillWorksheetPayloads(tx);
  await tx.query('UPDATE kernel_runtime_identity SET minimum_worker_schema=16');
}

/** Lift the frozen legacy worksheet witnesses and exact effect keys into the work payload contract. */
async function backfillWorksheetPayloads(tx: DbQuery) {
  await tx.query(`UPDATE work w SET payload_sources=ARRAY(
    SELECT DISTINCT source_id FROM (
      SELECT w.spec #>> '{sourceFactRev,id}' AS source_id
      UNION ALL SELECT ref->>'id' FROM jsonb_array_elements(w.spec->'refs') AS ref
    ) sources WHERE source_id IS NOT NULL ORDER BY source_id
  ) WHERE w.family='todo' AND w.payload_sources IS NULL AND w.spec->>'goal'='为一份正式错题作答准备复习单'`);
  // v13/v14 receipts may be older than an erasure watermark. Set the linkage
  // only, under the migration's table lock, without replaying the receipt.
  await tx.query('ALTER TABLE effects DISABLE TRIGGER fence_erased_identity');
  await tx.query(`UPDATE effects e SET payload_work_id=w.id FROM work w
    WHERE w.payload_sources IS NOT NULL AND e.payload_work_id IS NULL AND w.learner_id=e.learner_id AND e.owner_kind='derivation'
      AND e.owner_id=w.spec #>> '{sourceFactRev,id}' AND split_part(e.step_key,':',1)=w.slot_key
      AND e.label IN ('research-worker-v1','research-worker-output-v1')`);
  await tx.query('ALTER TABLE effects ENABLE TRIGGER fence_erased_identity');
  await tx.query('DROP INDEX IF EXISTS work_comparison_erasure_idx');

  // v14 returned the original receipt even if it missed a descendant. Keep that
  // receipt and fence/delete any newly reachable bodies before admitting workers.
  const {rows} = await tx.query<{learner_id:string; ids:string[]; generation:string}>(`SELECT t.learner_id,
    array_agg(t.id) AS ids, (SELECT max(generation)::text FROM erasure_requests r
      WHERE r.learner_id=t.learner_id) AS generation
    FROM tombstones t WHERE kind='fact' AND EXISTS (
      SELECT 1 FROM work w WHERE w.learner_id=t.learner_id AND w.payload_sources @> ARRAY[t.id]
    ) GROUP BY t.learner_id`);
  for (const row of rows) await erasePayloads(tx, row.learner_id, row.ids, row.generation);
}
