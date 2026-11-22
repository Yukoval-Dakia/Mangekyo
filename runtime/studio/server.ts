import pg from 'pg';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { createPgDb } from '../../kernel/src/db/pg.ts';
import { applyKernelSchema, workerStorage } from '../../kernel/src/schema.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { acknowledgeStartedWork, readWork, relayPending, type WorkRef } from '../../kernel/src/work/index.ts';
import { capabilityTaskQueue, startWork } from '../../executors/temporal/src/index.ts';
import { activateLocalDeployment, createWorkWorker, workCancellationSignal, type WorkFailureCause } from '../../executors/temporal/src/worker.ts';
import { createPythonDeriverHost } from '../../executors/python-deriver/host.ts';
import { executeNotionBlockWork, notionBlockRoute, NotionReadTemporaryFailure, openStudioNotion } from './notion.ts';
import { openStudio } from './sessions.ts';
import { recordTerminalFailure, teach } from './teach.ts';
import { sourceBuildId } from './build.ts';
import { serve } from './http.ts';
import { openTextbook } from './textbook.ts';
import { openIntake } from './intake.ts';
import { openCapturePapers } from './capture-papers.ts';
import { cloudIntakeRoute, cloudIntakeSlot, mineruToken, openCloudIntakeWork } from './intake-cloud.ts';
import { openVisionIntakeWork, visionIntakeRoute, visionIntakeSlot } from './intake-vision.ts';
import { readMineru, submitMineru } from '@mangekyo/executor-document-extraction/mineru';
import { openWorkbook } from './workbook.ts';
import { openTakeaway } from './takeaway.ts';
import { workbookBacktrace } from './workbook-backtrace.ts';
import { openPracticeAdmission } from './sealed-practice.ts';
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
import { correctionRetestDeriver } from './research-correction.ts';
import { validateResearchScoutHost } from './research-scout.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { openIqdb } from './iqdb.ts';
import { openTransparency } from './transparency.ts';
import { executeQuestionVerification, openLocalQuestionEffects } from './iqdb-verification.ts';
import { questionVerificationType } from '../../modules/content/question-verification.ts';
import { openRecallHttp } from './recall-http.ts';
import { isRetentionSlot, openRetention } from './retention.ts';
import { openRetentionComparison, retentionComparisonWork } from './retention-comparison.ts';
import { openCarePause } from './care-pause.ts';
import { listenForSessionEvents, prepareSessionEvents } from './stream.ts';
import { confirmedTeachingMethod, learningToolsMethod } from './identity.ts';
import type { StudioJitCounter } from './first-turn-jit.ts';

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
const stopEvents = mode !== 'worker' ? await listenForSessionEvents(db, () => new pg.Client({connectionString})) : undefined;
const activity = await loadModuleDirectory(fileURLToPath(new URL('../../modules/activity', import.meta.url)));
const capture = await loadModuleDirectory(fileURLToPath(new URL('../../modules/capture', import.meta.url)));
const content = await loadModuleDirectory(fileURLToPath(new URL('../../modules/content', import.meta.url)));
const companion = await loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
const understandingModule = process.env.MANGEKYO_UNDERSTANDING_MODULE;
const understandingTransport = understandingModule
  ? (await import(pathToFileURL(understandingModule).href)).understandingTransport
  : undefined;
if (understandingModule && !understandingTransport) throw new Error('宿主模块须导出 understandingTransport');
const scoutModule = process.env.MANGEKYO_RESEARCH_SCOUT_MODULE;
const scoutHost = scoutModule
  ? validateResearchScoutHost((await import(pathToFileURL(scoutModule).href)).researchScoutHost)
  : undefined;
const tariffModule = process.env.MANGEKYO_RESEARCH_WORKER_TARIFF;
const tariff = tariffModule ? (await import(pathToFileURL(tariffModule).href)).workerTariff : undefined;
const carePause = openCarePause(db, companion);
const research = openResearch(db, activity, companion, scoutHost, understandingTransport, undefined, tariff, carePause);
const captureHooks = createStudioCommandHooks({afterFactsChanged: research.activityChanged});
const intake = openIntake(db, capture, content, captureHooks);
const cloudIntake = openCloudIntakeWork(db, intake, { submit: submitMineru, read: readMineru });
const visionIntake = openVisionIntakeWork(db, intake);
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
const iqdbHost = await openLocalQuestionEffects(process.env.MANGEKYO_IQDB_LOCAL_WASM);
const artifactAssessmentModule = process.env.MANGEKYO_ARTIFACT_ASSESSMENT_MODULE;
const readArtifactAssessmentWitness: ReadArtifactAssessmentWitness | undefined = artifactAssessmentModule && mode !== 'web'
  ? (await import(pathToFileURL(artifactAssessmentModule).href)).readArtifactAssessmentWitness
  : undefined;
if (artifactAssessmentModule && mode !== 'web' && typeof readArtifactAssessmentWitness !== 'function')
  throw new Error('作品评估宿主模块须导出 readArtifactAssessmentWitness');
const jitModule = process.env.MANGEKYO_STUDIO_JIT_MODULE;
const jitCounters: readonly StudioJitCounter[] = jitModule
  ? (await import(pathToFileURL(jitModule).href)).studioJitCounters
  : [];
if (!Array.isArray(jitCounters)) throw new Error('首轮计数模块须导出 studioJitCounters');

async function openWeb() {
  const recall = openRecallHttp(db, activity, createStudioCommandHooks());
  const studio = await openStudio(db, activity, {projectRecall:recall.project,jitCounters,
    enableJit:process.env.MANGEKYO_STUDIO_ENABLE_JIT === '1'});
  const plan = await loadModuleDirectory(fileURLToPath(new URL('../../modules/plan', import.meta.url)));
  const workbook = openWorkbook(db, activity, {
    capture,
    assessment: workbookAssessment,
    context: {backtrace:workbookBacktrace,activePosttest:retention.activePosttest},
    onResearchFactsChanged: research.workbookChanged,
    pythonHost,
  });
  const activityHooks = createStudioCommandHooks({afterFactsChanged: research.activityChanged});
  const takeaways = openTakeaway(db, activity, activityHooks);
  const textbook = openTextbook(db, content, activityHooks,
    { python: pythonHost,
      backtrace: (tx, read, facts) => workbookBacktrace(tx, read as never, facts) as never },
    workbook.issueBank);
  const iqdb = openIqdb(db, Boolean(iqdbHost), workbook.issueBank);
  const student = { notion:openStudioNotion(db,capture,research.activityChanged), textbook,
    relationReview:openRelationReview(db,content,research.activityChanged),
    workbook, takeaways, practiceAdmission:openPracticeAdmission(db,content,activity,createStudioCommandHooks()),
    organizer: openOrganizer(db, activity, plan, activityHooks, carePause), memory: openMemory(db, companion),
    memoryManagement: openMemoryManagement(db, activity, companion),
    intake, capturePapers: openCapturePapers(db, capture, activity, captureHooks),
    workspace: openWorkspaceAccess(db, activity, content, capture, plan, research.activityChanged),
    research, recall, retention, retentionComparison, iqdb, transparency: openTransparency(db, {python: pythonHost,
      backtrace: (tx, read, facts) => workbookBacktrace(tx, read as never, facts) as never}), carePause };
  return serve(db, studio, openLibrary(db, capture, content, plan), openPractice(db, activity), student, port)
    .listen(port, '127.0.0.1', () => console.log('Mangekyō http://127.0.0.1:' + port));
}
const server = mode === 'worker' ? undefined : await openWeb();

async function interruptibleDelay(ms: number, signal: AbortSignal) {
  try {
    await delay(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

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
  const controller = new AbortController();
  const worker = runWorkerLoop(storeId, controller.signal);
  const stop = () => {
    controller.abort();
    void worker;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // In studio mode the HTTP server is the product surface: the worker loop runs
  // in the background and must never take the process down with it.
  if (mode === 'worker') await worker;
  else void worker.catch(() => {});
}

type WorkerRound = {
  readonly connection: Connection;
  readonly client: Client;
  readonly workers: readonly { worker: { run(): Promise<void>; getState(): string; shutdown(): void }; connection: { close(): Promise<void> } }[];
  readonly runs: readonly Promise<void>[];
  readonly relaying: Promise<void>;
  readonly roundFailed: () => boolean;
};

async function closeRound(round: WorkerRound | undefined) {
  if (!round) return;
  for (const { worker } of round.workers) if (worker.getState() === 'RUNNING') worker.shutdown();
  await Promise.allSettled([...round.runs, round.relaying]);
  await Promise.allSettled(round.workers.map(({ connection }) => connection.close()));
  await round.connection.close().catch(() => {});
}

async function runWorkerLoop(storeId: string, signal: AbortSignal) {
  await research.reconcile();
  const queue = (process.env.MANGEKYO_TASK_QUEUE || 'mangekyo-studio') + '-' + storeId;
  const executeResearch = (ref: WorkRef, terminal: boolean) => research.execute(ref, terminal, workCancellationSignal());
  const notion = openStudioNotion(db, capture, research.activityChanged);
  async function executeDefault(ref: WorkRef, terminal: boolean) {
    if (await executeResearch(ref, terminal)) return;
    const work = await readWork(db, ref);
    if (!work || [confirmedTeachingMethod,learningToolsMethod].includes(work.deriver)) return;
    if (work.slotType === cloudIntakeSlot) await cloudIntake.execute(ref, terminal);
    else if (work.slotType === visionIntakeSlot) await visionIntake.execute(ref, terminal, workCancellationSignal());
    else if (work.slotType === workbookAssessmentSlot) await workbookAssessment.execute(ref, terminal);
    else if (work.slotType === questionVerificationType) await executeQuestionVerification(db, ref, iqdbHost, terminal);
    else if (work.slotType === artifactAssessmentSlot) await executeArtifactAssessment(db, ref, terminal);
    else if (work.slotType === retentionComparisonWork) await retentionComparison.execute(ref, work.slotKey, terminal);
    else if (isRetentionSlot(work.slotType)) await retention.execute(ref, terminal);
    else if (terminal) await recordTerminalFailure(db, ref);
    else await teach(db, ref, readArtifactAssessmentWitness, jitCounters, research.turnCompleted, carePause,
      notion);
  }
  const workerConfig = {
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7423',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    buildId: process.env.MANGEKYO_BUILD_ID || (await sourceBuildId()),
  };
  const protectedMethods = [
    {deriver:confirmedTeachingMethod, lane:'teaching-confirmed-v1'},
    {deriver:learningToolsMethod, lane:'learning-tools-v1'},
  ];
  const lanes = [
    { queue, route: undefined, run: executeDefault },
    { queue: capabilityTaskQueue(queue, 'correction-retest-v1'), route: { deriver: correctionRetestDeriver }, run: executeResearch },
    ...protectedMethods.map(({deriver,lane}) => ({queue:capabilityTaskQueue(queue,lane),route:{deriver},
      async run(ref: WorkRef, terminal: boolean) {
        if ((await readWork(db,ref))?.deriver !== deriver) return;
        if (terminal) await recordTerminalFailure(db,ref);
        else await teach(db,ref,readArtifactAssessmentWitness,jitCounters,research.turnCompleted,carePause,
          notion);
      },
    })),
    { queue: capabilityTaskQueue(queue, 'notion-block-v1'), route: notionBlockRoute,
      run: (ref: WorkRef, terminal: boolean, cause?: WorkFailureCause) => executeNotionBlockWork(db, ref, terminal, cause) },
    ...(mineruToken() ? [{ queue: capabilityTaskQueue(queue, 'ocr-v1'), route: cloudIntakeRoute, run: cloudIntake.execute }] : []),
    { queue: capabilityTaskQueue(queue, 'vision-ocr-v1'), route: visionIntakeRoute,
      run: (ref: WorkRef, terminal: boolean) => visionIntake.execute(ref, terminal, workCancellationSignal()) },
  ];

  async function startRound(): Promise<WorkerRound> {
    const connection = await Connection.connect({ address: workerConfig.address });
    const client = new Client({ connection, namespace: workerConfig.namespace });
    let failed = false;
    let workers;
    try {
      workers = await Promise.all(lanes.map(lane => {
        async function run(id: string, terminal = false, cause?: WorkFailureCause) {
          const ref = await acknowledgeStartedWork(db, id, lane.route);
          if (ref) await lane.run(ref, terminal, cause);
        }
        return createWorkWorker(run, {
          ...workerConfig, taskQueue: lane.queue, deploymentName: lane.queue,
          ...(lane.route ? {} : { advanceCoordinator: research.advance }),
          onTerminalFailure: (id, cause) => run(id, true, cause),
          ...(lane.route === notionBlockRoute ? { isRemoteUnavailable: (error: unknown) => error instanceof NotionReadTemporaryFailure } : {}),
        });
      }));
    } catch (error) {
      await connection.close().catch(() => {});
      throw error;
    }
    const runs = workers.map(({ worker }) => worker.run());
    const running = Promise.all(runs);
    void running.catch(error => {
      if (!signal.aborted) {
        failed = true;
        console.error('Temporal Worker 中断，准备重连。', error instanceof Error ? error.name : 'error');
      }
    });
    if (process.env.MANGEKYO_ACTIVATE_LOCAL_BUILD === '1') {
      try {
        await Promise.all(lanes.map(lane => activateLocalDeployment(client, workerConfig, lane.queue)));
      } catch (error) {
        failed = true;
        console.error('构建激活失败，准备重连。', error instanceof Error ? error.name : 'error');
      }
    }
    async function relay(lane: typeof lanes[number]) {
      let warned = false;
      while (!signal.aborted && !failed) {
        try {
          await relayPending(db, async (ref, id) => {
            if (!lane.route && await research.relayWake(client, queue, ref, id)) return;
            await startWork(client, id, { taskQueue: lane.queue });
          }, lane.route);
          warned = false;
        } catch {
          if (signal.aborted || failed) break;
          if (!warned) console.error('执行交接暂时不可用，待办已保留。');
          warned = true;
        }
        if (!await interruptibleDelay(warned ? 2500 : 500, signal)) break;
      }
    }
    const relaying = Promise.all(lanes.map(relay)).then(() => undefined);
    return { connection, client, workers, runs, relaying, roundFailed: () => failed };
  }

  let attempt = 0;
  let offlineLogged = false;
  let round: WorkerRound | undefined;
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  const stop = async () => {
    stopEvents?.();
    server?.close();
    await closeRound(round);
    await pythonHost.close();
    await db.close();
  };
  try {
    while (!signal.aborted) {
      try {
        round = await startRound();
      } catch (error) {
        await closeRound(round);
        round = undefined;
        if (signal.aborted) break;
        if (!offlineLogged) {
          console.error('Temporal 暂不可达，后台将持续重连；本地界面不受影响。',
            error instanceof Error ? error.name : 'error');
          offlineLogged = true;
        }
        if (!await interruptibleDelay(Math.min(30_000, 2_000 * 2 ** attempt), signal)) break;
        attempt += 1;
        continue;
      }
      attempt = 0;
      offlineLogged = false;
      const outcome = await Promise.race([
        Promise.all(round.runs).then(() => 'stopped' as const, () => 'failed' as const),
        round.relaying.then(() => 'stopped' as const, () => 'stopped' as const),
        aborted,
      ]);
      const finished = round;
      round = undefined;
      await closeRound(finished);
      if (signal.aborted || outcome === 'aborted') break;
      if (outcome === 'failed' || finished.roundFailed()) {
        if (!offlineLogged) {
          console.error('Temporal 连接中断，后台将持续重连。');
          offlineLogged = true;
        }
        if (!await interruptibleDelay(Math.min(30_000, 2_000 * 2 ** attempt), signal)) break;
        attempt += 1;
      } else break;
    }
  } finally {
    await stop();
  }
}
