import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import {
  createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import type { SourceRefV1 } from '../../modules/activity/source-values.ts';
import type { WorkbookAttempt } from '../../modules/activity/workbook-values.ts';
import {
  openWorkbookDiagnosisSource as openSource, openWorkbookQuestionSources as openQuestions,
  readReleasedAssessment as readReleased, readWorkbookDiagnosis as readDiagnosis,
  studioDiagnosisSourceUnavailable, type StudioDiagnosisDeps,
} from '../../modules/activity/studio-diagnosis-host.ts';
import { purpose } from './identity.ts';
import { resolveSource } from './source-read.ts';
import { readSavedWorkbookAssessment } from './workbook-assessment.ts';
import { readWorkspaceAttemptAssessments } from './workspace-read.ts';

const deps: StudioDiagnosisDeps = {
  purpose,
  isFactNotFound: error => error instanceof FactNotFoundError,
  isFactReadDenied: error => error instanceof FactReadDeniedError,
  revisionsOnlyChangeGrants: revisionsOnlyChangeGrants as StudioDiagnosisDeps['revisionsOnlyChangeGrants'],
  createAuthorizedFactReader: createAuthorizedFactReader as StudioDiagnosisDeps['createAuthorizedFactReader'],
  createCommandReadContext: createCommandReadContext as StudioDiagnosisDeps['createCommandReadContext'],
  resolveSource: resolveSource as StudioDiagnosisDeps['resolveSource'],
  readSavedWorkbookAssessment: readSavedWorkbookAssessment as StudioDiagnosisDeps['readSavedWorkbookAssessment'],
  readWorkspaceAttemptAssessments: readWorkspaceAttemptAssessments as StudioDiagnosisDeps['readWorkspaceAttemptAssessments'],
};

type Access = Parameters<typeof openSource>[3];
export type { Access as WorkbookDiagnosisAccess };

export const openWorkbookDiagnosisSource = (tx: ReadTransaction, reference: string | SourceRefV1, access: Access) =>
  openSource(deps, tx, reference, access);
export const openWorkbookQuestionSources = (tx: ReadTransaction, submission: FactSnapshot, access: Access, itemId?: string) =>
  openQuestions(deps, tx, submission, access, itemId);
export const readReleasedAssessment = (tx: ReadTransaction, attempt: WorkbookAttempt, submission: FactSnapshot,
  access: Access, cutoff?: Tick) => readReleased(deps, tx, attempt, submission, access, cutoff);
export const readWorkbookDiagnosis = (tx: ReadTransaction, reference: string | SourceRefV1, access: Access) =>
  readDiagnosis(deps, tx, reference, access);
export const sourceUnavailable = (error: unknown) => studioDiagnosisSourceUnavailable(deps, error);
