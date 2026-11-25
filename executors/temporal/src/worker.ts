import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from '@temporalio/client';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Context, heartbeat } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import { createCoordinatorActivity, type AdvanceCoordinator } from './coordinator-activity.ts';
import { validateExecutionRef } from './ref.ts';
import { classifiedWorkFailureTypes, type WorkFailureCause } from './work-failure.ts';

export type { AdvanceCoordinator } from './coordinator-activity.ts';
export type { WorkFailureCause } from './work-failure.ts';

export interface WorkWorkerConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  deploymentName: string;
  buildId: string;
  onTerminalFailure: (executionRef: string, cause?: WorkFailureCause) => Promise<unknown>;
  isRemoteUnavailable?: (error: unknown) => boolean;
  advanceCoordinator?: AdvanceCoordinator;
}

export async function activateLocalDeployment(client: Client, config: Pick<WorkWorkerConfig, 'address' | 'namespace' | 'buildId'>, deploymentName: string) {
  if (!/^(localhost|127\.0\.0\.1|\[::1\]|temporal):\d+$/.test(config.address)) throw new Error('自动激活构建仅限本机或单机 Compose 服务');
  for (let attempt = 0; ; attempt++) {
    try {
      await client.workflowService.setWorkerDeploymentCurrentVersion({
        namespace: config.namespace, deploymentName, buildId: config.buildId,
      });
      return;
    } catch (error) {
      if (attempt >= 59) throw error;
      await delay(500);
    }
  }
}

export const workCancellationSignal = () => Context.current().cancellationSignal;

export type ExecuteWork = (executionRef: string) => Promise<unknown>;

async function runOpaqueActivity(execute: ExecuteWork, executionRef: string, type: string,
  isRemoteUnavailable?: WorkWorkerConfig['isRemoteUnavailable'],
): Promise<void> {
  try {
    validateExecutionRef(executionRef);
    await execute(executionRef);
  } catch (error) {
    if (Context.current().cancellationSignal.aborted) {
      const cancellation = new CancelledFailure('Work activity cancelled');
      delete cancellation.stack;
      throw cancellation;
    }
    const failureType = isRemoteUnavailable
      ? classifiedWorkFailureTypes[isRemoteUnavailable(error) ? 'remote-unavailable' : 'execution'] : type;
    const failure = ApplicationFailure.create({ message: 'Work activity failed', type: failureType });
    delete failure.stack;
    throw failure;
  }
}

export async function createWorkWorker(
  executeWork: ExecuteWork,
  config: WorkWorkerConfig,
): Promise<{ worker: Worker; connection: NativeConnection }> {
  for (const value of [config.namespace, config.taskQueue, config.deploymentName, config.buildId]) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
      throw new TypeError('Invalid Temporal worker configuration');
    }
  }
  const connection = await NativeConnection.connect({ address: config.address });
  try {
    const options: WorkerOptions = {
      connection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      identity: `${config.deploymentName}.${config.buildId}:${process.pid}@${hostname()}`,
      workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
      workerDeploymentOptions: {
        useWorkerVersioning: true,
        version: {
          deploymentName: config.deploymentName,
          buildId: config.buildId,
        },
        defaultVersioningBehavior: 'PINNED',
      },
      activities: {
        executeWork: async (executionRef: string): Promise<void> => {
          const timer = setInterval(() => heartbeat(), 3000);
          timer.unref();
          try {
            await runOpaqueActivity(executeWork, executionRef, 'WorkExecutionFailed', config.isRemoteUnavailable);
          } finally {
            clearInterval(timer);
          }
        },
        recordWorkFailure: (executionRef: string, cause?: WorkFailureCause) =>
          runOpaqueActivity(id => config.onTerminalFailure(id,cause), executionRef, 'WorkFailureRecordingFailed'),
        ...(config.advanceCoordinator === undefined
          ? {}
          : { advanceCoordinator: createCoordinatorActivity(config.advanceCoordinator) }),
      },
    };
    return { worker: await Worker.create(options), connection };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
