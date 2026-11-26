import { radarArguments } from '../../executors/teaching/workspace-tools.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { readCurrentValueDerivations } from '../../kernel/src/derivations/revalidate.ts';
import { guardAccess, parseManifest, revalidateManifest, type ReadTransaction } from '../../kernel/src/index.ts';
import { createLearnerRadarSupport, type Access, type RadarSlot, type RetentionBasis } from '../../modules/activity/learner-radar-support.ts';
import { readLearningOverview } from '../../modules/activity/learning-overview.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { radarInventory, radarOverview } from '../../modules/activity/workspace-source-projection.ts';
import { forecastType, reconciliationType } from '../../modules/learner/retention.ts';
import { classifyFrozenCrossing, projectForgettingRisks, projectRetentionRead } from '../../modules/learner/retention-view.ts';
import { purpose } from './identity.ts';
import { checkStudioNotionFact } from './notion.ts';
import { whenAvailable } from './research-sources.ts';
import { readRadarTodo } from './research-understanding.ts';
import { retentionHistoryValid } from './retention.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';
export type { Access, RadarSlot, RetentionBasis };
export const {
  isRadarRetentionSlot, readRetentionBasis, readMissedPosttest, readRetentionRadar, readAuthorizedRetention,
  readForgettingRisks, readLearnerRadar,
} = createLearnerRadarSupport({ purpose, forecastType, reconciliationType, guardAccess,
  readCurrentValueDerivations, revalidateManifest, parseManifest, retentionHistoryValid, checkStudioNotionFact, whenAvailable,
  projectRetentionRead, classifyFrozenCrossing, projectForgettingRisks, radarArguments, isSourceFactId,
  readLearningOverview, radarOverview, radarInventory, workspaceQuery, readRadarTodo });
export async function verifyRetentionBases(
  tx: ReadTransaction, bases: Iterable<RetentionBasis>, maySend: WorkspaceSourceRecipient,
): Promise<boolean> {
  for (const basis of bases) {
    const actual = await readRetentionBasis(tx, basis.slot, { callerPurpose: purpose, maySend });
    if (!actual || canonicalJsonString(actual) !== canonicalJsonString(basis)) return false;
  }
  return true;
}
