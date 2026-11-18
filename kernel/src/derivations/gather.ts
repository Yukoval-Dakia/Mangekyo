import { z } from 'zod';
import type { Db, ReadTransaction } from '../db/types.ts';
import { canonicalJsonString } from '../commands/canonical.ts';
import { createCommandReadContext } from '../commands/reads.ts';
import { derivationId, factId, learnerId, type FactId, type Revision, type Tick } from '../declarations/ids.ts';
import type { GatherContext, GatherInput, Json, JsonObject, Outcome, ReadContext, SlotRef, Waiting } from '../declarations/types.ts';
import { parseManifest, type Manifest } from './manifest.ts';
import { revalidateManifest } from './revalidate.ts';

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string() }).strict(),
]);
const slotRef = z.object({ learner: z.string().transform(learnerId), type: z.string().min(1), key: z.string() }).strict();
const waitingSchema = z.object({
  kind: z.literal('waiting'),
  targets: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('slot'), ref: slotRef }).strict(),
    z.object({ kind: z.literal('fact'), ref: z.object({ learner: z.string().transform(learnerId), id: z.string().transform(factId), rev: z.number().int().positive().transform(value => value as Revision) }).strict() }).strict(),
    z.object({ kind: z.literal('range'), slotType: z.string().min(1), scope: z.record(z.string(), z.json()) }).strict(),
  ])).min(1),
}).strict();
const planSchema = z.object({
  kind: z.literal('input'), data: z.json(),
  effects: z.array(z.object({ stepKey: z.string().min(1), label: z.string().min(1), input: z.json() }).strict()),
}).strict();
export type WaitWitness = { readonly ref: SlotRef; readonly changedTick: Tick };
export class MissingSlotInputs extends Error {
  constructor(readonly witnesses: readonly [WaitWitness, ...WaitWitness[]]) { super('Slot inputs are not available'); }
}
export type GatherSnapshot = {
  readonly manifest: Manifest;
  readonly plan: GatherInput<Json> | Waiting;
  readonly waits: readonly WaitWitness[];
};
type SlotRow = { current_id: string | null; changed_tick: string; last_error: unknown };

/** Only gather runs in this snapshot; effects and derive run after it closes. */
export async function gatherSnapshot(
  db: Db,
  scope: { readonly learner: Manifest['learner']; readonly purpose: string },
  gather: (ctx: GatherContext) => GatherInput<Json> | Waiting | Promise<GatherInput<Json> | Waiting>,
): Promise<GatherSnapshot> {
  return db.snapshot({ learner: scope.learner }, async tx => {
    const clock = await tx.query<{ clock: string }>('SELECT clock::text FROM learners WHERE id=$1', [tx.learner]);
    const manifest = parseManifest({ version: 1, learner: tx.learner, purpose: scope.purpose, gatherTick: clock.rows[0]?.clock, inputs: [] });
    const waits: WaitWitness[] = [];
    let open = true;
    let pending = 0;
    const track = async <T>(read: () => Promise<T>): Promise<T> => {
      if (!open) throw new Error('Gather context has closed');
      pending++;
      try {
        const result = await read();
        if (!open) throw new Error('Gather context has closed');
        return result;
      } finally { pending--; }
    };
    const base = createCommandReadContext(tx, scope.purpose);
    const recordSlot = async <Value>(ref: SlotRef): Promise<{ id: ReturnType<typeof derivationId>; slot: SlotRef; outcome: Outcome<Value> }> => {
      if (ref.learner !== tx.learner) throw new Error('Slot learner does not match snapshot');
      const state = await tx.query<SlotRow>(
        'SELECT current_id, changed_tick::text, last_error FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [tx.learner, ref.type, ref.key],
      );
      const row = state.rows[0];
      if (!row?.current_id) {
        if (row?.last_error) throw new Error('Required slot has failed or is unavailable');
        throw new MissingSlotInputs([{ ref, changedTick: (row?.changed_tick ?? '0') as Tick }]);
      }
      const input = { kind: 'slot' as const, slotType: ref.type, slotKey: ref.key, derivationId: row.current_id, mode: 'following' as const };
      const checked = parseManifest({ ...manifest, inputs: [input] });
      const verdict = await revalidateManifest(tx, checked);
      if (verdict.kind === 'invalid') throw new Error(verdict.reason);
      const value = await tx.query<{ value: unknown }>('SELECT value FROM derivations WHERE learner_id=$1 AND id=$2', [tx.learner, row.current_id]);
      return { id: derivationId(row.current_id), slot: ref, outcome: outcomeSchema.parse(value.rows[0]?.value) as Outcome<Value> };
    };
    const ctx: GatherContext = { learner: tx.learner, snapshotTick: manifest.gatherTick, read: {
      fact: <Value = Json>(id: FactId, options: Parameters<ReadContext['fact']>[1]) => track(async () => {
        const snapshot = await base.fact<Value>(id, options);
        manifest.inputs.push({ kind: 'fact', id, rev: snapshot.ref.rev, accessEpoch: snapshot.accessEpoch, mode: options.mode });
        return snapshot;
      }),
      slot: <Value = Json>(ref: SlotRef, options: Parameters<ReadContext['slot']>[1]) => track(async () => {
        const snapshot = await recordSlot<Value>(ref);
        manifest.inputs.push({ kind: 'slot', slotType: ref.type, slotKey: ref.key, derivationId: snapshot.id, mode: options.mode });
        return snapshot;
      }),
      range: <Value = Json>(slotType: string, scope: JsonObject) => track(async () => {
        const rows = await rangeRows(tx, slotType, scope);
        const missing = rows.filter(row => !row.current_id);
        if (missing.some(row => row.last_error)) throw new Error('Required range member has failed or is unavailable');
        const witnesses = missing.map(row => ({ ref: { learner: tx.learner, type: slotType, key: row.slot_key }, changedTick: row.changed_tick as Tick }));
        if (witnesses[0]) throw new MissingSlotInputs([witnesses[0], ...witnesses.slice(1)]);
        const members = [];
        for (const row of rows) members.push(await recordSlot<Value>({ learner: tx.learner, type: slotType, key: row.slot_key }));
        const input = parseManifest({ ...manifest, inputs: [{ kind: 'range', slotType, scope, watermark: manifest.gatherTick, members: members.map(member => ({ slotKey: member.slot.key, derivationId: member.id })) }] }).inputs[0]!;
        manifest.inputs.push(input);
        return { watermark: manifest.gatherTick, members };
      }),
    } };
    let plan: GatherInput<Json> | Waiting;
    try {
      const result = await gather(ctx);
      canonicalJsonString(result);
      if (result.kind === 'waiting') {
        const parsed = waitingSchema.parse(result);
        for (const target of parsed.targets) {
          if (target.kind !== 'range' && target.ref.learner !== tx.learner) throw new Error('Wait target learner does not match snapshot');
          if (target.kind === 'slot') {
            const observed = await tx.query<{changed_tick:string}>('SELECT changed_tick::text FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3', [tx.learner, target.ref.type, target.ref.key]);
            waits.push({ ref: target.ref, changedTick: (observed.rows[0]?.changed_tick ?? '0') as Tick });
          }
        }
        plan = { kind: 'waiting', targets: [parsed.targets[0]!, ...parsed.targets.slice(1)] };
      } else plan = planSchema.parse(result);
    } catch (error) {
      if (!(error instanceof MissingSlotInputs)) throw error;
      waits.push(...error.witnesses);
      const first = waits[0]!;
      plan = { kind: 'waiting', targets: [{ kind: 'slot', ref: first.ref }, ...waits.slice(1).map(witness => ({ kind: 'slot' as const, ref: witness.ref }))] };
    } finally { open = false; }
    if (pending) throw new Error('Gather returned with unfinished reads');
    return { manifest: parseManifest(manifest), plan, waits };
  });
}

async function rangeRows(tx: ReadTransaction, slotType: string, scope: JsonObject) {
  return (await tx.query<SlotRow & { slot_key: string }>(
    `SELECT slot_key, current_id, changed_tick::text, last_error FROM slot_state
     WHERE learner_id=$1 AND slot_type=$2 AND evidence_eligible AND scope_keys @> $3::jsonb ORDER BY slot_key`,
    [tx.learner, slotType, canonicalJsonString(scope)],
  )).rows;
}
