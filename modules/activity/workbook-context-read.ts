import type { FactId, FactSnapshot, ReadContext, Revision } from '@mangekyo/kernel';
import { readActivitySubmissionBirth, type ActivityEvidenceReadScope } from './evidence-read.ts';
import { sameHelpRef, type HelpRef } from './help-exposure-values.ts';
import { recordWorkbookPresentationCommand, workbookPresentation, workbookPresentationType } from './workbook-presentation.ts';
import { verifyWorkspaceEntryBasis, workspaceEntry, workspaceEntryType } from './workspace-values.ts';
import { sameWorkbookJson, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType } from './workbook-values.ts';

export const localWorkbookCapsuleKinds = ['archetype','backtrace'] as const;
export const workbookCapsuleKinds = [...localWorkbookCapsuleKinds,'notion'] as const;

type ReadFact = (...args: Parameters<ReadContext['fact']>) => Promise<FactSnapshot>;

/** The caller owns the lifetime and fixes the authorization for these reads. */
export function memoWorkbookRead<Args extends unknown[], Value>(read: (...args: Args) => Promise<Value>) {
  const reads = new Map<string,Promise<Value>>();
  return (...args: Args) => {
    const key = JSON.stringify(args);
    const existing = reads.get(key);
    if (existing) return existing;
    const result = read(...args);
    reads.set(key,result);
    return result;
  };
}

export function memoWorkbookFacts(read: ReadFact): Pick<ReadContext,'fact'> {
  const fact = memoWorkbookRead(read);
  return {fact: <Value>(...args: Parameters<ReadFact>) => fact(...args) as Promise<FactSnapshot<Value>>};
}

export function withWorkbookWorkspaceBasis(read: Pick<ReadContext,'fact'>) {
  return memoWorkbookFacts(async (id,options) => {
    const fact = await read.fact(id,options);
    if (fact.type === workspaceEntryType) await verifyWorkspaceEntryBasis(read,id,workspaceEntry(fact.value).basis);
    return fact;
  });
}

export type BoundWorkbookMount = {paper: HelpRef; attemptRef?: HelpRef; epoch: string; attemptEpoch?: string; issuance?: HelpRef};

export async function historicalWorkbookMount(tx: ActivityEvidenceReadScope, paperId: FactId, submission: FactSnapshot, read: ReadContext, unavailable: (error: unknown) => boolean): Promise<BoundWorkbookMount | null> {
  const attempt = workbookAttempt(submission.value);
  const birth = await readActivitySubmissionBirth(tx, submission.ref, workbookAttemptType);
  if (!birth?.unchanged || attempt.paperId !== paperId) return null;
  let rev = attempt.paperRev ?? attempt.paper.assessmentRelease?.releaseRef.rev;
  if (rev === undefined) {
    const {rows: [row]} = await tx.query<{rev: Revision}>(
      "SELECT rev FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND kind='value' AND tick<$3 ORDER BY tick DESC LIMIT 1",
      [tx.learner, paperId, birth.tick]);
    rev = row?.rev;
  }
  if (!rev) return null;
  const fact = await read.fact(paperId,{mode:'pinned',rev}).catch(error => {
    if (!unavailable(error)) throw error;
  });
  if (!fact) return null;
  if (fact.type !== workbookPaperType || !sameWorkbookJson(workbookPaper(fact.value), attempt.paper)) return null;
  return {paper:{id:paperId,rev}, epoch:fact.accessEpoch, attemptRef:{id:submission.ref.id,rev:submission.ref.rev}, attemptEpoch:submission.accessEpoch};
}

export async function workbookCapsuleLinkCandidates(tx: ActivityEvidenceReadScope, question: HelpRef, edgeType: string, purpose: string) {
  const {rows} = await tx.query<{id: FactId}>(
    `WITH visible AS (
      SELECT f.id, r.data FROM facts f JOIN fact_revs r ON (f.learner_id,f.id,f.current_rev)=(r.learner_id,r.fact_id,r.rev)
      WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
        AND f.purpose && ARRAY[$3,'all']::text[] AND r.purpose && ARRAY[$3,'all']::text[]
    ), direct AS (
      SELECT id,data FROM visible WHERE data#>'{from,sourceUse}' @> $4::jsonb
      AND data->>'kind' IN ('targets_concept','instance_of')
    ), explanations AS (
      SELECT d.id AS bridge,n.id AS note FROM visible n JOIN direct d
        ON n.data#>'{to,sourceUse}'=d.data#>'{to,sourceUse}'
        WHERE n.data->>'kind'='explains' AND d.data->>'kind'='targets_concept'
          AND n.data#>>'{from,kind}'='note' AND n.data#>>'{from,blockId}' IS NOT NULL
          AND n.data#>>'{to,kind}'='concept' AND n.data#>>'{to,blockId}' IS NULL
    )
    SELECT id FROM direct WHERE data->>'kind'='instance_of' OR EXISTS (SELECT FROM explanations WHERE bridge=direct.id)
    UNION ALL SELECT note FROM explanations LIMIT 129`,
    [tx.learner,edgeType,purpose,JSON.stringify(question)]);
  return rows.length > 128 ? [] : [...new Set(rows.map(({id})=>id))];
}

export async function verifyWorkbookQuestionPermit(tx: ActivityEvidenceReadScope, read: ReadContext,
  id: FactId, mount: BoundWorkbookMount, itemId: string) {
  if (mount.issuance) return id === mount.issuance.id;
  const permit = await read.fact(id,{mode:'pinned',rev:1 as Revision});
  if (permit.type !== workbookPresentationType) return false;
  const data = workbookPresentation(permit.value);
  if (data.kind !== 'question' || data.phase !== 'permit' || !sameHelpRef(data.paper,mount.paper) ||
      !data.items.includes(itemId) || !sameWorkbookJson(data.attemptRef ?? null,mount.attemptRef ?? null)) return false;
  const {rows:[row]} = await tx.query<{valid: boolean}>(
    `SELECT true AS valid FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
      WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.author='learner' AND r.kind='value'
        AND c.type=$3 AND c.state='done'`,[tx.learner,id,recordWorkbookPresentationCommand]);
  return row?.valid === true;
}
