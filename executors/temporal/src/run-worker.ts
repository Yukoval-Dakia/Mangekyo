import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createWorkWorker, type AdvanceCoordinator, type ExecuteWork } from './worker.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const module = await import(pathToFileURL(resolve(required('MANGEKYO_EXECUTE_WORK_MODULE'))).href);
if (typeof module.executeWork !== 'function' || typeof module.onTerminalFailure !== 'function') {
  throw new TypeError('Executor module must export executeWork and onTerminalFailure');
}
if (module.advanceCoordinator !== undefined && typeof module.advanceCoordinator !== 'function') {
  throw new TypeError('Optional advanceCoordinator export must be a function');
}
const { worker, connection } = await createWorkWorker(module.executeWork as ExecuteWork, {
  address: required('TEMPORAL_ADDRESS'),
  namespace: required('TEMPORAL_NAMESPACE'),
  taskQueue: required('TEMPORAL_TASK_QUEUE'),
  deploymentName: required('TEMPORAL_DEPLOYMENT'),
  buildId: required('TEMPORAL_BUILD_ID'),
  onTerminalFailure: module.onTerminalFailure as ExecuteWork,
  ...(module.advanceCoordinator === undefined ? {} : { advanceCoordinator: module.advanceCoordinator as AdvanceCoordinator }),
});
try {
  await worker.run();
} finally {
  await connection.close();
}
