import type { DbTransaction } from '../db/types.ts';
import type { DerivationId, Tick } from '../declarations/ids.ts';
import type { Json, JsonObject, SlotRef } from '../declarations/types.ts';
import type { CandidateHooks } from './candidate.ts';
import type { Manifest } from './manifest.ts';

type Selection = {
  readonly slotType: SlotRef['type'];
  readonly key: SlotRef['key'];
  readonly id: DerivationId;
  readonly deriver: string;
  readonly scope: JsonObject;
  readonly value: Json;
  readonly manifest: Manifest;
} & (
  | { readonly kind: 'publish'; readonly previous: DerivationId | null }
  | { readonly kind: 'carry' }
);

/** Commit a synchronous result under the caller's learner lock and publication tick. */
export async function storeSettledValue(
  tx: DbTransaction, tick: Tick, selection: Selection, hooks: CandidateHooks,
) {
  const { slotType, key, id, deriver, manifest } = selection;
  if (manifest.learner !== tx.learner) throw new Error('Result manifest belongs to another learner');
  const previous = selection.kind === 'publish' ? selection.previous : null;
  if (previous) await tx.query(
    `UPDATE derivations SET lifecycle='superseded',selection_ended_tick=$3
     WHERE learner_id=$1 AND id=$2`, [tx.learner, previous, tick],
  );
  const scope = JSON.stringify(selection.scope);
  await tx.insert('derivations', {
    learner_id: tx.learner, id, slot_type: slotType, slot_key: key, deriver,
    scope_keys: scope, value: JSON.stringify(selection.value),
    lifecycle: 'effective', freshness: 'current', is_shadow: false,
    gather_tick: manifest.gatherTick, effective_tick: tick, manifest: JSON.stringify(manifest),
  });
  const values = [tx.learner, slotType, key, id, tick];
  if (selection.kind === 'carry') {
    await tx.query(
      `UPDATE slot_state SET current_id=$4,last_id=$4,changed_tick=$5,last_error=NULL
       WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`, values,
    );
  } else {
    await tx.query(
      `INSERT INTO slot_state (learner_id,slot_type,slot_key,current_id,last_id,changed_tick,scope_keys)
       VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT (learner_id,slot_type,slot_key)
       DO UPDATE SET current_id=EXCLUDED.current_id,last_id=EXCLUDED.last_id,changed_tick=EXCLUDED.changed_tick`,
      [...values, scope],
    );
  }
  await hooks.onSlotChanged(tx, tick, {
    kind: 'effective', slot: { learner: tx.learner, type: slotType, key },
    id, previousCurrent: previous, freshness: 'current',
  });
}
