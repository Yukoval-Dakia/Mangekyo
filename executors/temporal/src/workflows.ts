import { ActivityFailure, ApplicationFailure, isCancellation, proxyActivities, workflowInfo } from '@temporalio/workflow';
import { validateExecutionRef } from './ref.ts';
import { readWorkFailureCause, type WorkFailureCause } from './work-failure.ts';

export { mangekyoCoordinator } from './coordinator-workflow.ts';

const { executeWork } = proxyActivities<{
  executeWork(executionRef: string): Promise<void>;
}>({
  // A teaching turn can make five sequential three-minute calls, including one repair.
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '10 seconds',
  retry: {
    initialInterval: '1 second',
    maximumInterval: '1 minute',
    maximumAttempts: 4,
  },
});

const { recordWorkFailure } = proxyActivities<{
  recordWorkFailure(executionRef: string, cause?: WorkFailureCause): Promise<void>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '1 second', maximumInterval: '1 minute' },
});

export async function mangekyoWork(executionRef: string): Promise<void> {
  try {
    validateExecutionRef(executionRef);
    if (executionRef !== workflowInfo().workflowId) throw new TypeError();
  } catch {
    throw ApplicationFailure.nonRetryable('Invalid Temporal execution reference', 'InvalidExecutionRef');
  }
  try {
    await executeWork(executionRef);
  } catch (error) {
    if (error instanceof ActivityFailure && !isCancellation(error)) {
      const cause = error.cause instanceof ApplicationFailure ? readWorkFailureCause(error.cause.type) : undefined;
      // Histories without a classified failure retain the original activity command.
      if (cause) await recordWorkFailure(executionRef, cause);
      else await recordWorkFailure(executionRef);
    }
    throw error;
  }
}
