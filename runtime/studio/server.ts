import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { createPgDb } from '../../kernel/src/db/pg.ts';
import { applyKernelSchema, workerStorage } from '../../kernel/src/schema.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { acknowledgeStartedWork, relayPending } from '../../kernel/src/work/index.ts';
import { startWork } from '../../executors/temporal/src/index.ts';
import { createWorkWorker } from '../../executors/temporal/src/worker.ts';
import { openStudio } from './sessions.ts';
import { recordTerminalFailure, teach } from './teach.ts';
import { sourceBuildId } from './build.ts';
import { serve } from './http.ts';
import { openPractice } from './practice.ts';
import { openLibrary } from './library.ts';
import { listenForSessionEvents, prepareSessionEvents } from './stream.ts';

const port = Number(process.env.MANGEKYO_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MANGEKYO_PORT 无效');
const connectionString = process.env.MANGEKYO_DATABASE_URL;
if (!connectionString)
  throw new Error('请通过 MANGEKYO_DATABASE_URL 指定 Mangekyō 的本地 PostgreSQL 数据库。');
const schema = process.env.MANGEKYO_DATABASE_SCHEMA || 'mangekyo_studio';
if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('数据库 schema 名称无效');
const mode = process.env.MANGEKYO_PROCESS || 'studio';
if (!['studio', 'web', 'worker'].includes(mode))
  throw new Error('MANGEKYO_PROCESS 必须是 studio、web 或 worker');
const pool = new pg.Pool({ connectionString });
if (mode !== 'worker') await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema);
const db = createPgDb(pool, { schema });
if (mode !== 'worker') {
  await applyKernelSchema(db);
  await prepareSessionEvents(db);
}
const storeId = await workerStorage(db);
const stopEvents = mode !== 'worker' ? await listenForSessionEvents(db, pool) : undefined;
async function openWeb() {
  const activity = await loadModuleDirectory(fileURLToPath(new URL('../../modules/activity', import.meta.url)));
  const studio = await openStudio(db, activity);
  return serve(db, studio, openLibrary(db, activity), openPractice(db, activity), port)
    .listen(port, '127.0.0.1', () => console.log('Mangekyō http://127.0.0.1:' + port));
}
const server = mode === 'worker' ? undefined : await openWeb();
if (mode === 'web') {
  const stop = () => {
    stopEvents?.();
    server?.close(() => {
      void db.close();
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} else {
  await runWorker(storeId);
}

async function runWorker(storeId: string) {
  const queue = (process.env.MANGEKYO_TASK_QUEUE || 'mangekyo-studio') + '-' + storeId;
  const workerConfig = {
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7423',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    taskQueue: queue,
    deploymentName: queue,
    onTerminalFailure: async (id: string) => {
      const ref = await acknowledgeStartedWork(db, id);
      if (ref) await recordTerminalFailure(db, ref);
    },
    buildId: process.env.MANGEKYO_BUILD_ID || (await sourceBuildId()),
  };
  const connection = await Connection.connect({ address: workerConfig.address });
  const client = new Client({ connection, namespace: workerConfig.namespace });
  const { worker, connection: workerConnection } = await createWorkWorker(async (id) => {
    const ref = await acknowledgeStartedWork(db, id);
    if (ref) await teach(db, ref);
  }, workerConfig);
  let stopping = false;
  const running = worker.run();
  void running.catch((error) => {
    console.error('Temporal Worker 停止', error.name);
    process.exitCode = 1;
    stopping = true;
  });
  if (process.env.MANGEKYO_ACTIVATE_LOCAL_BUILD === '1') {
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(workerConfig.address))
      throw new Error('自动激活构建仅限本机开发服务');
    for (let attempt = 0; ; attempt++) {
      try {
        await client.workflowService.setWorkerDeploymentCurrentVersion({
          namespace: workerConfig.namespace,
          deploymentName: workerConfig.deploymentName,
          buildId: workerConfig.buildId,
        });
        break;
      } catch (error) {
        if (attempt >= 59) throw error;
        await delay(500);
      }
    }
  }
  async function relay() {
    let failed = false;
    while (!stopping) {
      try {
        await relayPending(db, async (_ref, id) => {
          await startWork(client, id, { taskQueue: workerConfig.taskQueue });
        });
        failed = false;
      } catch {
        if (!failed) console.error('执行交接暂时不可用，待办已保留。');
        failed = true;
      }
      await delay(failed ? 2500 : 500);
    }
  }
  const relaying = relay();
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    stopping = true;
    stopEvents?.();
    server?.close();
    if (worker.getState() === 'RUNNING') worker.shutdown();
    await Promise.allSettled([running, relaying]);
    await workerConnection.close();
    await connection.close();
    await db.close();
  }
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  void running
    .finally(() => {
      if (!closing) void stop();
    })
    .catch(() => {});
}
