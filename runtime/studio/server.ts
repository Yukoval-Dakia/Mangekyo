import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { createPgDb } from '../../kernel/src/db/pg.ts';
import { applyKernelSchema, workerStorage } from '../../kernel/src/schema.ts';
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
import type { WorkerTariff } from '../../executors/teaching/research-worker.ts';
import { createSettingsResearchScoutHost, createSettingsUnderstandingTransport } from '../../executors/teaching/background-llm.ts';
import { loadSettings } from './settings.ts';
import { openWorkbook } from './workbook.ts';
import { openTakeaway } from './takeaway.ts';
import { workbookBacktrace } from './workbook-backtrace.ts';
import { openPracticeAdmission } from './sealed-practice.ts';
import { artifactAssessmentSlot, executeArtifactAssessment, type ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import { openWorkbookAssessment, workbookAssessmentSlot, type WorkbookAssessmentHost } from './workbook-assessment.ts';
import { openOrganizer } from './organizer.ts';
import { openMemory } from './memory.ts';
import { openMemoryManagement } from './memory-management.ts';
import { openPractice } from './practice.ts';
import { openLibrary } from './library.ts';
import { openWorkspaceAccess } from './workspace-access.ts';
import { openRelationReview } from './workspace-relation.ts';
import { openResearch } from './research.ts';
import { paidExtractionRecipient, type UnderstandingTransport } from './research-understanding.ts';
import { correctionRetestDeriver } from './research-correction.ts';
import { validateResearchScoutHost, type ResearchScoutHost } from './research-scout.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { openIqdb } from './iqdb.ts';
import { openTransparency } from './transparency.ts';
import { executeQuestionVerification, openLocalQuestionEffects } from './iqdb-verification.ts';
import { questionVerificationType } from '../../modules/content/question-verification.ts';
import { openRecallHttp } from './recall-http.ts';
import { isRetentionSlot, openRetention } from './retention.ts';
import { openRetentionComparison, retentionComparisonWork } from './retention-comparison.ts';
import { openOnboarding } from './onboarding.ts';
import { openCarePause } from './care-pause.ts';
import { openKnowledgeMaintenance } from './research-maintenance.ts';
import { listenForSessionEvents, prepareSessionEvents } from './stream.ts';
import { confirmedTeachingMethod, learningToolsMethod, studioModule } from './identity.ts';
import type { StudioJitCounter } from './first-turn-jit.ts';
const port = Number(process.env.MANGEKYO_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MANGEKYO_PORT 无效');
const connectionString = process.env.MANGEKYO_DATABASE_URL;
const pgEnv = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].some(name => process.env[name] !== undefined);
const pgPort = pgEnv && process.env.PGPORT !== undefined ? Number(process.env.PGPORT) : 5432;
if (pgEnv && (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535)) throw new Error('PGPORT 无效');
const dbConfig: pg.ClientConfig | undefined = connectionString ? { connectionString } : pgEnv ? {
  ...(process.env.PGHOST !== undefined && { host: process.env.PGHOST }), port: pgPort,
  ...(process.env.PGUSER !== undefined && { user: process.env.PGUSER }), password: process.env.PGPASSWORD ?? '',
  ...(process.env.PGDATABASE !== undefined && { database: process.env.PGDATABASE }),
} : undefined;
if (!dbConfig) throw new Error('请通过 MANGEKYO_DATABASE_URL 或 PGHOST/PGUSER/PGDATABASE 指定 Mangekyō 的本地 PostgreSQL 数据库。');
const envOr = (name: string, fallback: string, valid: (v: string) => boolean, message: string) => {
  const value = process.env[name] || fallback;
  if (!valid(value)) throw new Error(message);
  return value;
};
const schema = envOr('MANGEKYO_DATABASE_SCHEMA', 'mangekyo_studio', v => /^[a-z][a-z0-9_]{0,62}$/.test(v), '数据库 schema 名称无效');
const mode = envOr('MANGEKYO_PROCESS', 'studio', v => ['studio', 'web', 'worker'].includes(v), 'MANGEKYO_PROCESS 必须是 studio、web 或 worker');
const pool = new pg.Pool(dbConfig), db = createPgDb(pool, { schema });
if (mode !== 'worker') { await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema); await applyKernelSchema(db); await prepareSessionEvents(db); }
const storeId = await workerStorage(db);
const stopEvents = mode !== 'worker' ? await listenForSessionEvents(db, () => new pg.Client(dbConfig)) : undefined;
const loadHostModule = async <T>(envName: string, exportName: string, errorMessage?: string, check?: (loaded: T) => boolean): Promise<T | undefined> => {
  const mod = process.env[envName];
  if (!mod) return undefined;
  const loaded = (await import(pathToFileURL(mod).href))[exportName] as T | undefined;
  if (errorMessage && (loaded === undefined || (check && !check(loaded)))) throw new Error(errorMessage);
  return loaded;
};
const [activity, capture, content, companion] = await Promise.all([
  studioModule('activity'), studioModule('capture'), studioModule('content'), studioModule('companion'),
]);
const understandingTransport = (await loadHostModule<UnderstandingTransport>('MANGEKYO_UNDERSTANDING_MODULE', 'understandingTransport', '宿主模块须导出 understandingTransport')) ?? createSettingsUnderstandingTransport(() => loadSettings(), { maySend: paidExtractionRecipient });
const defaultScoutHost = () => createSettingsResearchScoutHost(() => loadSettings());
const loadedScout = await loadHostModule<ResearchScoutHost>('MANGEKYO_RESEARCH_SCOUT_MODULE', 'researchScoutHost');
const scoutHost = validateResearchScoutHost(loadedScout ?? defaultScoutHost());
const tariff = await loadHostModule<WorkerTariff>('MANGEKYO_RESEARCH_WORKER_TARIFF', 'workerTariff');
const carePause = openCarePause(db, companion);
const research = openResearch(db, activity, companion, scoutHost, understandingTransport, undefined, tariff, carePause);
const retentionEnv = process.env.MANGEKYO_RESEARCH_RETENTION_DAYS;
const retentionDays = retentionEnv !== undefined && Number.isSafeInteger(Number(retentionEnv)) && Number(retentionEnv) >= 0
  ? Number(retentionEnv) : undefined;
const maintenance = openKnowledgeMaintenance(db, { content, activity, carePause,
  ...(retentionDays === undefined ? {} : { retentionDays }),
  afterFactsChanged: research.activityChanged });
const captureHooks = createStudioCommandHooks({afterFactsChanged: research.activityChanged});
const intake = openIntake(db, capture, content, captureHooks);
const cloudIntake = openCloudIntakeWork(db, intake, { submit: submitMineru, read: readMineru });
const visionIntake = openVisionIntakeWork(db, intake);
// This module is trusted deployment configuration, shared by the HTTP and Worker processes.
const assessmentHost = await loadHostModule<WorkbookAssessmentHost>('MANGEKYO_WORKBOOK_ASSESSMENT_MODULE', 'workbookAssessmentHost', '自动评估宿主模块须导出 workbookAssessmentHost');
const workbookAssessment = openWorkbookAssessment(db, assessmentHost);
const pythonHost = createPythonDeriverHost();
const retention = openRetention(db, activity, process.env.MANGEKYO_RETENTION_METHOD, pythonHost);
const retentionComparison = openRetentionComparison(db, pythonHost);
const iqdbHost = await openLocalQuestionEffects(process.env.MANGEKYO_IQDB_LOCAL_WASM);
const artifactWitness = mode === 'web' ? undefined : await loadHostModule<ReadArtifactAssessmentWitness>('MANGEKYO_ARTIFACT_ASSESSMENT_MODULE', 'readArtifactAssessmentWitness', '作品评估宿主模块须导出 readArtifactAssessmentWitness', v => typeof v === 'function');
const jitCounters: readonly StudioJitCounter[] = process.env.MANGEKYO_STUDIO_JIT_MODULE
  ? (await loadHostModule<readonly StudioJitCounter[]>('MANGEKYO_STUDIO_JIT_MODULE', 'studioJitCounters', '首轮计数模块须导出 studioJitCounters', Array.isArray)) as readonly StudioJitCounter[]
  : [];
const listenHost = process.env.MANGEKYO_HOST?.trim() || '127.0.0.1';
if (!['127.0.0.1', '::1', '0.0.0.0'].includes(listenHost)) throw new Error('MANGEKYO_HOST 仅允许 127.0.0.1、::1 或 0.0.0.0。');
async function openWeb() {
  const recall = openRecallHttp(db, activity, createStudioCommandHooks()), plan = await studioModule('plan');
  const studio = await openStudio(db, activity, {
    projectRecall: recall.project, jitCounters, enableJit: process.env.MANGEKYO_STUDIO_ENABLE_JIT === '1',
  });
  const workbook = openWorkbook(db, activity, {
    capture, assessment: workbookAssessment, context: { backtrace: workbookBacktrace, activePosttest: retention.activePosttest },
    onResearchFactsChanged: research.workbookChanged, pythonHost,
  });
  const activityHooks = createStudioCommandHooks({ afterFactsChanged: research.activityChanged });
  const pulseHost = { python: pythonHost, backtrace: (tx: unknown, read: unknown, facts: unknown) => workbookBacktrace(tx as never, read as never, facts as never) as never };
  const textbook = openTextbook(db, content, activityHooks, pulseHost, workbook.issueBank);
  const student = {
    notion: openStudioNotion(db, capture, research.activityChanged), textbook,
    relationReview: openRelationReview(db, content, research.activityChanged), workbook,
    takeaways: openTakeaway(db, activity, activityHooks),
    practiceAdmission: openPracticeAdmission(db, content, activity, createStudioCommandHooks()),
    organizer: openOrganizer(db, activity, plan, activityHooks, carePause), memory: openMemory(db, companion),
    memoryManagement: openMemoryManagement(db, activity, companion), intake,
    capturePapers: openCapturePapers(db, capture, activity, captureHooks),
    workspace: openWorkspaceAccess(db, activity, content, capture, plan, research.activityChanged),
    research, recall, retention, retentionComparison,
    iqdb: openIqdb(db, Boolean(iqdbHost), workbook.issueBank, content, activityHooks, activity, capture, { savePaper: workbook.save, pythonHost }),
    transparency: openTransparency(db, pulseHost), carePause,
    onboarding: openOnboarding(db, { plan, content, companion }, { hooks: activityHooks }), maintenance, pythonHost,
  };
  return serve(db, studio, openLibrary(db, capture, content, plan), openPractice(db, activity), student, port)
    .listen(port, listenHost, () => console.log('Mangekyō http://' + listenHost + ':' + port));
}
const server = mode === 'worker' ? undefined : await openWeb();
async function interruptibleDelay(ms: number, signal: AbortSignal) {
  try { await delay(ms, undefined, { signal }); return true; } catch { return false; }
}
const signalStop = (fn: () => void) => { process.once('SIGTERM', fn); process.once('SIGINT', fn); };
if (mode === 'web') signalStop(() => { stopEvents?.(); server?.close(() => { void db.close(); }); });
else {
  const controller = new AbortController(), worker = runWorkerLoop(storeId, controller.signal);
  signalStop(() => { controller.abort(); void worker; });
  // In studio mode the HTTP server is the product surface: the worker loop runs
  // in the background and must never take the process down with it.
  if (mode === 'worker') await worker; else void worker.catch(() => {});
}
type WorkerRound = {
  readonly connection: Connection; readonly client: Client; readonly relaying: Promise<void>;
  readonly runs: readonly Promise<void>[]; readonly roundFailed: () => boolean;
  readonly workers: readonly { worker: { run(): Promise<void>; getState(): string; shutdown(): void }; connection: { close(): Promise<void> } }[];
};
async function closeRound(round: WorkerRound | undefined) {
  if (!round) return;
  for (const { worker } of round.workers) if (worker.getState() === 'RUNNING') worker.shutdown();
  await Promise.allSettled([...round.runs, round.relaying]);
  await Promise.allSettled(round.workers.map(({ connection }) => connection.close()));
  await round.connection.close().catch(() => {});
}
let offlineLogged = false;
let attempt = 0;
const reconnectBackoff = (error: unknown, message: string, signal: AbortSignal) => {
  if (!offlineLogged) {
    if (error !== undefined) console.error(message, error instanceof Error ? error.name : 'error');
    else console.error(message);
    offlineLogged = true;
  }
  return interruptibleDelay(Math.min(30_000, 2_000 * 2 ** attempt++), signal);
};
async function runWorkerLoop(storeId: string, signal: AbortSignal) {
  await research.reconcile();
  const advanceWithMaintenance: typeof research.advance = async (request: Parameters<typeof research.advance>[0], signal: AbortSignal) => {
    const decision = await research.advance(request, signal);
    if (decision.status === 'waiting') await maintenance.run({ force: false }).catch(() => {});
    return decision;
  };
  const queue = (process.env.MANGEKYO_TASK_QUEUE || 'mangekyo-studio') + '-' + storeId;
  const executeResearch = (ref: WorkRef, terminal: boolean) => research.execute(ref, terminal, workCancellationSignal());
  const notion = openStudioNotion(db, capture, research.activityChanged);
  const teachWork = (ref: WorkRef) => teach(db, ref, artifactWitness, jitCounters, research.turnCompleted, carePause, notion);
  async function executeDefault(ref: WorkRef, terminal: boolean) {
    if (await executeResearch(ref, terminal)) return;
    const work = await readWork(db, ref);
    if (!work || [confirmedTeachingMethod,learningToolsMethod].includes(work.deriver)) return;
    const run = work.slotType === cloudIntakeSlot ? () => cloudIntake.execute(ref, terminal)
      : work.slotType === visionIntakeSlot ? () => visionIntake.execute(ref, terminal, workCancellationSignal())
      : work.slotType === workbookAssessmentSlot ? () => workbookAssessment.execute(ref, terminal)
      : work.slotType === questionVerificationType ? () => executeQuestionVerification(db, ref, iqdbHost, terminal)
      : work.slotType === artifactAssessmentSlot ? () => executeArtifactAssessment(db, ref, terminal)
      : work.slotType === retentionComparisonWork ? () => retentionComparison.execute(ref, work.slotKey, terminal)
      : isRetentionSlot(work.slotType) ? () => retention.execute(ref, terminal)
      : terminal ? () => recordTerminalFailure(db, ref) : () => teachWork(ref);
    await run();
  }
  const workerConfig = {
    address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:7423',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    buildId: process.env.MANGEKYO_BUILD_ID || (await sourceBuildId()),
  };
  const protectedLanes = [[confirmedTeachingMethod, 'teaching-confirmed-v1'], [learningToolsMethod, 'learning-tools-v1']] as const;
  const lanes = [
    { queue, route: undefined, run: executeDefault },
    { queue: capabilityTaskQueue(queue, 'correction-retest-v1'), route: { deriver: correctionRetestDeriver }, run: executeResearch },
    ...protectedLanes.map(([deriver, lane]) => ({
      queue: capabilityTaskQueue(queue, lane), route: { deriver },
      async run(ref: WorkRef, terminal: boolean) {
        if ((await readWork(db, ref))?.deriver !== deriver) return;
        await (terminal ? recordTerminalFailure(db, ref) : teachWork(ref));
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
    let failed = false, workers;
    try {
      workers = await Promise.all(lanes.map(lane => {
        async function run(id: string, terminal = false, cause?: WorkFailureCause) {
          const ref = await acknowledgeStartedWork(db, id, lane.route);
          if (ref) await lane.run(ref, terminal, cause);
        }
        return createWorkWorker(run, {
          ...workerConfig, taskQueue: lane.queue, deploymentName: lane.queue,
          ...(lane.route ? {} : { advanceCoordinator: advanceWithMaintenance }),
          onTerminalFailure: (id, cause) => run(id, true, cause),
          ...(lane.route === notionBlockRoute && {
            isRemoteUnavailable: (e: unknown): e is unknown => e instanceof NotionReadTemporaryFailure,
          }),
        });
      }));
    } catch (error) { await connection.close().catch(() => {}); throw error; }
    const runs = workers.map(({ worker }) => worker.run());
    void Promise.all(runs).catch(error => {
      if (!signal.aborted) { failed = true; console.error('Temporal Worker 中断，准备重连。', error instanceof Error ? error.name : 'error'); }
    });
    if (process.env.MANGEKYO_ACTIVATE_LOCAL_BUILD === '1') {
      try { await Promise.all(lanes.map(lane => activateLocalDeployment(client, workerConfig, lane.queue))); }
      catch (error) { failed = true; console.error('构建激活失败，准备重连。', error instanceof Error ? error.name : 'error'); }
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
    return { connection, client, workers, runs, relaying: Promise.all(lanes.map(relay)).then(() => undefined), roundFailed: () => failed };
  }
  let round: WorkerRound | undefined;
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  const stop = async () => { stopEvents?.(); server?.close(); await closeRound(round); await pythonHost.close(); await db.close(); };
  try {
    while (!signal.aborted) {
      try {
        round = await startRound();
      } catch (error) {
        await closeRound(round);
        round = undefined;
        if (signal.aborted) break;
        if (!await reconnectBackoff(error, 'Temporal 暂不可达，后台将持续重连；本地界面不受影响。', signal)) break;
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
        if (!await reconnectBackoff(undefined, 'Temporal 连接中断，后台将持续重连。', signal)) break;
      } else break;
    }
  } finally {
    await stop();
  }
}
