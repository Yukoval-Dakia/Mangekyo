import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { Manifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { memoryReceipt, saveBeliefCommand } from '../../modules/companion/belief.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { applyClaimCommand, claimType, claimValue, ClaimInputError, matchesClaimEvidence, type ClaimRef } from '../../modules/companion/claim.ts';
import { purpose, stableId } from './identity.ts';

export const claimUndoToken = (command: string, id: string) => stableId('memory-undo-token', command, id);

export const claimWitness = (fact: FactSnapshot): ClaimRef => ({
  id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
});

const activeSuccessor = (ignoreEntry = 'NULL') => `SELECT 1 FROM facts sf JOIN fact_revs sr
  ON (sr.learner_id,sr.fact_id,sr.rev)=(sf.learner_id,sf.id,sf.current_rev)
  WHERE sf.learner_id=f.learner_id AND sf.type=f.type AND sf.retracted_rev IS NULL
    AND COALESCE(sr.data#>>'{supersedes,id}', sr.data#>>'{belief,supersedes,id}')=f.id
    AND (sr.data->>'version'='1' OR sr.data ? 'belief') AND sf.id IS DISTINCT FROM ${ignoreEntry}
    AND ($3::text IS NULL OR COALESCE(sr.data#>>'{belief,turn}', sr.data#>>'{evidence_refs,0,id}') IS DISTINCT FROM $3)`;

export async function currentMemoryClaims(tx: ReadTransaction, options: {
  ownTurn?: string | undefined; management?: boolean; query?: string; before?: string; learner?: boolean; type?: string;
}) {
  const {ownTurn, management, query, before, learner, type = claimType} = options;
  const {rows} = await tx.query<{id: ClaimRef['id']; tick: string}>(`
    SELECT f.id,f.created_tick::text AS tick FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND ($2='companion.claim' OR r.data ? 'belief')
      AND ($3::text IS NULL OR COALESCE(r.data#>>'{belief,turn}', r.data#>>'{evidence_refs,0,id}') IS DISTINCT FROM $3)
      AND NOT EXISTS (${activeSuccessor()})
      AND ($4::text IS NULL OR position(lower($4) in lower(COALESCE(r.data->>'text',r.data->>'quote','')))>0)
      AND ($5::text IS NULL OR f.id<$5)
      AND ($6::boolean OR (r.data->>'action' IS DISTINCT FROM 'forget' AND r.data#>>'{belief,forgotten}' IS DISTINCT FROM 'true' AND (f.purpose && ARRAY['teaching','all'])))
    ORDER BY CASE WHEN $6 THEN 0 ELSE f.created_tick END DESC,f.id DESC LIMIT $7`,
    [tx.learner, type, ownTurn ?? null, query ?? null, before ?? null, Boolean(learner), learner || management ? 51 : 24]);
  return rows;
}

export async function areMemoryClaimsCurrent(tx: ReadTransaction, ids: readonly string[], ownTurn?: string, ignoreEntry?: string, allowRetracted = false, type = claimType) {
  if (!ids.length) return true;
  const {rowCount} = await tx.query(`SELECT 1 FROM facts f
    WHERE f.learner_id=$1 AND f.type=$2 AND ($6::boolean OR f.retracted_rev IS NULL) AND f.id=ANY($4::text[])
      AND NOT EXISTS (${activeSuccessor('$5::text')})`, [tx.learner, type, ownTurn ?? null, ids, ignoreEntry ?? null, allowRetracted]);
  return rowCount === ids.length;
}

export async function teachingMemoryBasis(tx: ReadTransaction, manifest: Manifest, turn: string) {
  if ((await revalidateManifest(tx, manifest)).kind !== 'valid') return;
  const ids = manifest.inputs.flatMap(input => input.kind === 'fact' ? [input.id] : []);
  const {rows} = await tx.query<{id: string; superseded: boolean}>(`SELECT f.id, EXISTS (${activeSuccessor()}) AS superseded
    FROM facts f WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND f.id=ANY($4::text[])`,
  [tx.learner, [claimType, memoryAssertionType], turn, ids]);
  return rows.some(row => row.superseded) ? undefined : new Set(rows.map(row => row.id));
}

export const turnMemoryKey = (turn: string, belief: boolean) => stableId(belief ? 'turn-belief-command' : 'turn-memory-command', turn);

export async function recoverTurnMemoryReceipts(tx: ReadTransaction, turns: string[]) {
  if (!turns.length) return new Map<string, ReturnType<typeof memoryReceipt>[]>();
  const keys = turns.flatMap(turn => [false, true].map(mode => ({turn, key: turnMemoryKey(turn, mode),
    type: mode ? saveBeliefCommand : applyClaimCommand})));
  const {rows} = await tx.query<{turn: string; command: string; id: string; rev: number; action: Parameters<typeof memoryReceipt>[2]}>(`
    SELECT k.turn,c.id AS command,r.fact_id AS id,r.rev,CASE WHEN f.type=$3 THEN r.data->>'action'
      WHEN r.data#>>'{belief,forgotten}'='true' THEN 'forget'
      WHEN r.data#>>'{belief,supersedes,id}' IS NOT NULL THEN 'correct' ELSE 'remember' END AS action
    FROM jsonb_to_recordset($2::jsonb) AS k(turn text,key text,type text)
    JOIN commands c ON c.learner_id=$1 AND c.id=k.key AND c.type=k.type AND c.state='done'
    JOIN fact_revs r ON r.learner_id=c.learner_id AND r.command_id=c.id AND r.rev=1 AND r.author='companion'
    JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
    WHERE c.input->>'actor'='companion' AND c.input->>'purpose'=$5
      AND (c.type<>$6 OR c.input#>>'{input,turn}'=k.turn)
      AND ((f.type=$3 AND r.data->>'version'='1' AND r.data#>>'{evidence_refs,0,id}'=k.turn)
        OR (f.type=$4 AND c.type=$6 AND r.data->>'version'='2' AND r.data#>>'{belief,turn}'=k.turn))
    ORDER BY k.turn,c.id,r.tick,r.fact_id`, [tx.learner, JSON.stringify(keys), claimType, memoryAssertionType, purpose, saveBeliefCommand]);
  return new Map([...Map.groupBy(rows, row => row.turn)].map(([turn, group]) => [turn,
    group.map(({id, rev, action, command}) => ({...memoryReceipt(id, rev, action, claimUndoToken(command, id)), title: '记忆回执'}))]));
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

export async function managedClaimEvidence(tx: ReadTransaction, claim: ReturnType<typeof readClaimValue>) {
  if (!claim) return 'unknown';
  if (claim.version === 0) {
    if (!claim.source) return 'unknown';
    return await openClaimEvidence(tx, claim.source, claim.quote, 0, true) ? 'current' : 'unavailable';
  }
  if (claim.scope.kind === 'object') {
    for (const ref of claim.scope.basis) {
      const object = await openClaimFact(tx, ref.id);
      if (object?.ref.rev !== ref.rev || object.accessEpoch !== ref.accessEpoch) return 'unavailable';
    }
  }
  for (const ref of claim.evidence_refs) {
    if (!await openClaimEvidence(tx, ref, ref.excerpt, ref.start)) return 'unavailable';
  }
  return claim.evidence_refs.length ? 'current' : 'unknown';
}
