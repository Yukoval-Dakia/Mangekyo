import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { guardAccess } from '../../kernel/src/commands/reads.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { readCurrentValueDerivations, revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { forecastType, reconciliationType } from '../../modules/learner/retention.ts';
import { classifyFrozenCrossing, projectForgettingRisks, projectRetentionRead } from '../../modules/learner/retention-view.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { readLearningOverview } from '../../modules/activity/learning-overview.ts';
import { radarArguments } from '../../executors/teaching/workspace-tools.ts';
import { radarInventory, radarOverview } from '../../modules/activity/workspace-source-projection.ts';
import { purpose } from './identity.ts';
import { checkStudioNotionFact } from './notion.ts';
import { retentionHistoryValid } from './retention.ts';
import { whenAvailable } from './research-sources.ts';
import { workspaceQuery } from './workspace-read.ts';
import { readRadarTodo } from './research-understanding.ts';
import { createLearnerRadarSupport, type Access, type RadarSlot, type RetentionBasis } from '../../modules/activity/learner-radar-support.ts';

export type { Access, RadarSlot, RetentionBasis };
export const {
  isRadarRetentionSlot, readRetentionBasis, readMissedPosttest, readRetentionRadar, readAuthorizedRetention,
  readForgettingRisks, readLearnerRadar,
} = createLearnerRadarSupport({purpose, forecastType, reconciliationType, guardAccess,
  readCurrentValueDerivations, revalidateManifest, parseManifest, retentionHistoryValid, checkStudioNotionFact, whenAvailable,
  projectRetentionRead, classifyFrozenCrossing, projectForgettingRisks, radarArguments, isSourceFactId,
  readLearningOverview, radarOverview, radarInventory, workspaceQuery, readRadarTodo});
