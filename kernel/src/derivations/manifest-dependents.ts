import type { ReadTransaction } from '../db/types.ts';
import type { DerivationId, FactId } from '../declarations/ids.ts';

export type ManifestChange =
  | { readonly kind: 'fact-changed'; readonly factId: FactId }
  | { readonly kind: 'slot-replaced'; readonly previousDerivationId: DerivationId }
  | { readonly kind: 'derivation-invalidated'; readonly derivationId: DerivationId }
  | { readonly kind: 'derivation-published'; readonly derivationId: DerivationId };

export type ManifestDependent = { readonly derivationId: DerivationId } & (
  | {
    readonly effect: 'stale';
    readonly reason: 'fact-revision-changed' | 'fact-access-changed' | 'following-slot-replaced'
      | 'slot-derivation-invalidated' | 'range-member-invalidated';
  }
  | {
    readonly effect: 'behind';
    readonly reason: 'asof-slot-replaced' | 'range-member-replaced' | 'range-member-added';
  }
);

const dependents = `
  SELECT id, manifest
  FROM derivations
  WHERE learner_id = $1
    AND manifest @> jsonb_build_object('learner', $1::text)
    AND NOT is_shadow
    AND invalidated_tick IS NULL
    AND (
      lifecycle = 'candidate'
      OR (lifecycle IN ('effective', 'superseded') AND effective_tick IS NOT NULL)
    )
`;

const factDependents = `
  WITH dependents AS (${dependents}),
  changed_fact AS (
    SELECT current_rev, access_epoch, retracted_rev, jsonb_build_object('kind', 'fact', 'id', id) AS ref
    FROM facts
    WHERE learner_id = $1 AND id = $2
  )
  SELECT DISTINCT dependent.id AS "derivationId", 'stale' AS effect,
    CASE WHEN fact_access.changed THEN 'fact-access-changed' ELSE 'fact-revision-changed' END AS reason
  FROM changed_fact AS fact
  JOIN dependents AS dependent
    ON dependent.manifest @> jsonb_build_object('inputs', jsonb_build_array(fact.ref))
  CROSS JOIN LATERAL jsonb_array_elements(dependent.manifest->'inputs') AS entry(input)
  CROSS JOIN LATERAL (VALUES (
    fact.retracted_rev IS NOT NULL OR entry.input->>'accessEpoch' <> fact.access_epoch::text
  )) AS fact_access(changed)
  WHERE entry.input @> fact.ref
    AND (
      fact_access.changed
      OR (entry.input->>'mode' = 'following' AND entry.input->'rev' <> to_jsonb(fact.current_rev))
    )
  ORDER BY dependent.id, reason
`;

const derivationDependents = `
  WITH dependents AS (${dependents}),
  source AS (
    SELECT
      jsonb_build_object('kind', 'slot', 'slotType', slot_type, 'slotKey', slot_key, 'derivationId', id) AS slot_input,
      jsonb_build_object('kind', 'range', 'slotType', slot_type, 'members', jsonb_build_array(
        jsonb_build_object('slotKey', slot_key, 'derivationId', id)
      )) AS range_input
    FROM derivations
    WHERE learner_id = $1 AND id = $2 AND NOT is_shadow
  )
  SELECT dependent.id AS "derivationId", hit.effect, hit.reason
  FROM source
  CROSS JOIN LATERAL (VALUES
    ('slot-replaced', 'stale', 'following-slot-replaced', source.slot_input || '{"mode":"following"}'::jsonb),
    ('slot-replaced', 'behind', 'asof-slot-replaced', source.slot_input || '{"mode":"asof"}'::jsonb),
    ('slot-replaced', 'behind', 'range-member-replaced', source.range_input),
    ('derivation-invalidated', 'stale', 'slot-derivation-invalidated', source.slot_input),
    ('derivation-invalidated', 'stale', 'range-member-invalidated', source.range_input)
  ) AS hit(change_kind, effect, reason, input)
  JOIN dependents AS dependent
    ON dependent.manifest @> jsonb_build_object('inputs', jsonb_build_array(hit.input))
  WHERE hit.change_kind = $3
  ORDER BY dependent.id, hit.reason
`;

const rangeSubscribers = `
  WITH dependents AS (${dependents}),
  published AS (
    SELECT
      source.effective_tick, source.scope_keys,
      jsonb_build_object('kind', 'range', 'slotType', source.slot_type) AS ref,
      jsonb_build_array(jsonb_build_object('slotKey', source.slot_key, 'derivationId', source.id)) AS member
    FROM derivations AS source
    JOIN slot_state AS slot
      ON slot.learner_id = source.learner_id AND slot.slot_type = source.slot_type
      AND slot.slot_key = source.slot_key AND slot.current_id = source.id
    WHERE source.learner_id = $1 AND source.id = $2
      AND source.lifecycle = 'effective' AND source.invalidated_tick IS NULL AND NOT source.is_shadow
      AND slot.evidence_eligible
  )
  SELECT DISTINCT dependent.id AS "derivationId", 'behind' AS effect, 'range-member-added' AS reason
  FROM published
  JOIN dependents AS dependent
    ON dependent.manifest @> jsonb_build_object('inputs', jsonb_build_array(published.ref))
  CROSS JOIN LATERAL jsonb_array_elements(dependent.manifest->'inputs') AS entry(input)
  WHERE entry.input @> published.ref
    AND published.scope_keys @> (entry.input->'scope')
    AND (entry.input->>'watermark')::bigint < published.effective_tick
    AND NOT ((entry.input->'members') @> published.member)
  ORDER BY dependent.id
`;

export async function findManifestDependents(
  tx: ReadTransaction,
  change: ManifestChange,
): Promise<readonly ManifestDependent[]> {
  switch (change.kind) {
    case 'fact-changed':
      return (await tx.query<ManifestDependent>(factDependents, [tx.learner, change.factId])).rows;
    case 'slot-replaced':
      return (await tx.query<ManifestDependent>(
        derivationDependents,
        [tx.learner, change.previousDerivationId, change.kind],
      )).rows;
    case 'derivation-invalidated':
      return (await tx.query<ManifestDependent>(derivationDependents, [tx.learner, change.derivationId, change.kind])).rows;
    case 'derivation-published':
      return (await tx.query<ManifestDependent>(rangeSubscribers, [tx.learner, change.derivationId])).rows;
  }
}
