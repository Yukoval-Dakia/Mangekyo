import { goalType } from '../../modules/plan/goal-values.ts';
import { organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import { independentlyAuthoredPaper, workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { readLearningOverview } from '../../modules/activity/learning-overview.ts';
import { canProcessPricedEffect } from '../../kernel/src/work/effects.ts';
import { readTodo } from '../../kernel/src/work/todos.ts';
import { readRetentionRadar } from './learner-radar.ts';
import { textSlice } from './reading.ts';
import { readResearchForeground } from './research-foreground.ts';
import { activeRetentionReview, independentScoutSource, reviewMaterialAvailable, readWorksheetById, researchReader, retentionReviewAnchor, whenAvailable, worksheetPublication } from './research-sources.ts';
import {
  prepareResearchTriage as _prepare, preparePaidResearchTriage as _preparePaid, scoutEffectIdentity as _scoutEffectIdentity,
} from '../../modules/companion/studio-research-triage-host.ts';

export { researchDecision, reviewGoal } from '../../modules/companion/research-triage-policy.ts';
export const scoutEffectIdentity = _scoutEffectIdentity;

const deps = { canProcessPricedEffect, readTodo, goalType, organizerTaskType, independentlyAuthoredPaper, workbookAttempt, workbookAttemptType, readLearningOverview,
  readRetentionRadar, textSlice, readResearchForeground, activeRetentionReview, independentScoutSource,
  reviewMaterialAvailable, readWorksheetById, researchReader, retentionReviewAnchor, whenAvailable, worksheetPublication };
export const prepareResearchTriage = (tx: any, reviewed: any, settingsRevision: number, now: number, paidConfigured: boolean, eligible: any) =>
  _prepare(deps, tx, reviewed, settingsRevision, now, paidConfigured, eligible);
export const preparePaidResearchTriage = (tx: any, settingsId: any, settingsRevision: number, now: number, grant: any) =>
  _preparePaid(deps, tx, settingsId, settingsRevision, now, grant);
