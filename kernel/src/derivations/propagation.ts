import { canonicalJsonString } from '../commands/canonical.ts';
import type { CommandHooks, FactChange } from '../commands/contracts.ts';
import type { DbTransaction, ReadTransaction } from '../db/types.ts';
import type { SlotDefinition, Trigger } from '../declarations/define.ts';
import type { DerivationId, Tick } from '../declarations/ids.ts';
import type { JsonObject, SlotRef } from '../declarations/types.ts';
import { requestWork, type WorkRequest } from '../work/demand.ts';
import { wakeWaitingWork } from '../work/wait.ts';
import type { CandidateHooks, SlotChange } from './candidate.ts';
import { findManifestDependents, type ManifestChange, type ManifestDependent } from './manifest-dependents.ts';

export type FindDirectDependents = (
  tx: ReadTransaction,
  change: ManifestChange,
) => Promise<readonly ManifestDependent[]>;

type TriggerEvent =
  | { readonly kind: 'fact'; readonly change: FactChange }
  | { readonly kind: 'slot'; readonly slot: SlotRef; readonly currentId: DerivationId | null }
  | { readonly kind: 'always' };

type SlotTarget = {
  readonly key: string;
  readonly scopeKeys: JsonObject;
  readonly evidenceEligible: boolean;
};

export type SlotPropagationPolicy = {
  readonly slot: Pick<SlotDefinition, 'type' | 'policy' | 'triggers'>;
  readonly deriver: string;
  /** Resolve keys and catalog eligibility from declared inputs available in this transaction. */
  readonly targets: (tx: ReadTransaction, event: TriggerEvent) => readonly SlotTarget[] | Promise<readonly SlotTarget[]>;
};

type SlotAddress = Pick<WorkRequest, 'slotType' | 'slotKey'>;
type AffectedSlot = SlotAddress & { readonly needed: boolean };
type Stale = Extract<ManifestDependent, { effect: 'stale' }>;

const liveDerivation = `NOT d.is_shadow AND d.invalidated_tick IS NULL
  AND (d.lifecycle = 'candidate' OR (d.lifecycle IN ('effective', 'superseded') AND d.effective_tick IS NOT NULL))`;
const activeCandidate = `d.lifecycle = 'candidate' AND EXISTS (
  SELECT 1 FROM work w WHERE w.learner_id = d.learner_id AND w.slot_type = d.slot_type AND w.slot_key = d.slot_key
    AND w.state = 'ready' AND w.gather->>'id' = d.id
)`;
const address = 'd.slot_type AS "slotType", d.slot_key AS "slotKey"';
const slotIdentity = (type: string, key: string) => JSON.stringify([type, key]);

/** Invalidate a derivation and every live derivation that manifest-recursively depends on it. */
export async function invalidateDerivationTree(
  tx: DbTransaction,
  tick: Tick,
  initial: readonly DerivationId[],
  reason: string,
): Promise<void> {
  const error = JSON.stringify({ reason });
  const seen = new Set<string>();
  const queue = [...initial];
  while (queue.length) {
    const currentId = queue.shift()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const { rows: [stale] } = await tx.query<{ slotType: string; slotKey: string }>(
      `UPDATE derivations d SET lifecycle = 'stale', invalidated_tick = $3, error = $4
       WHERE d.learner_id = $1 AND d.id = $2 AND ${liveDerivation}
       RETURNING d.slot_type AS "slotType", d.slot_key AS "slotKey"`,
      [tx.learner, currentId, tick, error],
    );
    if (!stale) continue;
    await tx.query(
      `UPDATE slot_state SET current_id = NULL, changed_tick = $5, last_error = $6
       WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3 AND current_id = $4`,
      [tx.learner, stale.slotType, stale.slotKey, currentId, tick, error],
    );
    const dependents = await findManifestDependents(tx, { kind: 'derivation-invalidated', derivationId: currentId });
    for (const dependent of dependents) queue.push(dependent.derivationId);
  }
}

async function markStale(tx: DbTransaction, tick: Tick, dependent: Stale) {
  const error = JSON.stringify({ reason: dependent.reason });
  const { rows: [stale] } = await tx.query<AffectedSlot>(
    `WITH invalidated AS (
       SELECT d.id, (${activeCandidate}) AS needed FROM derivations d
       WHERE d.learner_id = $1 AND d.id = $2 AND ${liveDerivation}
     )
     UPDATE derivations d SET lifecycle = 'stale', invalidated_tick = $3, error = $4
     FROM invalidated WHERE d.learner_id = $1 AND d.id = invalidated.id
     RETURNING ${address}, invalidated.needed`,
    [tx.learner, dependent.derivationId, tick, error],
  );
  if (!stale) return null;
  const cleared = await tx.query(
    `UPDATE slot_state SET current_id = NULL, changed_tick = $5, last_error = $6
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3 AND current_id = $4`,
    [tx.learner, stale.slotType, stale.slotKey, dependent.derivationId, tick, error],
  );
  return { ...stale, clearedCurrent: cleared.rowCount === 1 };
}

async function markBehind(tx: DbTransaction, id: DerivationId) {
  const { rows: [behind] } = await tx.query<AffectedSlot>(
    `UPDATE derivations d SET freshness = 'behind'
     WHERE d.learner_id = $1 AND d.id = $2 AND ${liveDerivation} AND d.freshness = 'current'
     RETURNING ${address}, ((${activeCandidate}) OR EXISTS (
       SELECT 1 FROM slot_state s WHERE s.learner_id = d.learner_id AND s.slot_type = d.slot_type
         AND s.slot_key = d.slot_key AND s.current_id = d.id
     )) AS needed`,
    [tx.learner, id],
  );
  return behind;
}

async function preservesSealedWork(tx: ReadTransaction, { slotType, slotKey }: SlotAddress) {
  const result = await tx.query(
    `SELECT 1 FROM derivations d
     WHERE d.learner_id = $1 AND d.slot_type = $2 AND d.slot_key = $3
       AND d.freshness = 'behind' AND ${liveDerivation} AND ${activeCandidate}`,
    [tx.learner, slotType, slotKey],
  );
  return result.rows.length > 0;
}

function matchesTrigger(trigger: Trigger, event: TriggerEvent) {
  switch (trigger.kind) {
    case 'fact': return event.kind === 'fact' && trigger.factType === event.change.factType;
    case 'slot': return event.kind === 'slot' && trigger.slotType === event.slot.type;
    case 'always': return event.kind === 'always';
  }
}

type CatalogEntry = SlotAddress & { readonly scopeKeys: string; readonly evidenceEligible: boolean };

async function writeCatalog(tx: DbTransaction, tick: Tick, entry: CatalogEntry, published: SlotChange | undefined) {
  const key = [tx.learner, entry.slotType, entry.slotKey];
  const { rows: [existing] } = await tx.query<{
    current_id: string | null; same_scope: boolean; evidence_eligible: boolean;
  }>(
    `SELECT current_id, scope_keys = $4::jsonb AS same_scope, evidence_eligible FROM slot_state
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [...key, entry.scopeKeys],
  );
  if (!existing) {
    await tx.insert('slot_state', {
      learner_id: tx.learner, slot_type: entry.slotType, slot_key: entry.slotKey,
      scope_keys: entry.scopeKeys, evidence_eligible: entry.evidenceEligible, changed_tick: tick,
    });
    return true;
  }
  if (existing.same_scope && existing.evidence_eligible === entry.evidenceEligible) return false;

  // A scope/eligibility change must invalidate the old value through its recorded inputs.
  // At publication the new value may gain eligibility using its sealed scope.
  if (existing.current_id !== null && !(published?.kind === 'effective' && published.id === existing.current_id
      && existing.same_scope && entry.evidenceEligible)) {
    throw new Error(`Slot catalog changed with a live value: ${entry.slotType}/${entry.slotKey}`);
  }
  await tx.query(
    `UPDATE slot_state SET scope_keys = $4, evidence_eligible = $5, changed_tick = $6
     WHERE learner_id = $1 AND slot_type = $2 AND slot_key = $3`,
    [...key, entry.scopeKeys, entry.evidenceEligible, tick],
  );
  return true;
}

/** Connect the production command and candidate transaction hooks to one propagation closure. */
export function createPropagationHooks(
  policies: readonly SlotPropagationPolicy[],
  findDependents: FindDirectDependents = findManifestDependents,
): CommandHooks & Pick<CandidateHooks, 'onSlotChanged'> & {
  /** Explicit activation of `always` triggers in a learner write, e.g. at setup. */
  readonly onAlways: (tx: DbTransaction, tick: Tick) => Promise<void>;
} {
  const byType = new Map(policies.map(policy => [policy.slot.type, policy]));
  if (byType.size !== policies.length) throw new Error('Duplicate slot propagation policy');

  async function apply(tx: DbTransaction, tick: Tick, facts: readonly FactChange[], change?: SlotChange, always = false) {
    if ((change && change.slot.learner !== tx.learner) || facts.some(fact => fact.ref.learner !== tx.learner)) {
      throw new Error('Propagation input learner does not match transaction');
    }
    const frontier: ManifestChange[] = facts.filter(fact => fact.kind !== 'create')
      .map(fact => ({ kind: 'fact-changed', factId: fact.ref.id,
        ...(fact.scopedPurpose === undefined ? {} : {scopedPurpose: fact.scopedPurpose}) }));
    const events: TriggerEvent[] = facts.map(fact => ({ kind: 'fact', change: fact }));
    if (always) events.push({ kind: 'always' });
    if (change?.kind === 'effective' && change.previousCurrent) {
      frontier.push({ kind: 'slot-replaced', previousDerivationId: change.previousCurrent });
    } else if (change?.kind === 'rejected' || change?.kind === 'invalidated') {
      frontier.push({ kind: 'derivation-invalidated', derivationId: change.id });
    }

    const behind = new Set<DerivationId>();
    const invalidated = new Set<DerivationId>();
    const wake = new Map<string, SlotRef>();
    const demands = new Map<string, WorkRequest>();
    const catalog = new Map<string, CatalogEntry>();
    const demandEager = (slotType: string, slotKey: string) => {
      const policy = byType.get(slotType);
      if (policy?.slot.policy === 'eager') {
        demands.set(slotIdentity(slotType, slotKey), { slotType, slotKey, deriver: policy.deriver });
      }
    };

    for (const source of frontier) {
      for (const dependent of await findDependents(tx, source)) {
        if (dependent.effect === 'behind') {
          behind.add(dependent.derivationId);
          continue;
        }
        if (invalidated.has(dependent.derivationId)) continue;
        const stale = await markStale(tx, tick, dependent);
        if (!stale) continue;
        invalidated.add(dependent.derivationId);
        frontier.push({ kind: 'derivation-invalidated', derivationId: dependent.derivationId });
        const { slotType, slotKey } = stale;
        if (stale.needed || stale.clearedCurrent) demandEager(slotType, slotKey);
        if (stale.clearedCurrent) {
          const slot = { learner: tx.learner, type: slotType, key: slotKey };
          wake.set(slotIdentity(slotType, slotKey), slot);
          events.push({ kind: 'slot', slot, currentId: null });
        }
      }
    }

    if (change) wake.set(slotIdentity(change.slot.type, change.slot.key), change.slot);
    const published = change?.kind === 'effective' && !invalidated.has(change.id) ? change : undefined;
    if (published) events.push({ kind: 'slot', slot: published.slot, currentId: published.id });
    if (change && change.kind !== 'invalidated' && change.freshness === 'behind') {
      demandEager(change.slot.type, change.slot.key);
    }
    for (const event of events) {
      for (const policy of byType.values()) {
        if (!policy.slot.triggers.some(trigger => matchesTrigger(trigger, event))) continue;
        for (const target of await policy.targets(tx, event)) {
          const slotType = policy.slot.type;
          const identity = slotIdentity(slotType, target.key);
          const scopeKeys = canonicalJsonString(target.scopeKeys);
          const previous = catalog.get(identity);
          if (previous && (previous.scopeKeys !== scopeKeys || previous.evidenceEligible !== target.evidenceEligible)) {
            throw new Error(`Conflicting slot catalog projections: ${slotType}/${target.key}`);
          }
          catalog.set(identity, { slotType, slotKey: target.key, scopeKeys, evidenceEligible: target.evidenceEligible });
          const ownPublication = published?.slot.type === slotType && published.slot.key === target.key;
          if (!ownPublication) demandEager(slotType, target.key);
        }
      }
    }
    for (const [identity, entry] of catalog) {
      if (await writeCatalog(tx, tick, entry, published)) {
        wake.set(identity, { learner: tx.learner, type: entry.slotType, key: entry.slotKey });
      }
    }
    if (published) {
      for (const dependent of await findDependents(tx, { kind: 'derivation-published', derivationId: published.id })) {
        if (dependent.effect !== 'behind') throw new Error('A publication can only add range evidence');
        behind.add(dependent.derivationId);
      }
    }
    for (const id of behind) {
      const result = await markBehind(tx, id);
      if (result?.needed) demandEager(result.slotType, result.slotKey);
    }

    for (const work of demands.values()) {
      // Settling this sealed snapshot queues the catch-up if it is still behind.
      if (!await preservesSealedWork(tx, work)) await requestWork(tx, tick, work);
    }
    for (const slot of wake.values()) await wakeWaitingWork(tx, tick, slot);
  }

  return {
    onFactsChanged: (tx, tick, changes) => apply(tx, tick, changes),
    onSlotChanged: (tx, tick, change) => apply(tx, tick, [], change),
    onAlways: (tx, tick) => apply(tx, tick, [], undefined, true),
  };
}
