import { createHash } from 'node:crypto';
import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId, Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, readWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import type { AssessmentRelease, AssessmentRevisionRef } from '../../modules/activity/assessment-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  afterWorkbookAssessmentFactsChanged, executeWorkbookAssessment, prepareWorkbookRelease as prepareReleaseHost,
  readSavedWorkbookAssessment as readSaved, readWorkbookAssessment as readAssessment, sha256DigestText,
  workbookAssessmentSlot as slot,
  type SavedAssessmentRow, type StudioWorkbookAssessmentDeps, type WorkbookAssessmentHost,
  type WorkbookAssessmentReadAccess, type AssessmentScope,
} from '../../modules/activity/studio-workbook-assessment-host.ts';
import type { WorkbookDraft } from '../../modules/activity/workbook-values.ts';
import {
  assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, registerFormalAssessment,
} from './formal-assessment.ts';
import { RequestError } from './sessions.ts';

export const workbookAssessmentSlot = slot;
export { workbookTextEvaluator, frozenSubmission } from '../../modules/activity/studio-workbook-assessment-host.ts';
export type { WorkbookAssessmentHost, WorkbookAssessmentRoute, WorkbookAssessmentReadAccess } from '../../modules/activity/studio-workbook-assessment-host.ts';

const propagation = createPropagationHooks([]);
const maxOutputTokens = 512;
const effectLabel = 'workbook-assessment';

const deps: StudioWorkbookAssessmentDeps = {
  fail: (status, message) => { throw new RequestError(status, message); },
  isFactNotFound: error => error instanceof FactNotFoundError,
  isFactReadDenied: error => error instanceof FactReadDeniedError,
  revisionsOnlyChangeGrants: revisionsOnlyChangeGrants as StudioWorkbookAssessmentDeps['revisionsOnlyChangeGrants'],
  createAuthorizedFactReader: createAuthorizedFactReader as StudioWorkbookAssessmentDeps['createAuthorizedFactReader'],
  gatherSnapshot: gatherSnapshot as StudioWorkbookAssessmentDeps['gatherSnapshot'],
  sealCandidate: sealCandidate as StudioWorkbookAssessmentDeps['sealCandidate'],
  submitCandidate: submitCandidate as StudioWorkbookAssessmentDeps['submitCandidate'],
  revalidateManifestTx: revalidateManifest,
  readWork: readWork as StudioWorkbookAssessmentDeps['readWork'],
  readReadyWork: readReadyWork as StudioWorkbookAssessmentDeps['readReadyWork'],
  runEffect: runEffect as StudioWorkbookAssessmentDeps['runEffect'],
  failWork: failWork as StudioWorkbookAssessmentDeps['failWork'],
  lockLearner: lockLearner as StudioWorkbookAssessmentDeps['lockLearner'],
  queryScopeKeys: async (db, learner, slotKey) => {
    const { rows: [row] } = await (db as Db).query<{ scope_keys: AssessmentScope }>(
      'SELECT scope_keys FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [learner as string, workbookAssessmentSlot, slotKey],
    );
    return row;
  },
  learnerTx: (db, learner, run) => (db as Db).tx({ learner: learner as never }, run),
  learnerSnapshot: (db, learner, run) => (db as Db).snapshot({ learner: learner as never }, run),
  markBlocked: async (db, learner, slotKey, reason) => {
    await (db as Db).tx({ learner: learner as never }, async tx => {
      await tx.query(
        'UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
        [tx.learner, workbookAssessmentSlot, slotKey, JSON.stringify({ status: 'blocked', reason })],
      );
    });
  },
  dbSnapshot: (db, scope, run) => (db as Db).snapshot(scope, run as never),
  dbTx: (db, scope, run) => (db as Db).tx(scope, run as never),
  readFormalAssessment: readFormalAssessment as StudioWorkbookAssessmentDeps['readFormalAssessment'],
  registerFormalAssessment: registerFormalAssessment as StudioWorkbookAssessmentDeps['registerFormalAssessment'],
  assessmentExecutionFailed,
  assessmentInputsBlocked,
  assessmentScopeType: 'assessment',
};

function digest(text: string) {
  return sha256DigestText(createHash as never, text);
}

export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft) {
  return prepareReleaseHost(digest, value, paperId, draft);
}

export function openWorkbookAssessment(db: Db, host: WorkbookAssessmentHost = {}) {
  const afterFactsChanged: CommandHooks['onFactsChanged'] = (tx, tick, changes) =>
    afterWorkbookAssessmentFactsChanged(deps, host, tx, tick, changes as never);
  const execute = (ref: WorkRef, terminalFailure = false) =>
    executeWorkbookAssessment(deps, db, host, propagation, maxOutputTokens, effectLabel, ref, terminalFailure);
  return { afterFactsChanged, execute };
}

export async function readSavedWorkbookAssessment(
  tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submission: FactSnapshot, paper: FactSnapshot,
  cutoff?: Tick, requiredPurpose = storagePurpose, maySend?: (fact: FactSnapshot) => boolean,
) {
  return readSaved(deps, tx, releaseRef, submission, paper,
    async deriver => {
      const { rows: [row] } = await tx.query<SavedAssessmentRow>(
        `SELECT d.id, s.scope_keys, d.manifest, d.value FROM slot_state s
         LEFT JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id) =
           (s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
           AND NOT d.is_shadow AND d.deriver=$6 AND d.scope_keys=s.scope_keys
           AND d.effective_tick>=d.gather_tick AND d.selection_ended_tick IS NULL
           AND ($7::bigint IS NULL OR d.effective_tick<=$7::bigint)
           AND ((d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL) OR
             (s.current_id IS NULL AND d.lifecycle='stale' AND d.error->>'reason'='fact-access-changed'))
         WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'releaseRef'=$3::jsonb
           AND s.scope_keys->'submissionRef'->>'id'=$4 AND (s.scope_keys->'submissionRef'->>'rev')::int<=$5
         ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`,
        [tx.learner, workbookAssessmentSlot, JSON.stringify(releaseRef), submission.ref.id, submission.ref.rev, deriver, cutoff ?? null],
      );
      return row;
    }, cutoff, requiredPurpose, maySend);
}

export async function readWorkbookAssessment(
  tx: ReadTransaction,
  release: AssessmentRelease,
  submissionRef: AssessmentRevisionRef,
  access?: WorkbookAssessmentReadAccess,
) {
  return readAssessment(deps, tx, release, submissionRef,
    async (deriver, submission) => {
      const { rows: [row] } = await tx.query<SavedAssessmentRow>(
        `SELECT d.id, s.scope_keys, d.manifest, d.value FROM slot_state s
         LEFT JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id) =
           (s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
           AND NOT d.is_shadow AND d.deriver=$6 AND d.scope_keys=s.scope_keys
           AND d.effective_tick>=d.gather_tick AND d.selection_ended_tick IS NULL
           AND ($7::bigint IS NULL OR d.effective_tick<=$7::bigint)
           AND ((d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL) OR
             (s.current_id IS NULL AND d.lifecycle='stale' AND d.error->>'reason'='fact-access-changed'))
         WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'releaseRef'=$3::jsonb
           AND s.scope_keys->'submissionRef'->>'id'=$4 AND (s.scope_keys->'submissionRef'->>'rev')::int<=$5
         ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`,
        [tx.learner, workbookAssessmentSlot, JSON.stringify(release.releaseRef), submission.ref.id, submission.ref.rev, deriver, null],
      );
      return row;
    }, access);
}
