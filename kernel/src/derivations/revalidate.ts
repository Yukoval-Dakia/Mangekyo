import type { ReadTransaction } from '../db/types.ts';
import { derivationId, type Tick } from '../declarations/ids.ts';
import type { Outcome, SlotRef } from '../declarations/types.ts';
import { canonicalJsonString } from '../commands/canonical.ts';
import { followingRevisionFloor, followingWitnessMatches } from '../commands/purpose-witness.ts';
import { parseManifest, type Manifest, type ManifestInput, type ManifestVerdict } from './manifest.ts';

type Derivation = {
  id: string;
  slot_type: string;
  slot_key: string;
  lifecycle: string;
  invalidated_tick: string | null;
  effective_tick: string | null;
  is_shadow: boolean;
  manifest: unknown;
};
type FactInput = Extract<ManifestInput,{kind:'fact'}>;
const invalid = (reason: string): ManifestVerdict => ({ kind: 'invalid', reason });
const valid = (behind = false): ManifestVerdict => ({ kind: 'valid', freshness: behind ? 'behind' : 'current' });

export type CurrentValueDerivation<Value> = {
  id: string;
  slot_type: string;
  slot_key: string;
  deriver: string;
  effective_tick: Tick;
  value: Outcome<Value>;
  manifest: unknown;
};

export async function readCurrentValueDerivations<Value>(tx: ReadTransaction, type: string, limit: number, id?: string, key?: string) {
  const {rows} = await tx.query<CurrentValueDerivation<Value>>(
    `SELECT d.id, d.slot_type, d.slot_key, d.deriver, d.effective_tick::text, d.value, d.manifest
     FROM slot_state s JOIN derivations d
       ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND ($3::text IS NULL OR d.id=$3)
       AND ($5::text IS NULL OR d.slot_key=$5)
       AND d.lifecycle='effective' AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NULL
       AND NOT d.is_shadow AND d.effective_tick >= d.gather_tick AND d.value->>'kind'='value'
     ORDER BY d.effective_tick DESC, d.id LIMIT $4`, [tx.learner, type, id ?? null, limit, key ?? null]);
  return rows;
}

/** Caller supplies one snapshot or holds the learner write lock for the whole check. */
export async function revalidateManifest(
  tx: ReadTransaction,
  manifest: Manifest,
  purpose = manifest.purpose,
  visiting: ReadonlySet<string> = new Set(),
): Promise<ManifestVerdict> {
  if (manifest.learner !== tx.learner) return invalid('Manifest learner does not match transaction');
  const clock = await tx.query<{clock:string}>('SELECT clock::text FROM learners WHERE id=$1', [tx.learner]);
  if (!clock.rows[0] || BigInt(manifest.gatherTick) > BigInt(clock.rows[0].clock)) return invalid('Gather tick is ahead of the learner clock');
  if (manifest.inputs.length > 1 && manifest.inputs.every(input=>input.kind==='fact'))
    return checkFactManifest(tx,manifest.inputs,manifest.gatherTick,purpose);
  let behind = false;
  for (const input of manifest.inputs) {
    const verdict = await checkInput(tx, input, manifest.gatherTick, purpose, visiting);
    if (verdict.kind === 'invalid') return verdict;
    behind ||= verdict.freshness === 'behind';
  }
  return valid(behind);
}

/** Enumerate the fact witnesses of a manifest already revalidated by the caller. */
export async function manifestFactInputs(tx: ReadTransaction, inputs: Manifest['inputs'],
  visitSlot?: (slotType: string, slotKey: string) => void) {
  const facts: Extract<Manifest['inputs'][number], {kind: 'fact'}>[] = [];
  const seen = new Set<string>();
  let pending = inputs;
  while (pending.length) {
    const slots = new Set<string>();
    for (const input of pending) {
      if (input.kind === 'fact') facts.push(input);
      else for (const member of input.kind === 'slot' ? [input] : input.members) {
        visitSlot?.(input.slotType, member.slotKey);
        slots.add(member.derivationId);
      }
    }
    const ids = [...slots].filter(id => !seen.has(id));
    if (!ids.length) break;
    ids.forEach(id => seen.add(id));
    const {rows} = await tx.query<{manifest: unknown}>(
      'SELECT manifest FROM derivations WHERE learner_id=$1 AND id=ANY($2::text[])', [tx.learner, ids]);
    pending = rows.flatMap(row => parseManifest(row.manifest).inputs);
  }
  return facts;
}

async function checkDerivation(
  tx: ReadTransaction,
  id: string,
  slotType: string,
  slotKey: string,
  at: Tick,
  purpose: string,
  visiting: ReadonlySet<string>,
): Promise<Derivation | null> {
  if (visiting.has(id)) throw new Error('Cyclic input manifest');
  const result = await tx.query<Derivation>(
    `SELECT id, slot_type, slot_key, lifecycle, invalidated_tick::text,
            effective_tick::text, is_shadow, manifest
     FROM derivations WHERE learner_id=$1 AND id=$2`, [tx.learner, id],
  );
  const row = result.rows[0];
  if (!row || row.slot_type !== slotType || row.slot_key !== slotKey || row.is_shadow
      || row.invalidated_tick !== null || row.effective_tick === null
      || !['effective', 'superseded'].includes(row.lifecycle) || BigInt(row.effective_tick) > BigInt(at)) return null;
  const path = new Set(visiting).add(id);
  const manifest = parseManifest(row.manifest);
  if (BigInt(manifest.gatherTick) > BigInt(row.effective_tick)) return null;
  const nested = await revalidateManifest(tx, manifest, purpose, path);
  return nested.kind === 'valid' ? row : null;
}

async function checkFactManifest(tx: ReadTransaction, inputs: readonly FactInput[], at: Tick, purpose: string) {
  const matches = followingWitnessMatches('f', followingRevisionFloor('f', '$3::text'), 'q.rev', 'q.epoch');
  const result = await tx.query<{count:number}>(
    `SELECT COUNT(*)::integer AS count
       FROM jsonb_to_recordset($2::jsonb) AS q(id text, rev integer, mode text, epoch text)
       JOIN facts f ON f.learner_id=$1 AND f.id=q.id
       JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,q.rev)
      WHERE r.kind='value' AND f.retracted_rev IS NULL AND r.tick <= $4::bigint
        AND ($3=ANY(f.purpose) OR 'all'=ANY(f.purpose))
        AND ($3=ANY(r.purpose) OR 'all'=ANY(r.purpose))
        AND CASE WHEN q.mode='following' THEN ${matches} ELSE f.access_epoch::text=q.epoch END`,
    [tx.learner, JSON.stringify(inputs.map(({id,rev,mode,accessEpoch}) => ({id,rev,mode,epoch:accessEpoch}))), purpose, at],
  );
  return result.rows[0]?.count === inputs.length ? valid() : invalid('Fact input changed or is denied');
}

async function checkInput(
  tx: ReadTransaction,
  input: ManifestInput,
  at: Tick,
  purpose: string,
  visiting: ReadonlySet<string>,
): Promise<ManifestVerdict> {
  if (input.kind === 'fact') return checkFactManifest(tx, [input], at, purpose);
  if (input.kind === 'slot') {
    const row = await checkDerivation(tx, input.derivationId, input.slotType, input.slotKey, at, purpose, visiting);
    if (!row) return invalid('Derivation input is invalid or denied');
    const state = await tx.query<{ current_id: string | null }>(
      'SELECT current_id FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [tx.learner, input.slotType, input.slotKey],
    );
    const current = state.rows[0]?.current_id;
    if (input.mode === 'following' && current !== input.derivationId) return invalid('Following slot input changed');
    return valid(input.mode === 'asof' && row.lifecycle === 'superseded');
  }
  const catalog = await tx.query<{ slot_key: string; current_id: string | null; changed_tick: string }>(
    `SELECT slot_key, current_id, changed_tick::text FROM slot_state
     WHERE learner_id=$1 AND slot_type=$2 AND evidence_eligible AND scope_keys @> $3::jsonb`,
    [tx.learner, input.slotType, canonicalJsonString(input.scope)],
  );
  const current = new Map(catalog.rows.map(row => [row.slot_key, row.current_id]));
  const recorded = new Set(input.members.map(member => member.slotKey));
  if (catalog.rows.some(row => !recorded.has(row.slot_key) && BigInt(row.changed_tick) <= BigInt(input.watermark))) {
    return invalid('Range omitted a member already eligible at gather');
  }
  const history = await tx.query<{ changed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM derivations
     WHERE learner_id=$1 AND slot_type=$2 AND NOT is_shadow
       AND effective_tick > $3::bigint AND scope_keys @> $4::jsonb) AS changed`,
    [tx.learner, input.slotType, input.watermark, canonicalJsonString(input.scope)],
  );
  let behind = history.rows[0]?.changed === true || catalog.rows.length !== input.members.length;
  for (const member of input.members) {
    const row = await checkDerivation(tx, member.derivationId, input.slotType, member.slotKey, at, purpose, visiting);
    if (!row || BigInt(row.effective_tick!) > BigInt(input.watermark) || !current.has(member.slotKey)) {
      return invalid('Recorded range member is invalid, denied or moved outside the scope');
    }
    behind ||= current.get(member.slotKey) !== member.derivationId || row.lifecycle === 'superseded';
  }
  return valid(behind);
}

async function effectiveSlotRow<Value>(tx: ReadTransaction, slot: SlotRef, deriver: string, pinnedId?: string, rejectSlotError = false) {
  if (slot.learner !== tx.learner) return undefined;
  const { rows: [row] } = await tx.query<{ id: string; value: Outcome<Value>; manifest: unknown; gather_tick: string }>(
    `SELECT d.id,d.value,d.manifest,d.gather_tick::text
       FROM slot_state s JOIN derivations d USING (learner_id,slot_type,slot_key)
      WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND d.deriver=$4
        AND (NOT $6 OR s.last_error IS NULL) AND d.effective_tick>=d.gather_tick AND NOT d.is_shadow AND d.invalidated_tick IS NULL
        AND (($5::text IS NULL AND d.id=s.current_id AND d.lifecycle='effective'
              AND d.freshness='current' AND d.selection_ended_tick IS NULL)
          OR ($5 IS NOT NULL AND d.id=$5 AND d.lifecycle IN ('effective','superseded')))`,
    [slot.learner, slot.type, slot.key, deriver, pinnedId ?? null, rejectSlotError],
  );
  return row;
}

/** Read the settled outcome of exactly this current, error-free slot and purpose. */
export async function readCurrentSlotOutcome<Value>(tx: ReadTransaction, slot: SlotRef, deriver: string, use: string) {
  const row = await effectiveSlotRow<Value>(tx, slot, deriver, undefined, true);
  if (!row) return undefined;
  const manifest = parseManifest(row.manifest);
  if (manifest.purpose !== use || manifest.gatherTick !== row.gather_tick ||
      (await revalidateManifest(tx,manifest)).kind !== 'valid') return undefined;
  return {id:derivationId(row.id),slot,outcome:row.value};
}

export async function readEffectiveSlotVersion<Value>(tx: ReadTransaction, slot: SlotRef, deriver: string, use: string, pinnedId?: string) {
  const row = await effectiveSlotRow<Value>(tx, slot, deriver, pinnedId);
  if (!row || row.value?.kind !== 'value') return undefined;
  const manifest = parseManifest(row.manifest);
  if (manifest.gatherTick !== row.gather_tick) return undefined;
  for (const requested of new Set([manifest.purpose, use])) {
    const verdict = await revalidateManifest(tx, manifest, requested);
    if (verdict.kind !== 'valid' || (!pinnedId && verdict.freshness !== 'current')) return undefined;
  }
  return { manifest, deriver, snapshot: { id: derivationId(row.id), slot, outcome: row.value } };
}
