import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/common';
import { validateExecutionRef } from './ref.ts';

export interface WorkConfig {
  taskQueue: string;
}

export async function startWork(
  client: Client,
  executionRef: string,
  config: WorkConfig,
): Promise<string> {
  validateExecutionRef(executionRef);
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(config.taskQueue)) {
    throw new TypeError('Invalid Temporal task queue');
  }
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
