import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { objectiveBeliefEvidence } from '../../modules/companion/belief.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import { opensCitation, type ActivityCitation } from '../../modules/companion/understanding.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { posttestSubmissionType } from '../../modules/activity/retention-posttest.ts';
import { readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { areMemoryClaimsCurrent, claimWitness } from './memory-claims.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

export async function openObjectiveActivity(tx: ReadTransaction, id: string, purpose: string, maySend: WorkspaceSourceRecipient) {
  try {
    const fact = await createAuthorizedFactReader(tx, purpose, maySend).fact(factId(id), {mode:'following'});
    if (fact.type !== workbookAttemptType && fact.type !== posttestSubmissionType) return;
    if (!await readActivitySubmissionBirth(tx, fact.ref, fact.type)) return;
    const evidence = objectiveBeliefEvidence(fact);
    return evidence?.fragments.length ? {...evidence, fact, ref: claimWitness(fact)} : undefined;
  } catch (error) {
    if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    return;
  }
}

export async function openObjectiveCitations(tx: ReadTransaction, refs: readonly ActivityCitation[], purpose: string,
  maySend: WorkspaceSourceRecipient) {
  const sources = await Promise.all(refs.map(ref => openObjectiveActivity(tx, ref.id, purpose, maySend)));
  return sources.filter((source, index): source is NonNullable<typeof source> => !!source && opensCitation(source, refs[index]!));
}

export const hypothesisIsHead = (tx: ReadTransaction, id: string, ownTurn?: string, except?: string) =>
  areMemoryClaimsCurrent(tx, [id], ownTurn, except, true, memoryAssertionType);
