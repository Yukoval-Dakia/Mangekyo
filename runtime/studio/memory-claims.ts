import { isDeepStrictEqual } from 'node:util';
import { manifestFactInputs } from '../../kernel/src/derivations/revalidate.ts';
import {
  createCommandReadContext, readAvailable, readFactOrigin, revalidateManifest,
  type FactSnapshot, type Manifest, type ReadTransaction,
} from '../../kernel/src/index.ts';
import { readLocalReceiptBases } from '../../kernel/src/work/local-read-basis.ts';
import type { StudyObjectWitness } from '../../modules/activity/current-object-basis.ts';
import { saveBeliefCommand, type memoryReceipt } from '../../modules/companion/belief.ts';
import { claimType, matchesClaimEvidence, type ClaimRef } from '../../modules/companion/claim.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import { activeClaimSuccessorSql, checkMemoryClaimsCurrent, parseStoredClaim, queryCurrentMemoryClaims } from '../../modules/companion/memory-overview.ts';
import { buildTurnMemoryLookupKeys, groupRecoveredTurnReceipts } from '../../modules/companion/memory-slice.ts';
import { extractedUnderstanding } from '../../modules/companion/understanding.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import { purpose, slotType, stableId } from './identity.ts';
import { readRadarTodo } from './research-understanding.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

export function claimUndoToken(command: string, id: string) { return stableId('memory-undo-token', command, id); }
export function claimWitness(fact: FactSnapshot): ClaimRef { return { id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch }; }
export function turnMemoryKey(turn: string, belief: boolean) { return stableId(belief ? 'turn-belief-command' : 'turn-memory-command', turn); }
export const currentMemoryClaims = queryCurrentMemoryClaims, areMemoryClaimsCurrent = checkMemoryClaimsCurrent, readClaimValue = parseStoredClaim;

export async function teachingMemoryBasis(tx: ReadTransaction, manifest: Manifest, turn: string, maySend: WorkspaceSourceRecipient = () => true) {
  if ((await revalidateManifest(tx, manifest)).kind !== 'valid') return;
  const turns = new Set([turn]), facts = await manifestFactInputs(tx, manifest.inputs, (type, key) => { if (type === slotType) turns.add(key); });
  type TodoBasis = NonNullable<Awaited<ReturnType<typeof readRadarTodo>>>['basis'];
  const receipts = await readLocalReceiptBases<TodoBasis>(tx, [...turns], 'local:read_learner_radar', 'todoBasis');
  for (const basis of receipts) if (!basis?.id || !isDeepStrictEqual(basis, (await readRadarTodo(tx, maySend, basis.id))?.basis)) return;
  const { rows } = await tx.query<{ id: string; superseded: boolean; hypothesis: unknown }>(`SELECT f.id, EXISTS (${activeClaimSuccessorSql()}) AS superseded,
    CASE WHEN r.data ? 'belief' AND r.data#>>'{scope,kind}'='object' THEN r.data END AS hypothesis
    FROM (SELECT DISTINCT * FROM unnest($4::text[], $5::int[]) AS input(id,rev)) input
    JOIN facts f ON f.learner_id=$1 AND f.id=input.id AND f.type=ANY($2::text[]) JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,input.rev)`,
    [tx.learner, [claimType, memoryAssertionType], turn, facts.map(f => f.id), facts.map(f => f.rev)]);
  if (rows.some(row => row.superseded)) return;
  const objects: StudyObjectWitness[] = [];
  for (const { hypothesis } of rows) {
    if (!hypothesis) continue;
    const basis = await openHypothesisObject(tx, extractedUnderstanding(hypothesis), maySend);
    if (!basis) return;
    objects.push(...basis);
  }
  return { ids: new Set(rows.map(row => row.id)), objects, usesRadarTodo: receipts.length > 0 };
}

export async function recoverTurnMemoryReceipts(tx: ReadTransaction, turns: string[]) {
  if (!turns.length) return new Map<string, ReturnType<typeof memoryReceipt>[]>();
  const { rows } = await tx.query<{ turn: string; command: string; id: string; rev: number; action: Parameters<typeof memoryReceipt>[2] }>(`
    SELECT k.turn,c.id AS command,r.fact_id AS id,r.rev,CASE WHEN f.type=$3 THEN r.data->>'action' WHEN r.data#>>'{belief,forgotten}'='true' THEN 'forget'
      WHEN r.data#>>'{belief,supersedes,id}' IS NOT NULL THEN 'correct' ELSE 'remember' END AS action
    FROM jsonb_to_recordset($2::jsonb) AS k(turn text,key text,type text)
    JOIN commands c ON c.learner_id=$1 AND c.id=k.key AND c.type=k.type AND c.state='done'
    JOIN fact_revs r ON r.learner_id=c.learner_id AND r.command_id=c.id AND r.rev=1 AND r.author='companion' JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
    WHERE c.input->>'actor'='companion' AND c.input->>'purpose'=$5 AND (c.type<>$6 OR c.input#>>'{input,turn}'=k.turn)
      AND ((f.type=$3 AND r.data->>'version'='1' AND r.data#>>'{evidence_refs,0,id}'=k.turn)
        OR (f.type=$4 AND c.type=$6 AND r.data->>'version'='2' AND r.data#>>'{belief,turn}'=k.turn))
    ORDER BY k.turn,c.id,r.tick,r.fact_id`, [tx.learner, JSON.stringify(buildTurnMemoryLookupKeys(turns, turnMemoryKey)), claimType, memoryAssertionType, purpose, saveBeliefCommand]);
  return groupRecoveredTurnReceipts(rows, claimUndoToken);
}

export const openClaimFact = (tx: ReadTransaction, id: ClaimRef['id'], callerPurpose = purpose) =>
  readAvailable(() => createCommandReadContext(tx, callerPurpose).fact(id, { mode: 'following' }));
export async function openClaimEvidence(tx: ReadTransaction, ref: ClaimRef, excerpt: string, start = 0, legacy = false) {
  const fact = await openClaimFact(tx, ref.id);
  if (!fact || !matchesClaimEvidence(fact, ref, excerpt, start, legacy)) return;
  return (await readFactOrigin(tx, ref.id, ref.rev))?.author === 'learner' ? fact : undefined;
}
export async function managedClaimEvidence(tx: ReadTransaction, claim: ReturnType<typeof readClaimValue>) {
  if (!claim) return 'unknown';
  if (claim.version === 0) return claim.source ? (await openClaimEvidence(tx, claim.source, claim.quote, 0, true) ? 'current' : 'unavailable') : 'unknown';
  if (claim.scope.kind === 'object') {
    for (const ref of claim.scope.basis) {
      const object = await openClaimFact(tx, ref.id);
      if (object?.ref.rev !== ref.rev || object.accessEpoch !== ref.accessEpoch) return 'unavailable';
    }
  }
  for (const ref of claim.evidence_refs) if (!await openClaimEvidence(tx, ref, ref.excerpt, ref.start)) return 'unavailable';
  return claim.evidence_refs.length ? 'current' : 'unknown';
}
