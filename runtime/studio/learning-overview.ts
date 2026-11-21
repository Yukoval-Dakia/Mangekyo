import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import {
  learningOverviewPurpose, readActivityLearningOverview, readGoalOverview, readTasksOverview, type LearningOverviewAccess,
} from '../../modules/activity/learning-overview.ts';

export { learningOverviewPurpose, type LearningOverviewAccess };
export const readGoal = (tx: ReadTransaction, access: LearningOverviewAccess,
  read: Pick<ReadContext, 'fact'> = createCommandReadContext(tx, access.callerPurpose)) =>
  readGoalOverview(tx, access, read, readable);
export const readTasks = (tx: ReadTransaction, access: LearningOverviewAccess, limit?: number | null) =>
  readTasksOverview(tx, access, createCommandReadContext(tx, access.callerPurpose), readable, limit);
export const readLearningOverview = (tx: ReadTransaction, access: LearningOverviewAccess) =>
  readActivityLearningOverview(tx, access, createCommandReadContext(tx, access.callerPurpose), readable);
