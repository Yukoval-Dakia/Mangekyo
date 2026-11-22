import type { StudyObjectWitness } from '../../modules/activity/current-object-basis.ts';
import { extractedUnderstanding } from '../../modules/companion/understanding.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { isFactUnavailable, readFactOrNull } from './fact-read-helpers.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { Manifest } from '../../kernel/src/derivations/manifest.ts';
import { manifestFactInputs, revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { memoryReceipt, saveBeliefCommand } from '../../modules/companion/belief.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { applyClaimCommand, claimType, matchesClaimEvidence, type ClaimRef } from '../../modules/companion/claim.ts';
import { activeClaimSuccessorSql, checkMemoryClaimsCurrent, parseStoredClaim, queryCurrentMemoryClaims } from '../../modules/companion/memory-overview.ts';
import { purpose, slotType, stableId } from './identity.ts';
import { readRadarTodo } from './research-understanding.ts';
import { isDeepStrictEqual } from 'node:util';
import { readLocalReceiptBases } from '../../kernel/src/work/local-read-basis.ts';

export const claimUndoToken = (command: string, id: string) => stableId('memory-undo-token', command, id);

export const claimWitness = (fact: FactSnapshot): ClaimRef => ({
  id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch,
});

export const currentMemoryClaims = queryCurrentMemoryClaims;
export const areMemoryClaimsCurrent = checkMemoryClaimsCurrent;

export async function teachingMemoryBasis(tx: ReadTransaction, manifest: Manifest, turn: string, maySend: WorkspaceSourceRecipient = () => true) {
  if ((await revalidateManifest(tx, manifest)).kind !== 'valid') return;
  const turns = new Set([turn]);
  const facts = await manifestFactInputs(tx, manifest.inputs, (type, key) => { if (type === slotType) turns.add(key); });
  type TodoBasis = NonNullable<Awaited<ReturnType<typeof readRadarTodo>>>['basis'];
  const receipts = await readLocalReceiptBases<TodoBasis>(tx, [...turns], 'local:read_learner_radar', 'todoBasis');
  for (const basis of receipts)
    if (!basis?.id || !isDeepStrictEqual(basis, (await readRadarTodo(tx, maySend, basis.id))?.basis)) return;
  const {rows} = await tx.query<{id: string; superseded: boolean; hypothesis: unknown}>(`SELECT f.id, EXISTS (${activeClaimSuccessorSql()}) AS superseded,
    CASE WHEN r.data ? 'belief' AND r.data#>>'{scope,kind}'='object' THEN r.data END AS hypothesis
    FROM (SELECT DISTINCT * FROM unnest($4::text[], $5::int[]) AS input(id,rev)) input
    JOIN facts f ON f.learner_id=$1 AND f.id=input.id AND f.type=ANY($2::text[])
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,input.rev)`,
  [tx.learner, [claimType, memoryAssertionType], turn, facts.map(f => f.id), facts.map(f => f.rev)]);
  if (rows.some(row => row.superseded)) return;
  const objects: StudyObjectWitness[] = [];
  for (const {hypothesis} of rows) {
    if (!hypothesis) continue;
    const basis = await openHypothesisObject(tx, extractedUnderstanding(hypothesis), maySend);
    if (!basis) return;
    objects.push(...basis);
  }
  return {ids:new Set(rows.map(row => row.id)), objects, usesRadarTodo: receipts.length > 0};
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
  return readFactOrNull(tx, callerPurpose, id, {mode:'following'});
}

export async function openClaimEvidence(tx: ReadTransaction, ref: ClaimRef, excerpt: string, start = 0, legacy = false) {
  const fact = await openClaimFact(tx, ref.id);
  if (!fact || !matchesClaimEvidence(fact, ref, excerpt, start, legacy)) return;
  const {rows: [source]} = await tx.query<{author: string}>(`
    SELECT author FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=$3`, [tx.learner, ref.id, ref.rev]);
  return source?.author === 'learner' ? fact : undefined;
}

export const readClaimValue = parseStoredClaim;

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
