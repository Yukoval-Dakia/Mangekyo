import { assertDeletionWatermark, assertUnburned, deletionWatermark, LifecycleError } from '../lifecycle.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeJson, canonicalJsonString } from '../commands/canonical.ts';
import { lockLearner } from '../db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../db/types.ts';
import { learnerId, type Tick } from '../declarations/ids.ts';
import type { Manifest } from '../derivations/manifest.ts';
import type { WorkRef, WorkRequest } from './demand.ts';
import type { Json, JsonObject } from '../declarations/types.ts';
import { newUlid } from './identity.ts';
import { assertPayloadWork } from './payload.ts';

export type EffectRequest = {
  readonly learner: string;
  readonly ownerKind: 'derivation' | 'session';
  readonly ownerId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly input: Json;
  readonly payloadWork?: WorkRef;
};
export type EffectResult =
  | { readonly kind: 'done'; readonly result: Json }
  | { readonly kind: 'unknown'; readonly providerEffectId: string | null; readonly inFlight?: true };

export type CompletedEffectRecord = {
  readonly ownerKind: 'derivation' | 'session';
  readonly ownerId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly input: Json;
  readonly result: Json;
  readonly providerEffectId?: string;
  readonly budgetRoute?: string;
  readonly reservedUsdMicros?: number;
  readonly actualUsdMicros?: number | null;
};

/** Record an already-finished provider call inside the caller's transaction; replay-safe. */
export async function recordCompletedEffect(tx: DbTransaction, tick: Tick, record: CompletedEffectRecord) {
  const input = canonicalizeJson(record.input);
  const result = canonicalizeJson(record.result);
  await tx.query(
    `INSERT INTO effects (learner_id, owner_kind, owner_id, step_key, label, input_digest, input,
       provider_effect_id, state, result, started_tick, ended_tick,
       budget_route, reserved_usd_micros, actual_usd_micros)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'done',$9,$10,$10,$11,$12,$13)
      ON CONFLICT (learner_id, owner_kind, owner_id, step_key, label) DO NOTHING`,
    [tx.learner, record.ownerKind, record.ownerId, record.stepKey, record.label,
      createHash('sha256').update(canonicalJsonString(input)).digest('hex'), JSON.stringify(input),
      record.providerEffectId ?? null, JSON.stringify(result), tick,
      record.budgetRoute ?? null, record.reservedUsdMicros ?? null, record.actualUsdMicros ?? null],
  );
}

type EffectIdentity = readonly [string, EffectRequest['ownerKind'], string, string, string];

type EffectRow = {
  input_digest: string;
  basis_current: boolean;
  has_result: boolean;
  legacy: boolean;
  provider_effect_id: string | null;
  budget_route: string | null;
  reserved_usd_micros: string | null;
  prepaid_generation: string | null;
  payload_work_id: string | null;
  state: 'started' | 'done' | 'unknown';
  result: unknown;
};

const json = z.json();

function effectInputMetadata(input: Json): JsonObject | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const source = input as Record<string, Json>;
  const metadata: Record<string, string> = {};
  for (const key of ['provider', 'model'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value) metadata[key] = value;
  }
  return Object.keys(metadata).length ? metadata : null;
}

export class EffectBudgetExceeded extends Error {}
export class EffectIdentityMismatch extends Error {}

export type EffectBudget = {
  readonly route: string;
  readonly limitUsdMicros: number;
  readonly reserveUsdMicros: number;
  readonly actualUsdMicros: (result: Json) => number | null;
  readonly workStages?: { readonly followups: readonly string[] } | 'claim';
};

export async function effectBudgetUsage(tx: ReadTransaction) {
  const { rows: [row] } = await tx.query<{ settled: string; held: string }>(
    `SELECT COALESCE(sum(actual_usd_micros),0)::text AS settled,
      COALESCE(sum(reserved_usd_micros) FILTER (WHERE actual_usd_micros IS NULL),0)::text AS held
      FROM (
        SELECT reserved_usd_micros,actual_usd_micros FROM effects
        WHERE learner_id=$1 AND reserved_usd_micros IS NOT NULL
          AND (prepaid_generation IS NULL OR EXISTS (
            SELECT 1 FROM work w WHERE w.learner_id=effects.learner_id AND w.id=effects.payload_work_id
              AND w.generation=effects.prepaid_generation AND w.state='ready'))
        UNION ALL
        SELECT reserved_usd_micros,actual_usd_micros FROM erased_effect_receipts
        WHERE learner_id=$1 AND reserved_usd_micros IS NOT NULL
      ) charges`, [tx.learner],
  );
  return { settled: BigInt(row!.settled), held: BigInt(row!.held) };
}

async function requireBudget(tx: ReadTransaction, budget: EffectBudget, calls: number) {
  if (!calls) return;
  const { settled, held } = await effectBudgetUsage(tx);
  if (settled + held + BigInt(calls) * BigInt(budget.reserveUsdMicros) > BigInt(budget.limitUsdMicros))
    throw new EffectBudgetExceeded('Effect budget exhausted');
}

function samePrice(row: Pick<EffectRow, 'budget_route' | 'reserved_usd_micros'>, budget?: EffectBudget) {
  return row.budget_route === (budget?.route ?? null) &&
    row.reserved_usd_micros === (budget ? String(budget.reserveUsdMicros) : null);
}

/** Funds future steps whose input will only be known after the first response. */
async function reserveFollowups(tx: DbTransaction, identity: EffectIdentity, work: WorkRef,
  budget: EffectBudget, followups: readonly string[], firstCall: boolean) {
  const [learner, ownerKind, ownerId, , label] = identity;
  const keys = [learner, ownerKind, ownerId, label, followups] as const;
  const { rows } = await tx.query<Pick<EffectRow, 'budget_route' | 'reserved_usd_micros' |
    'prepaid_generation' | 'payload_work_id'> & { step_key: string }>(
    `SELECT step_key, budget_route, reserved_usd_micros::text, prepaid_generation::text, payload_work_id
     FROM effects WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND label=$4 AND step_key=ANY($5)`, keys);
  const stale = rows.filter(row => row.payload_work_id === work.workId &&
    row.prepaid_generation !== null && row.prepaid_generation !== work.generation);
  const retained = rows.filter(row => !stale.includes(row));
  if (retained.some(row => !samePrice(row, budget) ||
      (row.prepaid_generation !== null && row.payload_work_id !== work.workId)))
    throw new EffectIdentityMismatch('Effect stage already held or used with different terms');
  const missing = followups.filter(step => !retained.some(row => row.step_key === step));
  await requireBudget(tx, budget, missing.length + Number(firstCall));
  if (!missing.length) return;
  await tx.withLearnerWrite(async tick => {
    if (stale.length) await tx.query(`DELETE FROM effects WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3
      AND label=$4 AND step_key=ANY($5) AND prepaid_generation IS NOT NULL`,
    [learner, ownerKind, ownerId, label, stale.map(row => row.step_key)]);
    for (const step of missing) await tx.insert('effects', {
      learner_id: learner, owner_kind: ownerKind, owner_id: ownerId, step_key: step, label,
      input_digest: '', state: 'started', started_tick: tick, payload_work_id: work.workId,
      prepaid_generation: work.generation, reserved_usd_micros: budget.reserveUsdMicros, budget_route: budget.route,
    });
  });
}

async function erasedProviderEffect(tx: ReadTransaction, identity: EffectIdentity) {
  const {rows: [receipt]} = await tx.query<{provider_effect_id: string}>(
    `SELECT provider_effect_id FROM erased_effect_receipts
     WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5`, identity);
  return receipt?.provider_effect_id;
}

/** The response is already durable. Publication may be retried without access to the transport. */
async function publishPricedReceipt(tx: DbTransaction, identity: EffectIdentity, providerEffectId: string | null): Promise<EffectResult> {
  await lockLearner(tx, tx.learner);
  const { rows: [receipt] } = await tx.query<{ state: 'started' | 'done'; result: unknown }>(
    `SELECT state,result FROM effects
     WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
       AND provider_effect_id=$6 AND state IN ('started','done') AND result IS NOT NULL
       AND reserved_usd_micros IS NOT NULL AND effect_may_settle(learner_id, owner_id, started_tick, input_basis)`,
    [...identity, providerEffectId],
  );
  if (!receipt) return { kind: 'unknown', providerEffectId };
  const result = json.parse(receipt.result);
  if (receipt.state === 'started') await tx.withLearnerWrite(tick => tx.query(
    `UPDATE effects SET state = 'done', ended_tick = $6
     WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5`,
    [...identity, tick],
  ));
  return { kind: 'done', result };
}

/** A supplied authorization check runs under the learner lock for reservation and replay. */
export async function runEffect(
  db: Db,
  request: EffectRequest,
  invoke: (providerEffectId: string, checkDispatch: (tx: DbTransaction) => Promise<void>) => Promise<Json>,
  authorize?: (tx: DbTransaction) => Promise<void> | void,
  // Supplied by the host only for a closed set of independently authored fact inputs.
  basis?: { manifest: Manifest; work?: WorkRef & { ownerSlot?: WorkRequest } },
  // Priced effects must persist only content-free receipts. Financial settlement survives withdrawal of consent.
  budget?: EffectBudget,
): Promise<EffectResult> {
  const { ownerKind, ownerId, stepKey, label, input } = request;
  const learner = learnerId(request.learner);
  const identity: EffectIdentity = [learner, ownerKind, ownerId, stepKey, label];
  const digest = createHash('sha256').update(canonicalJsonString(input)).digest('hex');
  if (budget && (!Number.isSafeInteger(budget.reserveUsdMicros) || budget.reserveUsdMicros <= 0 ||
      !Number.isSafeInteger(budget.limitUsdMicros) || budget.limitUsdMicros <= 0 || !budget.route))
    throw new Error('Invalid effect budget');
  const stages = budget?.workStages;
  const work = request.payloadWork;
  if (stages && (!work || (stages !== 'claim' &&
      (stages.followups.includes(stepKey) || new Set(stages.followups).size !== stages.followups.length))))
    throw new Error('Invalid effect stage reservation');
  const reservation = await db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    await assertUnburned(tx, 'fact', [request.ownerId]);
    const erasedId = await erasedProviderEffect(tx, identity);
    if (erasedId) return { kind: 'unknown', providerEffectId: erasedId } as const;
    if (request.payloadWork) await assertPayloadWork(tx, request.payloadWork);
    await authorize?.(tx);
    const { rows: [prior] } = await tx.query<EffectRow>(
      `SELECT input_digest, provider_effect_id, state, result, budget_route, reserved_usd_micros::text,
              prepaid_generation::text, payload_work_id,
              input_basis IS NULL AS legacy, result IS NOT NULL AS has_result,
              effect_may_settle(learner_id, owner_id, started_tick, input_basis) AS basis_current FROM effects
       WHERE learner_id = $1 AND owner_kind = $2 AND owner_id = $3 AND step_key = $4 AND label = $5`,
      identity,
    );
    if (prior && prior.prepaid_generation === null) {
      if (prior.input_digest !== digest || !samePrice(prior, budget))
        throw new EffectIdentityMismatch('Effect identity already used with different input');
      if (budget && stages && stages !== 'claim' && prior.has_result && prior.basis_current)
        await reserveFollowups(tx, identity, work!, budget, stages.followups, false);
      if (budget && prior.state === 'started' && prior.has_result)
        return publishPricedReceipt(tx, identity, prior.provider_effect_id);
      if (prior.state === 'done') {
        if (!prior.basis_current && prior.legacy)
          throw new LifecycleError(409, '旧发送凭据缺少跨删除水位的输入依据。', 'legacy_effect_basis_missing');
        if (!prior.basis_current) throw new Error('Effect inputs no longer authorized');
        return { kind: 'done', result: json.parse(prior.result) } as const;
      }
      return { kind: 'unknown', providerEffectId: prior.provider_effect_id,
        ...(budget && prior.state === 'started' ? { inFlight: true as const } : {}) } as const;
    }

    if (stages === 'claim') {
      if (!prior || prior.prepaid_generation !== work!.generation ||
          prior.payload_work_id !== work!.workId || !samePrice(prior, budget))
        throw new EffectIdentityMismatch('Effect stage has no matching work reservation');
    } else if (prior) throw new EffectIdentityMismatch('Effect stage must claim its work reservation');
    else if (budget && stages) await reserveFollowups(tx, identity, work!, budget, stages.followups, true);
    else if (budget) await requireBudget(tx, budget, 1);
    const providerEffectId = newUlid();
    const inputMetadata = effectInputMetadata(input);
    return tx.withLearnerWrite(async tick => {
      // The unsent hold becomes an immutable dispatch claim without releasing budget.
      if (stages === 'claim') await tx.query(`DELETE FROM effects
        WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
          AND prepaid_generation IS NOT NULL`, identity);
      await tx.insert('effects', {
        learner_id: learner,
        owner_kind: ownerKind,
        owner_id: ownerId,
        step_key: stepKey,
        label,
        input_digest: digest,
        input: inputMetadata === null ? null : JSON.stringify(inputMetadata),
        provider_effect_id: providerEffectId,
        state: 'started',
        started_tick: tick,
        input_basis: basis ? JSON.stringify(basis) : null,
        ...(request.payloadWork && {payload_work_id:request.payloadWork.workId}),
        ...(budget && { reserved_usd_micros: budget.reserveUsdMicros, budget_route: budget.route }),
      });
      return { kind: 'invoke', providerEffectId, tick, deletionWatermark: await deletionWatermark(tx) } as const;
    });
  });
  if (reservation.kind !== 'invoke') return reservation;

  // Call under the learner lock immediately before the transport starts. A
  // durable claim can survive a transaction that changes the deletion fence.
  const checkDispatch = async (tx: DbTransaction) => {
    if (tx.learner !== learner) throw new Error('Effect dispatch learner mismatch');
    await lockLearner(tx, learner);
    await assertUnburned(tx, 'fact', [request.ownerId]);
    if (request.payloadWork) await assertPayloadWork(tx, request.payloadWork);
    if (!basis) await assertDeletionWatermark(tx, reservation.deletionWatermark);
    const { rows: [active] } = await tx.query(`
      SELECT 1 FROM effects WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3
        AND step_key=$4 AND label=$5 AND state='started' AND started_tick=$6
        AND provider_effect_id=$7 AND effect_may_settle(learner_id, owner_id, started_tick, input_basis)`,
    [...identity, reservation.tick, reservation.providerEffectId]);
    if (!active)
      throw new LifecycleError(409, '原发送凭据已失效。', 'effect_dispatch_stale');
  };

  let outcome: EffectResult;
  let encoded: string | null = null;
  let actual: number | null = null;
  try {
    const result = canonicalizeJson(await invoke(reservation.providerEffectId, checkDispatch));
    if (budget) {
      const reported = budget.actualUsdMicros(result);
      if (reported !== null && Number.isSafeInteger(reported) && reported >= 0) actual = reported;
    }
    encoded = JSON.stringify(result);
    outcome = { kind: 'done', result };
  } catch {
    outcome = { kind: 'unknown', providerEffectId: reservation.providerEffectId };
  }

  if (budget && encoded !== null) {
    // Persist the validated decision and known amount together before publishing the receipt.
    // The accounting-only path is allowed even when the decision can no longer be stored.
    const saved = await db.tx({ learner }, tx => tx.withLearnerWrite(async () => {
      if (actual !== null) {
        const keys = [learner, reservation.providerEffectId, reservation.tick, actual] as const;
        const live = await tx.query(`UPDATE effects SET actual_usd_micros=$4
          WHERE learner_id=$1 AND provider_effect_id=$2 AND started_tick=$3
            AND reserved_usd_micros IS NOT NULL AND actual_usd_micros IS NULL`, keys);
        if (!live.rowCount) await tx.query(`UPDATE erased_effect_receipts SET actual_usd_micros=$4
          WHERE learner_id=$1 AND provider_effect_id=$2 AND started_tick=$3
            AND reserved_usd_micros IS NOT NULL AND actual_usd_micros IS NULL`, keys);
      }
      const receipt = await tx.query(`UPDATE effects SET result=$6
        WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
          AND state='started' AND started_tick=$7 AND result IS NULL
          AND effect_may_settle(learner_id, owner_id, started_tick, input_basis)`,
      [...identity, encoded, reservation.tick]);
      return receipt.rowCount === 1;
    }));
    if (!saved) return { kind: 'unknown', providerEffectId: reservation.providerEffectId };
    return db.tx({ learner }, tx => publishPricedReceipt(tx, identity, reservation.providerEffectId));
  }

  return db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
    if (!budget) {
      await assertUnburned(tx, 'fact', [request.ownerId]);
      if (!basis) await assertDeletionWatermark(tx,reservation.deletionWatermark);
      await authorize?.(tx);
    } else {
      const current = await tx.query(`SELECT 1 FROM effects
        WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
          AND state='started' AND started_tick=$6
          AND effect_may_settle(learner_id, owner_id, started_tick, input_basis)`,
      [...identity, reservation.tick]);
      if (!current.rowCount) return { kind: 'unknown', providerEffectId: reservation.providerEffectId };
    }
    const updated = await tx.query(
      `UPDATE effects SET state = $6, result = $7, ended_tick = $8
       WHERE learner_id = $1 AND owner_kind = $2 AND owner_id = $3 AND step_key = $4 AND label = $5
         AND state = 'started' AND started_tick = $9`,
      [...identity, outcome.kind, encoded, tick, reservation.tick],
    );
    if (updated.rowCount !== 1) throw new Error('Effect reservation no longer active');
    return outcome;
  }));
}

/** Discovery may schedule a new request or resume its receipt, but cannot resend a pending request. */
export async function canProcessPricedEffect(tx: ReadTransaction,
  { ownerKind, ownerId, stepKey, label }: Omit<EffectRequest, 'learner' | 'input'>) {
  const identity = [tx.learner, ownerKind, ownerId, stepKey, label] as const;
  if (await erasedProviderEffect(tx, identity)) return false;
  const { rowCount } = await tx.query(
    `SELECT 1 FROM effects WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
      AND ((state='started' AND result IS NULL) OR consumed_tick IS NOT NULL OR
        NOT effect_may_settle(learner_id, owner_id, started_tick, input_basis))`,
    identity,
  );
  return rowCount === 0;
}

/** Consume a terminal paid receipt and register its business outcome in the same learner transaction. */
export async function consumePricedEffect(tx: DbTransaction,
  { ownerKind, ownerId, stepKey, label }: Omit<EffectRequest, 'learner' | 'input'>,
  consume: ((tick: Tick) => Promise<string | null>) | 'discard') {
  await lockLearner(tx, tx.learner);
  const identity = [tx.learner, ownerKind, ownerId, stepKey, label] as const;
  // A superseded request can retire an already received decision without reading it
  // or creating work. A reservation with no response must remain in flight.
  const { rows: [receipt] } = await tx.query<{ state: string }>(`SELECT state FROM effects
    WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5
      AND reserved_usd_micros IS NOT NULL AND consumed_tick IS NULL
      AND (state<>'started' OR ($6 AND result IS NOT NULL))
      AND effect_may_settle(learner_id, owner_id, started_tick, input_basis)`, [...identity, consume === 'discard']);
  if (!receipt) return false;
  await tx.withLearnerWrite(async tick => {
    if (receipt.state === 'started') await tx.query(
      `UPDATE effects SET state='done', ended_tick=$6
       WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5`, [...identity, tick]);
    const todoId = consume === 'discard' ? null : await consume(tick);
    await tx.query(`UPDATE effects SET consumed_tick=$6, consumer_todo_id=$7
      WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5`,
    [...identity, tick, todoId]);
  });
  return true;
}

/** A local read and its replay receipt commit together. A database failure leaves no claim. */
export async function recordLocalRead(
  db: Db,
  request: EffectRequest,
  read: (tx: ReadTransaction) => Promise<string>,
  authorize: (tx: DbTransaction) => Promise<void>,
): Promise<string> {
  const learner = learnerId(request.learner);
  const identity = [learner, request.ownerKind, request.ownerId, request.stepKey, request.label] as const;
  const digest = createHash('sha256').update(canonicalJsonString(request.input)).digest('hex');
  return db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    await assertUnburned(tx, 'fact', [request.ownerId]);
    if (request.payloadWork) await assertPayloadWork(tx, request.payloadWork);
    await authorize(tx);
    const { rows: [saved] } = await tx.query<Pick<EffectRow, 'state' | 'result' | 'input_digest'>>(
      `SELECT state, result, input_digest FROM effects
       WHERE learner_id=$1 AND owner_kind=$2 AND owner_id=$3 AND step_key=$4 AND label=$5`,
      identity,
    );
    if (saved) {
      if (saved.input_digest !== digest || saved.state !== 'done' || typeof saved.result !== 'string') {
        throw new Error('Workspace read receipt does not match the request');
      }
      return saved.result;
    }
    const result = await read(tx);
    return tx.withLearnerWrite(async tick => {
      await tx.insert('effects', {
        learner_id: learner,
        owner_kind: request.ownerKind,
        owner_id: request.ownerId,
        step_key: request.stepKey,
        label: request.label,
        input_digest: digest,
        ...(request.payloadWork && {payload_work_id:request.payloadWork.workId}),
        state: 'done',
        result: JSON.stringify(result),
        started_tick: tick,
        ended_tick: tick,
      });
      return result;
    });
  });
}
