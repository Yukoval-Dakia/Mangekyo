import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { claimType, claimValue, ClaimInputError, matchesClaimEvidence, type ClaimRef } from '../../modules/companion/claim.ts';
import { purpose, stableId } from './identity.ts';

export const claimUndoToken = (command: string, id: string) => stableId('memory-undo-token', command, id);

export const claimWitness = (fact: FactSnapshot): ClaimRef => ({
  id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
});

const activeSuccessor = (ignoreEntry = 'NULL') => `SELECT 1 FROM facts sf JOIN fact_revs sr
  ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
  WHERE sf.learner_id=f.learner_id AND sf.type=f.type AND sf.retracted_rev IS NULL
    AND sr.data->'supersedes'->>'id'=f.id
    AND sr.data->>'version'='1' AND sf.id IS DISTINCT FROM ${ignoreEntry}
    AND ($3::text IS NULL OR sr.data#>>'{evidence_refs,0,id}' IS DISTINCT FROM $3)`;

export async function currentMemoryClaims(tx: ReadTransaction, options: {
  ownTurn?: string | undefined; management?: boolean; query?: string; before?: string; learner?: boolean;
}) {
  const {ownTurn, management, query, before, learner} = options;
  const {rows} = await tx.query<{id: ClaimRef['id']; tick: string}>(`
    SELECT f.id,f.created_tick::text AS tick FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND ($3::text IS NULL OR r.data#>>'{evidence_refs,0,id}' IS DISTINCT FROM $3)
      AND NOT EXISTS (${activeSuccessor()})
      AND ($4::text IS NULL OR position(lower($4) in lower(COALESCE(r.data->>'text',r.data->>'quote','')))>0)
      AND ($5::text IS NULL OR f.id<$5)
      AND ($6::boolean OR (r.data->>'action' IS DISTINCT FROM 'forget' AND (f.purpose && ARRAY['teaching','all'])))
    ORDER BY CASE WHEN $6 THEN 0 ELSE f.created_tick END DESC,f.id DESC LIMIT $7`,
    [tx.learner, claimType, ownTurn ?? null, query ?? null, before ?? null, Boolean(learner), learner || management ? 51 : 24]);
  return rows;
}

export async function areMemoryClaimsCurrent(tx: ReadTransaction, ids: readonly string[], ownTurn?: string, ignoreEntry?: string, allowRetracted = false) {
  if (!ids.length) return true;
  const {rowCount} = await tx.query(`SELECT 1 FROM facts f
    WHERE f.learner_id=$1 AND f.type=$2 AND ($6::boolean OR f.retracted_rev IS NULL) AND f.id=ANY($4::text[])
      AND NOT EXISTS (${activeSuccessor('$5::text')})`, [tx.learner, claimType, ownTurn ?? null, ids, ignoreEntry ?? null, allowRetracted]);
  return rowCount === ids.length;
}

export async function openClaimFact(tx: ReadTransaction, id: ClaimRef['id'], callerPurpose = purpose) {
  try {
    return await createCommandReadContext(tx, callerPurpose).fact(id, {mode:'following'});
  } catch (error) {
    if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError)) throw error;
    return undefined;
  }
}

export async function openClaimEvidence(tx: ReadTransaction, ref: ClaimRef, excerpt: string, start = 0, legacy = false) {
  const fact = await openClaimFact(tx, ref.id);
  if (!fact || !matchesClaimEvidence(fact, ref, excerpt, start, legacy)) return;
  const {rows: [source]} = await tx.query<{author: string}>(`
    SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3`, [tx.learner, ref.id, ref.rev]);
  return source?.author === 'learner' ? fact : undefined;
}

export function readClaimValue(value: unknown) {
  try { return claimValue(value); } catch (error) {
    if (!(error instanceof ClaimInputError)) throw error;
    return undefined;
  }
}
