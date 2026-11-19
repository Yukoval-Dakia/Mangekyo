import {
  allHandlersFinished, ApplicationFailure, condition, continueAsNew, defineSignal, isCancellation,
  proxyActivities, setHandler, workflowInfo,
} from '@temporalio/workflow';
import {
  coordinatorRequest, coordinatorWakeSignal, coordinatorWorkflowId, isCoordinatorRequest,
  type CoordinatorDecision, type CoordinatorRequest,
} from './coordinator.ts';
import { isOpaqueUlid } from './ref.ts';

const wakeCoordinator = defineSignal<[wakeRef: string]>(coordinatorWakeSignal);
const minimumRecheckDelayMs = 5_000;
const { advanceCoordinator } = proxyActivities<{
  advanceCoordinator(request: CoordinatorRequest): Promise<CoordinatorDecision>;
}>({
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '10 seconds',
  retry: { initialInterval: '1 second', maximumAttempts: 3 },
});

export async function mangekyoCoordinator(input: CoordinatorRequest): Promise<void> {
  if (!isCoordinatorRequest(input) || workflowInfo().workflowId !== coordinatorWorkflowId(input.coordinatorRef)) {
    throw ApplicationFailure.nonRetryable('Invalid coordinator input', 'InvalidCoordinatorRequest');
  }
  const { coordinatorRef } = input;
  let pendingWakeRef = input.wakeRef;
  setHandler(wakeCoordinator, (wakeRef) => {
    if (isOpaqueUlid(wakeRef)) pendingWakeRef = wakeRef;
  });
  const hasWake = () => pendingWakeRef !== undefined;

  for (;;) {
    const request = coordinatorRequest(coordinatorRef, pendingWakeRef);
    pendingWakeRef = undefined;
    let decision: CoordinatorDecision;
    try {
      decision = await advanceCoordinator(request);
    } catch (error) {
      if (isCancellation(error) || !hasWake()) throw error;
      if (workflowInfo().continueAsNewSuggested) {
        await condition(allHandlersFinished);
        return continueAsNew<typeof mangekyoCoordinator>(coordinatorRequest(coordinatorRef, pendingWakeRef));
      }
      continue;
    }
    if (decision.status === 'disabled' && !hasWake()) return;

    if (workflowInfo().continueAsNewSuggested) {
      await condition(allHandlersFinished);
      return continueAsNew<typeof mangekyoCoordinator>(coordinatorRequest(coordinatorRef, pendingWakeRef));
    }

    if (decision.status !== 'waiting' || hasWake()) continue;
    if (decision.recheckAtMs === undefined) {
      await condition(hasWake);
    } else {
      await condition(hasWake, Math.max(minimumRecheckDelayMs, decision.recheckAtMs - Date.now()));
    }
  }
}
