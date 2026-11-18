import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalizeJson, canonicalJsonString } from '../commands/canonical.ts';
import { lockLearner } from '../db/learner.ts';
import type { Db, ReadTransaction } from '../db/types.ts';
import { learnerId } from '../declarations/ids.ts';
import type { Json } from '../declarations/types.ts';
import { newUlid } from './identity.ts';

export type EffectRequest = {
  readonly learner: string;
  readonly ownerKind: 'derivation' | 'session';
  readonly ownerId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly input: Json;
};
export type EffectResult =
  | { readonly kind: 'done'; readonly result: Json }
  | { readonly kind: 'unknown'; readonly providerEffectId: string | null };

type EffectRow = {
  input_digest: string;
  provider_effect_id: string | null;
  state: 'started' | 'done' | 'unknown';
  result: unknown;
};
const json = z.json();

/** A supplied authorization check runs under the learner lock for reservation and replay. */
export async function runEffect(
  db: Db,
  request: EffectRequest,
  invoke: (providerEffectId: string) => Promise<Json>,
  authorize?: (tx: ReadTransaction) => Promise<void> | void,
): Promise<EffectResult> {
  const { ownerKind, ownerId, stepKey, label, input } = request;
  const learner = learnerId(request.learner);
  const identity = [learner, ownerKind, ownerId, stepKey, label] as const;
  const digest = createHash('sha256').update(canonicalJsonString(input)).digest('hex');
  const reservation = await db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    await authorize?.(tx);
    const { rows: [prior] } = await tx.query<EffectRow>(
      `SELECT input_digest, provider_effect_id, state, result FROM effects
       WHERE learner_id = $1 AND owner_kind = $2 AND owner_id = $3 AND step_key = $4 AND label = $5`,
      identity,
    );
    if (prior) {
      if (prior.input_digest !== digest) throw new Error('Effect identity already used with different input');
      if (prior.state === 'done') return { kind: 'done', result: json.parse(prior.result) } as const;
      return { kind: 'unknown', providerEffectId: prior.provider_effect_id } as const;
    }

    const providerEffectId = newUlid();
    return tx.withLearnerWrite(async tick => {
      await tx.insert('effects', {
        learner_id: learner,
        owner_kind: ownerKind,
        owner_id: ownerId,
        step_key: stepKey,
        label,
        input_digest: digest,
        provider_effect_id: providerEffectId,
        state: 'started',
        started_tick: tick,
      });
      return { kind: 'invoke', providerEffectId, tick } as const;
    });
  });
  if (reservation.kind !== 'invoke') return reservation;

  let outcome: EffectResult;
  let encoded: string | null = null;
  try {
    const result = canonicalizeJson(await invoke(reservation.providerEffectId));
    encoded = JSON.stringify(result);
    outcome = { kind: 'done', result };
  } catch {
    outcome = { kind: 'unknown', providerEffectId: reservation.providerEffectId };
  }

  await db.tx({ learner }, tx => tx.withLearnerWrite(async tick => {
    const updated = await tx.query(
      `UPDATE effects SET state = $6, result = $7, ended_tick = $8
       WHERE learner_id = $1 AND owner_kind = $2 AND owner_id = $3 AND step_key = $4 AND label = $5
         AND state = 'started' AND started_tick = $9`,
      [...identity, outcome.kind, encoded, tick, reservation.tick],
    );
    if (updated.rowCount !== 1) throw new Error('Effect reservation no longer active');
  }));
  return outcome;
}
