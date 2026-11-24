import type { ReadTransaction } from '../../kernel/src/index.ts';
import { readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { posttestSubmissionType } from '../../modules/activity/retention-posttest.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { areMemoryClaimsCurrent, claimWitness } from './memory-claims.ts';
import { openObjectiveActivity as _open, openObjectiveCitations as _openC, hypothesisIsHead as _head } from '../../modules/companion/studio-belief-evidence-host.ts';

export const openObjectiveActivity = (tx: ReadTransaction, id: string, purpose: string, maySend: any) =>
  _open({ areMemoryClaimsCurrent, claimWitness, readActivitySubmissionBirth, posttestSubmissionType, workbookAttemptType }, tx, id, purpose, maySend);
export const openObjectiveCitations = (tx: ReadTransaction, refs: readonly any[], purpose: string, maySend: any) =>
  _openC({ areMemoryClaimsCurrent, claimWitness, readActivitySubmissionBirth, posttestSubmissionType, workbookAttemptType }, tx, refs, purpose, maySend);
export const hypothesisIsHead = (tx: ReadTransaction, id: string, ownTurn?: string, except?: string) =>
  _head({ areMemoryClaimsCurrent, claimWitness, readActivitySubmissionBirth, posttestSubmissionType, workbookAttemptType }, tx, id, ownTurn, except);
