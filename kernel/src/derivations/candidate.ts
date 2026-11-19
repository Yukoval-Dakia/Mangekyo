import { z } from 'zod';
import { canonicalJsonString } from '../commands/canonical.ts';
import { lockLearner } from '../db/learner.ts';
import type { Db, DbTransaction } from '../db/types.ts';
import type { SlotDefinition } from '../declarations/define.ts';
import { derivationId, learnerId, type DerivationId, type Tick } from '../declarations/ids.ts';
import type { CommandInput, DerivationSnapshot, GatherInput, Json, SlotRef } from '../declarations/types.ts';
import { requestWork, type WorkRef, type WorkRequest } from '../work/index.ts';
import { newUlid } from '../work/identity.ts';
import type { GatherSnapshot } from './gather.ts';
import { parseManifest, type Manifest } from './manifest.ts';
import { revalidateManifest } from './revalidate.ts';

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.json() }).strict(),
  z.object({ kind: z.literal('unknown'), reason: z.string() }).strict(),
]);
const acceptanceSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
const submissionSchema = z.union([
  outcomeSchema,
  z.object({ kind: z.literal('failed'), reason: z.string() }).strict(),
]);
const sealSchema = z.object({
  id: z.string().transform(derivationId),
  plan: z.object({
    kind: z.literal('input'), data: z.json(),
    effects: z.array(z.object({ stepKey: z.string().min(1), label: z.string().min(1), input: z.json() }).strict()),
  }).strict(),
}).strict();

export type CandidatePolicy = {
  // The kernel resolves these from the ready work and its configured use before gather.
  readonly deriver: string;
  readonly purpose: string;
  readonly slot: Pick<SlotDefinition, 'type' | 'accept' | 'adopt'>;
};
type ReadyWork = WorkRequest & {
  readonly requested_tick: string;
  readonly gather: unknown;
  readonly gather_manifest: unknown;
  readonly current_id: string | null;
  readonly scope_keys: unknown;
};
type SealedCandidate = {
  readonly id: DerivationId;
  readonly plan: GatherInput<Json>;
  readonly manifest: Manifest;
};
type Obsolete = { readonly kind: 'obsolete' };
type Retry = { readonly kind: 'retry'; readonly ref: WorkRef; readonly reason: string };
type Freshness = 'current' | 'behind';
type TerminalFailure = { readonly kind: 'rejected' | 'failed'; readonly reason: string };
export type SealResult = Obsolete | Retry | ({ readonly kind: 'sealed' } & SealedCandidate);
export type SubmitResult = Obsolete | Retry | { readonly kind: 'unbound' } | TerminalFailure
  | { readonly kind: 'effective'; readonly tick: Tick; readonly freshness: Freshness };

export type SlotChange = { readonly slot: SlotRef; readonly id: DerivationId; readonly previousCurrent: DerivationId | null }
  & ({ readonly kind: 'effective'; readonly freshness: Freshness }
    | { readonly kind: 'invalidated'; readonly reason: string }
    | (TerminalFailure & { readonly freshness: Freshness | null }));
export type CandidateHooks = {
  /** Propagate the change, reconcile waits and register downstream demand using this transaction and tick. */
  readonly onSlotChanged: (tx: DbTransaction, tick: Tick, change: SlotChange) => void | Promise<void>;
  /** Unit 5 executes these declared commands with adoption provenance in this same transaction. */
  readonly adopt?: (tx: DbTransaction, tick: Tick, source: DerivationId, commands: readonly CommandInput[]) => void | Promise<void>;
};

async function readyWork(tx: DbTransaction, ref: WorkRef, policy: CandidatePolicy): Promise<ReadyWork | undefined> {
  const { rows: [work] } = await tx.query<ReadyWork>(
    `SELECT w.slot_type AS "slotType", w.slot_key AS "slotKey", w.deriver, w.requested_tick::text,
       w.gather, w.gather_manifest, s.current_id, s.scope_keys
     FROM work w JOIN slot_state s USING (learner_id, slot_type, slot_key)
     WHERE w.learner_id = $1 AND w.id = $2 AND w.generation = $3 AND w.state = 'ready'`,
    [tx.learner, ref.workId, ref.generation],
  );
  if (work && (work.deriver !== policy.deriver || work.slotType !== policy.slot.type)) {
    throw new Error('Candidate policy does not match the ready work');
  }
  if (work && (!policy.purpose || policy.purpose === 'storage' || policy.purpose === 'all')) {
    throw new Error('Candidate policy requires a specific computation purpose');
  }
  return work;
}

function readSeal(work: ReadyWork): SealedCandidate | null {
  if (work.gather === null && work.gather_manifest === null) return null;
  return { ...sealSchema.parse(work.gather), manifest: parseManifest(work.gather_manifest) };
}

async function validateInputs(tx: DbTransaction, work: ReadyWork, policy: CandidatePolicy, manifest: Manifest) {
  if (manifest.purpose !== policy.purpose) {
    return { kind: 'invalid', reason: 'Gather purpose does not match the authorized computation purpose' } as const;
  }
  if (BigInt(manifest.gatherTick) < BigInt(work.requested_tick)) {
    return { kind: 'invalid', reason: 'Gather predates the current work generation' } as const;
  }
  return revalidateManifest(tx, manifest, policy.purpose);
}

async function inspectSeal(tx: DbTransaction, work: ReadyWork, sealed: SealedCandidate) {
  const { rows: [candidate] } = await tx.query<{
    lifecycle: string; gather_tick: string; manifest: unknown; scope_keys: unknown; invalidated_tick: string | null;
  }>(
    `SELECT lifecycle, gather_tick::text, manifest, scope_keys, invalidated_tick::text FROM derivations
     WHERE learner_id = $1 AND id = $2 AND slot_type = $3 AND slot_key = $4 AND deriver = $5
       AND NOT is_shadow AND effective_tick IS NULL AND selection_ended_tick IS NULL AND value IS NULL`,
    [tx.learner, sealed.id, work.slotType, work.slotKey, work.deriver],
  );
  if (!candidate || !['candidate', 'stale'].includes(candidate.lifecycle)
      || candidate.gather_tick !== sealed.manifest.gatherTick
      || canonicalJsonString(candidate.manifest) !== canonicalJsonString(sealed.manifest)) {
    throw new Error('Ready work has an inconsistent candidate seal');
  }
  if (candidate.lifecycle === 'stale' || candidate.invalidated_tick !== null) return 'Sealed candidate was invalidated';
  if (canonicalJsonString(candidate.scope_keys) !== canonicalJsonString(work.scope_keys)) return 'Slot scope changed';
  return null;
}

function endCandidate(tx: DbTransaction, tick: Tick, id: DerivationId, failure: TerminalFailure, value: string | null) {
  return tx.query(
    `UPDATE derivations SET lifecycle = $4, error = $5, value = $6,
       invalidated_tick = CASE WHEN $4 = 'rejected' THEN COALESCE(invalidated_tick, $3::bigint) ELSE invalidated_tick END
     WHERE learner_id = $1 AND id = $2`,
    [tx.learner, id, tick, failure.kind, JSON.stringify({ reason: failure.reason }), value],
  );
}

function retry(tx: DbTransaction, work: ReadyWork, sealed: SealedCandidate | null, reason: string): Promise<Retry> {
  return tx.withLearnerWrite(async tick => {
    if (sealed) await endCandidate(tx, tick, sealed.id, { kind: 'rejected', reason }, null);
    const ref = await requestWork(tx, tick, work);
    return { kind: 'retry', ref, reason };
  });
}

/** Seal the kernel's actual gather snapshot for this work ref before effects or derive run. */
export function sealCandidate(db: Db, ref: WorkRef, policy: CandidatePolicy, snapshot: GatherSnapshot): Promise<SealResult> {
  return db.tx({ learner: learnerId(ref.learner) }, async tx => {
    await lockLearner(tx, tx.learner);
    const work = await readyWork(tx, ref, policy);
    if (!work) return { kind: 'obsolete' };
    const sealed = readSeal(work);
    if (!sealed && snapshot.plan.kind !== 'input') throw new Error('Waiting gather must register its wait witnesses');
    const manifest = sealed?.manifest ?? parseManifest(snapshot.manifest);
    if (!sealed && manifest.learner !== tx.learner) throw new Error('Gather learner does not match ready work');
    const invalidated = sealed && await inspectSeal(tx, work, sealed);
    if (invalidated) return retry(tx, work, sealed, invalidated);
    const checked = await validateInputs(tx, work, policy, manifest);
    if (checked.kind === 'invalid') return retry(tx, work, sealed, checked.reason);
    if (sealed) return { kind: 'sealed', ...sealed };

    const { id, plan } = sealSchema.parse({ id: newUlid(), plan: snapshot.plan });
    const encodedManifest = canonicalJsonString(manifest);
    return tx.withLearnerWrite(async () => {
      await tx.insert('derivations', {
        learner_id: tx.learner, id, slot_type: work.slotType, slot_key: work.slotKey,
        deriver: work.deriver, scope_keys: canonicalJsonString(work.scope_keys),
        lifecycle: 'candidate', freshness: checked.freshness, gather_tick: manifest.gatherTick,
        manifest: encodedManifest,
      });
      await tx.query(
        'UPDATE work SET gather = $4, gather_manifest = $5 WHERE learner_id = $1 AND id = $2 AND generation = $3',
        [tx.learner, ref.workId, ref.generation, canonicalJsonString({ id, plan }), encodedManifest],
      );
      return { kind: 'sealed', id, plan, manifest };
    });
  });
}

async function readCurrent(tx: DbTransaction, slot: SlotRef, id: DerivationId, purpose: string) {
  const { rows: [current] } = await tx.query<{ value: unknown; manifest: unknown }>(
    `SELECT value, manifest FROM derivations WHERE learner_id = $1 AND id = $2 AND slot_type = $3 AND slot_key = $4
       AND lifecycle = 'effective' AND invalidated_tick IS NULL AND NOT is_shadow`,
    [tx.learner, id, slot.type, slot.key],
  );
  if (!current) throw new Error('Slot current derivation is inconsistent');
  const manifest = parseManifest(current.manifest);
  if ((await revalidateManifest(tx, manifest)).kind === 'invalid') return { kind: 'invalid' } as const;
  if (purpose !== manifest.purpose && (await revalidateManifest(tx, manifest, purpose)).kind === 'invalid') {
    return { kind: 'denied' } as const;
  }
  const snapshot: DerivationSnapshot = { id, slot, outcome: outcomeSchema.parse(current.value) };
  return { kind: 'current', snapshot } as const;
}

function clearInvalidCurrent(
  tx: DbTransaction, slot: SlotRef, id: DerivationId, work: ReadyWork, sealed: SealedCandidate, hooks: CandidateHooks,
): Promise<Retry> {
  const reason = 'The previously selected value lost its inputs';
  const error = canonicalJsonString({ reason });
  return tx.withLearnerWrite(async tick => {
    await tx.query(
      `UPDATE derivations SET lifecycle = 'stale', invalidated_tick = $3, error = $4
       WHERE learner_id = $1 AND id = $2`,
      [tx.learner, id, tick, error],
    );
    await tx.query(
      `UPDATE slot_state SET current_id = NULL, last_id = $4, changed_tick = $5, last_error = $6
       WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3 AND current_id = $4`,
      [tx.learner, slot.type, slot.key, id, tick, error],
    );
    await endCandidate(tx, tick, sealed.id, { kind: 'rejected', reason }, null);
    const ref = await requestWork(tx, tick, work);
    await hooks.onSlotChanged(tx, tick, { kind: 'invalidated', slot, id, previousCurrent: id, reason });
    return { kind: 'retry', ref, reason };
  });
}

async function closeWork(tx: DbTransaction, ref: WorkRef, state: 'satisfied' | 'blocked') {
  await tx.query(
    `UPDATE work SET state = $4, gather = NULL, gather_manifest = NULL
     WHERE learner_id = $1 AND id = $2 AND generation = $3`,
    [tx.learner, ref.workId, ref.generation, state],
  );
  await tx.query('DELETE FROM work_waits WHERE learner_id = $1 AND work_id = $2', [tx.learner, ref.workId]);
}

function blockCandidate(
  tx: DbTransaction, ref: WorkRef,
  change: Pick<SlotChange, 'id' | 'slot' | 'previousCurrent'> & { readonly freshness: Freshness | null },
  failure: TerminalFailure, value: string | null, hooks: CandidateHooks,
): Promise<TerminalFailure> {
  return tx.withLearnerWrite(async tick => {
    await endCandidate(tx, tick, change.id, failure, value);
    await closeWork(tx, ref, 'blocked');
    await tx.query(
      `UPDATE slot_state SET pending = 'none', changed_tick = $4, last_error = $5
       WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
      [tx.learner, change.slot.type, change.slot.key, tick, JSON.stringify({ status: 'blocked', reason: failure.reason })],
    );
    await hooks.onSlotChanged(tx, tick, { ...change, ...failure });
    return failure;
  });
}

/** The worker submits its outcome or terminal failure. PG supplies the sealed provenance. */
export function submitCandidate(
  db: Db, ref: WorkRef, policy: CandidatePolicy, id: DerivationId, result: unknown, hooks: CandidateHooks,
): Promise<SubmitResult> {
  return db.tx({ learner: learnerId(ref.learner) }, async tx => {
    await lockLearner(tx, tx.learner);
    const work = await readyWork(tx, ref, policy);
    if (!work) return { kind: 'obsolete' };
    const sealed = readSeal(work);
    if (!sealed || sealed.id !== id) return { kind: 'unbound' };
    const invalidated = await inspectSeal(tx, work, sealed);
    if (invalidated) return retry(tx, work, sealed, invalidated);
    const checked = await validateInputs(tx, work, policy, sealed.manifest);
    if (checked.kind === 'invalid') return retry(tx, work, sealed, checked.reason);

    canonicalJsonString(result);
    const outcome = submissionSchema.parse(result);
    const slot = { learner: tx.learner, type: work.slotType, key: work.slotKey };
    const previousCurrent = work.current_id === null ? null : derivationId(work.current_id);
    const change = { slot, id, previousCurrent, freshness: checked.freshness };
    const previous = previousCurrent && await readCurrent(tx, slot, previousCurrent, policy.purpose);
    if (previousCurrent && previous?.kind === 'invalid') {
      return clearInvalidCurrent(tx, slot, previousCurrent, work, sealed, hooks);
    }
    if (outcome.kind === 'failed') return blockCandidate(tx, ref, change, outcome, null, hooks);
    if (previous?.kind === 'denied') {
      return blockCandidate(tx, ref, { ...change, freshness: null },
        { kind: 'rejected', reason: 'The selected value is unavailable for this purpose' }, null, hooks);
    }

    const value = canonicalJsonString(outcome);
    const accept = policy.slot.accept;
    const decision = accept && acceptanceSchema.parse(accept(
      { learner: tx.learner }, outcome, previous?.snapshot ?? null,
    ));
    if (decision && !decision.ok) {
      return blockCandidate(tx, ref, change, { kind: 'rejected', reason: decision.reason }, value, hooks);
    }

    const commands = outcome.kind === 'value' ? policy.slot.adopt?.(outcome.value) ?? [] : [];
    if (commands.length && !hooks.adopt) throw new Error('Slot adoption requires a transactional command hook');
    return tx.withLearnerWrite(async tick => {
      if (previousCurrent) {
        const ended = await tx.query(
          `UPDATE derivations SET lifecycle = 'superseded', selection_ended_tick = $5
           WHERE learner_id = $1 AND id = $2 AND slot_type = $3 AND slot_key = $4
             AND lifecycle = 'effective' AND selection_ended_tick IS NULL AND invalidated_tick IS NULL AND NOT is_shadow`,
          [tx.learner, previousCurrent, slot.type, slot.key, tick],
        );
        if (ended.rowCount !== 1) throw new Error('Slot current derivation is inconsistent');
      }
      await tx.query(
        `UPDATE derivations SET lifecycle = 'effective', freshness = $3, effective_tick = $4, value = $5
         WHERE learner_id = $1 AND id = $2`,
        [tx.learner, id, checked.freshness, tick, value],
      );
      await closeWork(tx, ref, 'satisfied');
      await tx.query(
        `UPDATE slot_state SET current_id = $4, last_id = $4, pending = 'none', last_error = NULL, changed_tick = $5
         WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
        [tx.learner, slot.type, slot.key, id, tick],
      );
      await hooks.onSlotChanged(tx, tick, { ...change, kind: 'effective' });
      if (commands.length) await hooks.adopt?.(tx, tick, id, commands);
      return { kind: 'effective', tick, freshness: checked.freshness };
    });
  });
}
