import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import { coordinatorWakeSignal, coordinatorWorkflowId, coordinatorWorkflowType, isCoordinatorRef } from './coordinator.ts';
import type { mangekyoCoordinator } from './coordinator-workflow.ts';
import { isOpaqueUlid, validateExecutionRef } from './ref.ts';

export type { CoordinatorDecision, CoordinatorRequest } from './coordinator.ts';

export interface WorkConfig {
  taskQueue: string;
}

function validateTaskQueue(taskQueue: string): void {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(taskQueue)) throw new TypeError('Invalid Temporal task queue');
}

export async function startOrWakeCoordinator(
  client: Client,
  coordinatorRef: string,
  wakeRef: string,
  config: WorkConfig,
): Promise<string> {
  if (!isCoordinatorRef(coordinatorRef)) throw new TypeError('Invalid Temporal coordinator reference');
  if (!isOpaqueUlid(wakeRef)) throw new TypeError('Invalid Temporal wake reference');
  validateTaskQueue(config.taskQueue);
  const workflowId = coordinatorWorkflowId(coordinatorRef);
  await client.workflow.signalWithStart<typeof mangekyoCoordinator, [wakeRef: string]>(coordinatorWorkflowType, {
    workflowId,
    taskQueue: config.taskQueue,
    args: [{ coordinatorRef }],
    signal: coordinatorWakeSignal,
    signalArgs: [wakeRef],
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
  });
  return workflowId;
}

export async function startWork(
  client: Client,
  executionRef: string,
  config: WorkConfig,
): Promise<string> {
  validateExecutionRef(executionRef);
  validateTaskQueue(config.taskQueue);
  try {
    await client.workflow.start('mangekyoWork', {
      args: [executionRef],
      taskQueue: config.taskQueue,
      workflowId: executionRef,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
      throw error;
    }
  }
  return executionRef;
}

export async function describeWork(client: Client, executionRef: string) {
  validateExecutionRef(executionRef);
  const execution = await client.workflow.getHandle(executionRef).describe();
  return {
    workflowId: executionRef,
    runId: execution.runId,
    status: execution.status.name,
    taskQueue: execution.taskQueue,
    startTime: execution.startTime,
    closeTime: execution.closeTime,
    versioningInfo: execution.raw.workflowExecutionInfo?.versioningInfo,
    pendingActivities: execution.raw.pendingActivities?.map((activity) => ({
      activityId: activity.activityId,
      state: activity.state,
      attempt: activity.attempt,
      lastHeartbeatTime: activity.lastHeartbeatTime,
      lastWorkerIdentity: activity.lastWorkerIdentity,
    })),
  };
}
