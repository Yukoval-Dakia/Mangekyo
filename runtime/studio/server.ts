import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { createPgDb } from '../../kernel/src/db/pg.ts';
import { applyKernelSchema, workerStorage } from '../../kernel/src/schema.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { acknowledgeStartedWork, readWork, relayPending, type WorkRef } from '../../kernel/src/work/index.ts';
import { capabilityTaskQueue, startWork } from '../../executors/temporal/src/index.ts';
import { activateLocalDeployment, createWorkWorker } from '../../executors/temporal/src/worker.ts';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { openStudio } from './sessions.ts';
import { recordTerminalFailure, teach } from './teach.ts';
import { sourceBuildId } from './build.ts';
import { serve } from './http.ts';
import { openTextbook } from './textbook.ts';
import { openIntake } from './intake.ts';
import { openCapturePapers } from './capture-papers.ts';
import { cloudIntakeRoute, cloudIntakeSlot, mineruToken, openCloudIntakeWork } from './intake-cloud.ts';
import { readMineru, submitMineru } from '@mangekyo/executor-document-extraction/mineru';
import { openWorkbook } from './workbook.ts';
import { workbookBacktrace } from './workbook-backtrace.ts';
import {
  artifactAssessmentSlot, executeArtifactAssessment, type ReadArtifactAssessmentWitness,
} from './artifact-assessment.ts';
import { openWorkbookAssessment, workbookAssessmentSlot, type WorkbookAssessmentHost } from './workbook-assessment.ts';
import { openOrganizer } from './organizer.ts';
import { openMemory } from './memory.ts';
import { openMemoryManagement } from './memory-management.ts';
import { openPractice } from './practice.ts';
import { openLibrary } from './library.ts';
import { openWorkspaceAccess } from './workspace-access.ts';
import { openRelationReview } from './workspace-relation.ts';
import { openResearch } from './research.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { openRecallHttp } from './recall-http.ts';
import { isRetentionSlot, openRetention } from './retention.ts';
import { openRetentionComparison, retentionComparisonWork } from './retention-comparison.ts';
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
const activity = await loadModuleDirectory(fileURLToPath(new URL('../../modules/activity', import.meta.url)));
const capture = await loadModuleDirectory(fileURLToPath(new URL('../../modules/capture', import.meta.url)));
const content = await loadModuleDirectory(fileURLToPath(new URL('../../modules/content', import.meta.url)));
const companion = await loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
const understandingModule = process.env.MANGEKYO_UNDERSTANDING_MODULE;
const understandingTransport = understandingModule
  ? (await import(pathToFileURL(understandingModule).href)).understandingTransport
  : undefined;
if (understandingModule && !understandingTransport) throw new Error('宿主模块须导出 understandingTransport');
const research = openResearch(db, activity, companion, undefined, undefined, understandingTransport);
const captureHooks = createStudioCommandHooks({afterFactsChanged: research.activityChanged});
const intake = openIntake(db, capture, content, captureHooks);
const cloudIntake = openCloudIntakeWork(db, intake, { submit: submitMineru, read: readMineru });
// This module is trusted deployment configuration, shared by the HTTP and Worker processes.
const assessmentModule = process.env.MANGEKYO_WORKBOOK_ASSESSMENT_MODULE;
const assessmentHost: WorkbookAssessmentHost | undefined = assessmentModule
  ? (await import(pathToFileURL(assessmentModule).href)).workbookAssessmentHost
  : undefined;
if (assessmentModule && !assessmentHost) throw new Error('自动评估宿主模块须导出 workbookAssessmentHost');
const workbookAssessment = openWorkbookAssessment(db, assessmentHost);
const pythonHost = createPythonDeriverHost();
const retention = openRetention(db, activity, process.env.MANGEKYO_RETENTION_METHOD, pythonHost);
const retentionComparison = openRetentionComparison(db, pythonHost);
const artifactAssessmentModule = process.env.MANGEKYO_ARTIFACT_ASSESSMENT_MODULE;
const readArtifactAssessmentWitness: ReadArtifactAssessmentWitness | undefined = artifactAssessmentModule && mode !== 'web'
  ? (await import(pathToFileURL(artifactAssessmentModule).href)).readArtifactAssessmentWitness
  : undefined;
if (artifactAssessmentModule && mode !== 'web' && typeof readArtifactAssessmentWitness !== 'function')
  throw new Error('作品评估宿主模块须导出 readArtifactAssessmentWitness');

async function openWeb() {
  const recall = openRecallHttp(db, activity, createStudioCommandHooks());
  const studio = await openStudio(db, activity, { projectRecall: recall.project });
  const plan = await loadModuleDirectory(fileURLToPath(new URL('../../modules/plan', import.meta.url)));
  const textbook = openTextbook(db, content, createStudioCommandHooks({afterFactsChanged: research.activityChanged}));
  const workbook = openWorkbook(db, activity, {
    assessment: workbookAssessment,
    context: {backtrace:workbookBacktrace,activePosttest:retention.activePosttest},
    onResearchFactsChanged: research.workbookChanged,
  });
  const student = { textbook, relationReview:openRelationReview(db,content),
    workbook, organizer: openOrganizer(db, activity, plan), memory: openMemory(db, companion),
    memoryManagement: openMemoryManagement(db, activity, companion),
    intake, capturePapers: openCapturePapers(db, capture, activity, captureHooks),
    workspace: openWorkspaceAccess(db, activity, content, capture, plan, research.activityChanged),
    research, recall, retention, retentionComparison };
  return serve(db, studio, openLibrary(db, capture, content, plan), openPractice(db, activity), student, port)
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
  await runWorker(storeId).catch(async error => {
    await pythonHost.close();
    throw error;
  });
}

async function runWorker(storeId: string) {
  await research.reconcile();
  const queue = (process.env.MANGEKYO_TASK_QUEUE || 'mangekyo-studio') + '-' + storeId;
  async function executeDefault(ref: WorkRef, terminal: boolean) {
    if (await research.execute(ref, terminal)) return;
    const work = await readWork(db, ref);
    if (!work) return;
    if (work.slotType === cloudIntakeSlot) await cloudIntake.execute(ref, terminal);
    else if (work.slotType === workbookAssessmentSlot) await workbookAssessment.execute(ref, terminal);
    else if (work.slotType === artifactAssessmentSlot) await executeArtifactAssessment(db, ref, terminal);
    else if (work.slotType === retentionComparisonWork) await retentionComparison.execute(ref, work.slotKey, terminal);
    else if (isRetentionSlot(work.slotType)) await retention.execute(ref, terminal);
    else if (terminal) await recordTerminalFailure(db, ref);
    else await teach(db, ref, readArtifactAssessmentWitness);
  }
  const workerConfig = {
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7423',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    buildId: process.env.MANGEKYO_BUILD_ID || (await sourceBuildId()),
  };
  const connection = await Connection.connect({ address: workerConfig.address });
  const client = new Client({ connection, namespace: workerConfig.namespace });
  const lanes = [
    { queue, route: undefined, run: executeDefault },
    ...(mineruToken() ? [{ queue: capabilityTaskQueue(queue, 'ocr-v1'), route: cloudIntakeRoute, run: cloudIntake.execute }] : []),
  ];
  const workers = await Promise.all(lanes.map(lane => {
    async function execute(id: string, terminal = false) {
      const ref = await acknowledgeStartedWork(db, id, lane.route);
      if (ref) await lane.run(ref, terminal);
    }
    return createWorkWorker(execute, {
      ...workerConfig, taskQueue: lane.queue, deploymentName: lane.queue,
      ...(lane.route ? {} : {advanceCoordinator: research.advance}),
      onTerminalFailure: id => execute(id, true),
    });
  }));
  let stopping = false;
  const runs = workers.map(({worker}) => worker.run());
  const running = Promise.all(runs);
  void running.catch((error) => {
    console.error('Temporal Worker 停止', error.name);
    process.exitCode = 1;
    stopping = true;
  });
  if (process.env.MANGEKYO_ACTIVATE_LOCAL_BUILD === '1') {
    await Promise.all(lanes.map(lane => activateLocalDeployment(client, workerConfig, lane.queue)));
  }
  async function relay(lane: typeof lanes[number]) {
    let failed = false;
    while (!stopping) {
      try {
        await relayPending(db, async (ref, id) => {
          if (!lane.route && await research.relayWake(client, queue, ref, id)) return;
          await startWork(client, id, {taskQueue: lane.queue});
        }, lane.route);
        failed = false;
      } catch {
        if (!failed) console.error('执行交接暂时不可用，待办已保留。');
        failed = true;
      }
      await delay(failed ? 2500 : 500);
    }
  }
  const relaying = Promise.all(lanes.map(relay));
  let closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    stopping = true;
    stopEvents?.();
    server?.close();
    for (const {worker} of workers) if (worker.getState() === 'RUNNING') worker.shutdown();
    await Promise.allSettled([...runs, relaying]);
    await pythonHost.close();
    await Promise.all(workers.map(({connection}) => connection.close()));
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
