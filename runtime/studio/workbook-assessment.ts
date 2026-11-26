import { createHash } from 'node:crypto';
import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import {
  createAuthorizedFactReader, createPropagationHooks, isFactNotFound, isFactReadDenied, lockLearner, markSlotFailed,
  readSlotStatus, revalidateManifest, type CommandHooks, type Db, type FactId, type FactSnapshot, type ReadTransaction, type Tick,
} from '../../kernel/src/index.ts';
import { failWork, readReadyWork, readWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import type { AssessmentRelease, AssessmentRevisionRef } from '../../modules/activity/assessment-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  afterWorkbookAssessmentFactsChanged, executeWorkbookAssessment, prepareWorkbookRelease as prepareReleaseHost,
  readSavedWorkbookAssessment as readSaved, readWorkbookAssessment as readAssessment, sha256DigestText,
  workbookAssessmentSlot as slot, type AssessmentScope, type SavedAssessmentRow, type StudioWorkbookAssessmentDeps,
  type WorkbookAssessmentHost, type WorkbookAssessmentReadAccess,
} from '../../modules/activity/studio-workbook-assessment-host.ts';
import type { WorkbookDraft } from '../../modules/activity/workbook-values.ts';
import { assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, registerFormalAssessment } from './formal-assessment.ts';
import { RequestError } from './sessions.ts';
export const workbookAssessmentSlot = slot;
export { frozenSubmission, workbookTextEvaluator } from '../../modules/activity/studio-workbook-assessment-host.ts';
export type { WorkbookAssessmentHost, WorkbookAssessmentReadAccess, WorkbookAssessmentRoute } from '../../modules/activity/studio-workbook-assessment-host.ts';
const propagation = createPropagationHooks([]), maxOutputTokens = 512, effectLabel = 'workbook-assessment';
const SAVED_ASSESSMENT_SQL = `SELECT d.id, s.scope_keys, d.manifest, d.value FROM slot_state s
 LEFT JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
   AND NOT d.is_shadow AND d.deriver=$6 AND d.scope_keys=s.scope_keys AND d.effective_tick>=d.gather_tick AND d.selection_ended_tick IS NULL
   AND ($7::bigint IS NULL OR d.effective_tick<=$7::bigint)
   AND ((d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL) OR (s.current_id IS NULL AND d.lifecycle='stale' AND d.error->>'reason'='fact-access-changed'))
 WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'releaseRef'=$3::jsonb AND s.scope_keys->'submissionRef'->>'id'=$4 AND (s.scope_keys->'submissionRef'->>'rev')::int<=$5
 ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`;
const querySavedAssessment = async (tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submission: FactSnapshot, deriver: string, cutoff?: Tick) =>
  (await tx.query<SavedAssessmentRow>(SAVED_ASSESSMENT_SQL, [tx.learner, workbookAssessmentSlot, JSON.stringify(releaseRef), submission.ref.id, submission.ref.rev, deriver, cutoff ?? null])).rows[0];
const deps: StudioWorkbookAssessmentDeps = {
  fail: (status, message) => { throw new RequestError(status, message); }, isFactNotFound, isFactReadDenied,
  revisionsOnlyChangeGrants: revisionsOnlyChangeGrants as StudioWorkbookAssessmentDeps['revisionsOnlyChangeGrants'],
  createAuthorizedFactReader: createAuthorizedFactReader as StudioWorkbookAssessmentDeps['createAuthorizedFactReader'],
  gatherSnapshot: gatherSnapshot as StudioWorkbookAssessmentDeps['gatherSnapshot'],
  sealCandidate: sealCandidate as StudioWorkbookAssessmentDeps['sealCandidate'], submitCandidate: submitCandidate as StudioWorkbookAssessmentDeps['submitCandidate'],
  revalidateManifestTx: revalidateManifest, readWork: readWork as StudioWorkbookAssessmentDeps['readWork'],
  readReadyWork: readReadyWork as StudioWorkbookAssessmentDeps['readReadyWork'], runEffect: runEffect as StudioWorkbookAssessmentDeps['runEffect'],
  failWork: failWork as StudioWorkbookAssessmentDeps['failWork'], lockLearner: lockLearner as StudioWorkbookAssessmentDeps['lockLearner'],
  queryScopeKeys: (db, learner, slotKey) => (db as Db).snapshot({ learner: learner as never },
    tx => readSlotStatus<AssessmentScope>(tx, workbookAssessmentSlot, slotKey)).then(r => r && { scope_keys: r.scopeKeys }),
  learnerTx: (db, learner, run) => (db as Db).tx({ learner: learner as never }, run),
  learnerSnapshot: (db, learner, run) => (db as Db).snapshot({ learner: learner as never }, run),
  markBlocked: async (db, learner, slotKey, reason) => {
    await (db as Db).tx({ learner: learner as never }, tx => markSlotFailed(tx, workbookAssessmentSlot, slotKey, { status: 'blocked', reason }));
  },
  dbSnapshot: (db, scope, run) => (db as Db).snapshot(scope, run as never), dbTx: (db, scope, run) => (db as Db).tx(scope, run as never),
  readFormalAssessment: readFormalAssessment as StudioWorkbookAssessmentDeps['readFormalAssessment'],
  registerFormalAssessment: registerFormalAssessment as StudioWorkbookAssessmentDeps['registerFormalAssessment'],
  assessmentExecutionFailed, assessmentInputsBlocked, assessmentScopeType: 'assessment',
};
export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft) {
  return prepareReleaseHost(text => sha256DigestText(createHash as never, text), value, paperId, draft);
}
export function openWorkbookAssessment(db: Db, host: WorkbookAssessmentHost = {}) {
  const afterFactsChanged: CommandHooks['onFactsChanged'] = (tx, tick, changes) => afterWorkbookAssessmentFactsChanged(deps, host, tx, tick, changes as never);
  const execute = (ref: WorkRef, terminalFailure = false) => executeWorkbookAssessment(deps, db, host, propagation, maxOutputTokens, effectLabel, ref, terminalFailure);
  return { afterFactsChanged, execute };
}
export function readSavedWorkbookAssessment(tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submission: FactSnapshot, paper: FactSnapshot,
  cutoff?: Tick, requiredPurpose = storagePurpose, maySend?: (fact: FactSnapshot) => boolean) {
  return readSaved(deps, tx, releaseRef, submission, paper, deriver => querySavedAssessment(tx, releaseRef, submission, deriver, cutoff), cutoff, requiredPurpose, maySend);
}
export function readWorkbookAssessment(tx: ReadTransaction, release: AssessmentRelease, submissionRef: AssessmentRevisionRef, access?: WorkbookAssessmentReadAccess) {
  return readAssessment(deps, tx, release, submissionRef, (deriver, submission) => querySavedAssessment(tx, release.releaseRef, submission, deriver), access);
}
