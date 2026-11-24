import type {ReadTransaction} from '../../kernel/src/index.ts';
import { projectWorksheet, type ReviewAccess } from '../../modules/companion/worksheet-policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { createCommandReadContext, isFactUnavailable, storageRead } from './fact-read-helpers.ts';

import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { independentlyAuthoredPaper, workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { ResearchBasisChanged, researchPurpose, researchSettings, retentionReviewPermission, retentionReviewPermissionType } from '../../modules/companion/research.ts';
import { stableId, studioLearner } from './identity.ts';
import { resolveWorkPublication } from '../../kernel/src/work/payload.ts';
import { readMissedPosttest } from './learner-radar.ts';
import { RequestError } from './sessions.ts';

export const researchReader = (tx: ReadTransaction) => createCommandReadContext(tx, researchPurpose);
export const settingsId = factId(stableId('research-settings', studioLearner));

export function currentResearchSettings(tx: ReadTransaction) { return whenAvailable(async () => {
    const {ref, accessEpoch, value} = await researchReader(tx).fact(settingsId, {mode:'following'});
    const {enabled, coordinatorRef, scoutConsent, workerGrant} = researchSettings(value);
    return {enabled, coordinatorRef, workerGrant, scoutBudget:scoutConsent, revision:ref.rev, accessEpoch};});
}

export async function whenAvailable<T>(read: () => Promise<T>): Promise<T | null> { try {
    return await read();} catch (error) {
    if (isFactUnavailable(error) || error instanceof ResearchBasisChanged) return null;
    throw error;
  }
}

export function worksheetPublication(tx: ReadTransaction, attemptId: FactId, revision: number, epoch: string) {
  return resolveWorkPublication(tx, factId(stableId('research-worksheet-v1', attemptId, String(revision), epoch)),
    id => ({factId:id, commandId:commandId(stableId('publish-worksheet', id))}),
    (id, generation) => factId(stableId('research-worksheet-after-erasure', id, generation)));
}

export async function workbookSource(tx: ReadTransaction, paperId: string, attemptId: string) {
  const fact = await whenAvailable(() => storageRead(tx).fact(factId(attemptId), { mode: 'following' }));
  if (fact?.type !== workbookAttemptType || workbookAttempt(fact.value).paperId !== paperId)
    throw new RequestError(404, '找不到这次作答。');
  return fact;
}

/** Paid scout titles come only from a provably independent frozen paper and its current source. */
export async function independentScoutSource(tx: ReadTransaction, fact: FactSnapshot) {
  if (fact.type !== workbookAttemptType) return false;
  const { paper, paperId } = workbookAttempt(fact.value);
  if (!independentlyAuthoredPaper(paper) || !explicitIndependentPaper(fact.value, 'paper')) return false;
  const live = await whenAvailable(() => storageRead(tx).fact(factId(paperId), { mode: 'following' }));
  return live?.type === workbookPaperType && explicitIndependentPaper(live.value) &&
    isDeepStrictEqual(workbookPaper(live.value), paper);
}

function explicitIndependentPaper(value: FactSnapshot['value'], key?: 'paper') {
  const paper = key && value && typeof value === 'object' && 'paper' in value ? value.paper : value;
  return paper !== null && typeof paper === 'object' && 'materialId' in paper && paper.materialId === null;
}

export async function reviewMaterialAvailable(tx: ReadTransaction, paper: ReturnType<typeof workbookPaper>) {
  const { materialId } = paper;
  return materialId === null || Boolean(await whenAvailable(() => storageRead(tx).fact(factId(materialId), { mode: 'following' })));
}

export { reviewEvidence, retentionReviewAnchor, type ReviewEvidence } from '../../modules/companion/worksheet-policy.ts';

export function retentionReviewPermissionId(key: string) {
  return factId(stableId('retention-review-permission', key));
}

export async function activeRetentionReview(tx: ReadTransaction, fact: FactSnapshot) {
  if (fact.type !== retentionReviewPermissionType || !fact.purpose.includes(researchPurpose)) return null;
  const permission = retentionReviewPermission(fact.value);
  if (!permission.allowed || fact.ref.id !== retentionReviewPermissionId(permission.key) ||
      !await readMissedPosttest(tx, permission.key, permission.resultId)) return null;
  return permission;
}

export function reviewAccess(tx: ReadTransaction): ReviewAccess { const read = researchReader(tx);
  return {read, open:id => whenAvailable(() => read.fact(id,{mode:'following'})),
    independent:source => independentScoutSource(tx,source), retention:source => activeRetentionReview(tx,source),
    material:paper => reviewMaterialAvailable(tx,paper)};
}
export function readWorksheetById(tx: ReadTransaction, id: FactId) {
  return whenAvailable(() => projectWorksheet(reviewAccess(tx), id, async (...source) => (await worksheetPublication(tx, ...source)).factId,
    key => storageRead(tx).fact(key,{mode:'following'})));
}

export async function readWorksheet(tx: ReadTransaction, attempt: FactSnapshot) {
  if (!attempt.purpose.includes(researchPurpose)) return null;
  return readWorksheetById(tx, (await worksheetPublication(tx, attempt.ref.id, attempt.ref.rev, attempt.accessEpoch)).factId);
}

export async function comparisonAttempts(tx: ReadTransaction) {
  const {rows} = await tx.query<{id:string}>(`SELECT id FROM facts WHERE learner_id=$1 AND type=$2
    AND $3=ANY(purpose) AND retracted_rev IS NULL ORDER BY changed_tick DESC, id LIMIT 50`,
    [tx.learner, workbookAttemptType, researchPurpose]);
  const attempts = [];
  for (const row of rows) {
    const source = await whenAvailable(() => researchReader(tx).fact(factId(row.id), {mode:'following'}));
    if (!source || !await independentScoutSource(tx, source)) continue;
    const attempt = workbookAttempt(source.value);
    if (attempt.feedback.some(item => item.result === 'incorrect')) attempts.push({id:source.ref.id,
      title:attempt.paper.title, submittedAt:attempt.submittedAt, revision:source.ref.rev, accessEpoch:source.accessEpoch});
  }
  return attempts;
}
