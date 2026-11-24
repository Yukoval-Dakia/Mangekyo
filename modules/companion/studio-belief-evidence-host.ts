import { createAuthorizedFactReader, factId, readable, type ReadTransaction } from '@mangekyo/kernel';
import { objectiveBeliefEvidence } from './belief.ts';
import { memoryAssertionType } from './memory-assertion.ts';
import { opensCitation, type ActivityCitation } from './understanding.ts';

export type StudioBeliefEvidenceDeps = Record<string, any>;

export function openObjectiveActivity(deps: StudioBeliefEvidenceDeps, tx: ReadTransaction, id: string, purpose: string, maySend: any) {
  return readable(async () => {
    const fact = await createAuthorizedFactReader(tx, purpose, maySend).fact(factId(id), { mode: 'following' });
    if ((fact.type !== deps.workbookAttemptType && fact.type !== deps.posttestSubmissionType) || !await deps.readActivitySubmissionBirth(tx, fact.ref, fact.type)) return;
    const evidence = objectiveBeliefEvidence(fact);
    return evidence?.fragments.length ? { ...evidence, fact, ref: deps.claimWitness(fact) } : undefined;
  });
}
export async function openObjectiveCitations(deps: StudioBeliefEvidenceDeps, tx: ReadTransaction, refs: readonly ActivityCitation[], purpose: string, maySend: any) {
  const sources = await Promise.all(refs.map(ref => openObjectiveActivity(deps, tx, ref.id, purpose, maySend)));
  return sources.filter((source, index): source is NonNullable<typeof source> => !!source && opensCitation(source, refs[index]!));
}
export function hypothesisIsHead(deps: StudioBeliefEvidenceDeps, tx: ReadTransaction, id: string, ownTurn?: string, except?: string) {
  return deps.areMemoryClaimsCurrent(tx, [id], ownTurn, except, true, memoryAssertionType);
}
