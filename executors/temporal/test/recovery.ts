import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import { msToTs } from '@temporalio/common/time';
import { describeWork, startWork } from '../src/index.ts';
import { executions, privateBody } from './executor.ts';

const address = process.env.TEMPORAL_ADDRESS;
assert(address);
const namespace = 'probe-' + randomUUID(), taskQueue = namespace, deploymentName = namespace;
const connection = await Connection.connect({ address });
const client = new Client({ connection, namespace });
const workers: ChildProcess[] = [];

async function until(label: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function worker(buildId: string, activate: boolean) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/run-worker.ts', import.meta.url))], {
    env: { ...process.env, TEMPORAL_ADDRESS: address, TEMPORAL_NAMESPACE: namespace, TEMPORAL_TASK_QUEUE: taskQueue,
      TEMPORAL_DEPLOYMENT: deploymentName, TEMPORAL_BUILD_ID: buildId,
      MANGEKYO_EXECUTE_WORK_MODULE: fileURLToPath(new URL('./executor.ts', import.meta.url)) },
    stdio: 'inherit',
  });
  workers.push(child);
  if (activate) {
    await until(`${buildId} pollers`, async () => {
      assert.equal(child.exitCode, null);
      try { await client.workflowService.setWorkerDeploymentCurrentVersion({ namespace, deploymentName, buildId }); return true; }
      catch { return false; }
    });
  }
  return child;
}

async function complete(executionRef: string) {
  await until(`${executionRef} completion`, async () => (await describeWork(client, executionRef)).status === 'COMPLETED');
  return describeWork(client, executionRef);
}

async function cleanup() {
  await Promise.all(workers.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit');
  }));
  await connection.close();
}

let cleanupRun: Promise<void> | undefined;
const clean = () => cleanupRun ??= cleanup();
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const)
  process.once(signal, () => void clean().catch(console.error).finally(() => process.exit(exitCode)));

try {
  await connection.workflowService.registerNamespace({ namespace, workflowExecutionRetentionPeriod: msToTs('1 day') });
  const lostAck = new Client({ connection, namespace, interceptors: { workflow: [{ async startWithDetails(input, next) {
    await next(input);
    throw new Error('Injected lost start acknowledgment');
  } }] } });
  const { recovery, fresh, closed, failure, terminal } = executions;
  await assert.rejects(startWork(client, privateBody, { taskQueue }), /Invalid Temporal execution reference/);
  const old = await worker('old', true);
  await assert.rejects(startWork(lostAck, recovery, { taskQueue }), /lost start/);
  await until('activity started', async () =>
    (await describeWork(client, recovery)).pendingActivities?.some((item) => item.state === 2) ?? false);
  const originalRun = (await describeWork(client, recovery)).runId;
  assert.equal(await startWork(client, recovery, { taskQueue }), recovery);
  old.kill('SIGKILL');
  assert.deepEqual(await once(old, 'exit'), [null, 'SIGKILL']);
  await worker('new', true);
  await startWork(client, fresh, { taskQueue });
  const freshResult = await complete(fresh);
  assert.equal(freshResult.versioningInfo?.deploymentVersion?.buildId, 'new');
  await until('heartbeat timeout', async () => (await describeWork(client, recovery)).pendingActivities
    ?.some((item) => item.state === 1 && (item.attempt ?? 0) > 1) ?? false);
  const waiting = await describeWork(client, recovery);
  assert.equal(waiting.status, 'RUNNING');
  assert.equal(waiting.versioningInfo?.deploymentVersion?.buildId, 'old');
  await worker('old', false);
  const resumed = await complete(recovery);
  assert.equal(resumed.runId, originalRun);
  assert.equal(resumed.versioningInfo?.deploymentVersion?.buildId, 'old');

  await assert.rejects(startWork(lostAck, closed, { taskQueue }), /lost start/);
  const closedResult = await complete(closed);
  assert.equal(await startWork(client, closed, { taskQueue }), closed);
  assert.equal((await describeWork(client, closed)).runId, closedResult.runId);

  await startWork(client, failure, { taskQueue });
  const failureResult = await complete(failure);
  const history = await client.workflow.getHandle(failureResult.workflowId).fetchHistory();
  const serialized = JSON.stringify(history, (_key, value) =>
    value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value);
  assert(!serialized.includes(privateBody));
  assert(serialized.includes('WorkExecutionFailed'));
  const events = history.events ?? [];
  const workflowInput = events.find((event) => event.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes?.input?.payloads;
  const activityInput = events.find((event) => event.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes?.input?.payloads;
  for (const input of [workflowInput, activityInput])
    assert.deepEqual(input?.map((payload) => defaultPayloadConverter.fromPayload(payload)), [failure]);
  const terminalId = await startWork(client, terminal, { taskQueue });
  await until('recorded terminal failure', async () => (await describeWork(client, terminal)).status === 'FAILED');
  const terminalHistory = await client.workflow.getHandle(terminalId).fetchHistory();
  const terminalText = JSON.stringify(terminalHistory);
  assert(terminalText.includes('WorkExecutionFailed') && terminalText.includes('WorkFailureRecordingFailed') && !terminalText.includes(privateBody));
  const failureRecord = terminalHistory.events?.find((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === 'recordWorkFailure');
  assert.deepEqual(failureRecord?.activityTaskScheduledEventAttributes?.input?.payloads?.map((payload) => defaultPayloadConverter.fromPayload(payload)), [terminal]);
  console.log(JSON.stringify({ namespace, waiting, resumed, freshResult, closedResult, failureResult, terminalId }, null, 2));
} finally { await clean(); }
