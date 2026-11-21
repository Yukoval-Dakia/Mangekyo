import type { Client } from '@temporalio/client';
import { startOrWakeCoordinator } from '../../executors/temporal/src/index.ts';
import type { AdvanceCoordinator } from '../../executors/temporal/src/worker.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { consumePricedEffect, effectBudgetUsage } from '../../kernel/src/work/effects.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, readReadyWork, readWork, type WorkRef,
} from '../../kernel/src/work/index.ts';
import {
  cancelResearchTodos, checkTodoTriggers, completeTodo, emitTodo, enqueueWork,
  readTodo, recordTodoEvent, saveFactWatermark, todoSlot, type TodoSpec,
} from '../../kernel/src/work/todos.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { workbookCorrectionType } from '../../modules/activity/workbook-correction.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { setWorkbookResearchUse, workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import {
  allowRetentionReview, configureResearch, deterministicReview, publishWorksheet, readResearchBasis, ResearchBasisChanged, researchOrder,
  researchPurpose, retentionReviewDraft, researchScoutBudget, researchSettings, researchSettingsType, retentionReviewPermission, retentionReviewPermissionType, worksheetDraft,
} from '../../modules/companion/research.ts';
import { stableId, studioLearner } from './identity.ts';
import { readMissedPosttest } from './learner-radar.ts';
import { newResearchWatermark } from './research-foreground.ts';
import {
  activeRetentionReview, independentScoutSource, reviewMaterialAvailable, readWorksheet, readWorksheetById, researchReader, retentionReviewAnchor,
  retentionReviewPermissionId, reviewEvidence, whenAvailable, workbookSource, worksheetId, type ReviewEvidence,
} from './research-sources.ts';
import {
  preparePaidResearchTriage, prepareResearchTriage, reviewDedupKey, reviewGoal, researchDecision,
  scoutEffectIdentity,
} from './research-triage-host.ts';
import { sampleResearchScout, ScoutAuthorizationChanged, type ResearchScoutHost } from './research-scout.ts';
import { discoverUnderstandingTodos, eligibleExtraction, openUnderstandingExtraction, type UnderstandingTransport } from './research-understanding.ts';
import { activityEvidenceTypes, turnEvidenceType } from '../../modules/companion/activity-evidence.ts';
import { extractorProfile } from '../../modules/companion/understanding.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { correctionRetestDeriver, eligibleCorrectionRetest, executeCorrectionRetest, registerCorrectionRetest, type CorrectionRetestAuthority } from './research-correction.ts';

const scope = { learner: studioLearner };
const settingsId = factId(stableId('research-settings', studioLearner));
const wakeSlot = 'companion.researchWake';
const wake = { slotType: wakeSlot, slotKey: settingsId, deriver: 'studio/research-wake-v1' };
const idleRecheckMs = 60_000;

/** Local execution under the zero-cost policy. Pi transport needs effect and budget admission. */
export type ResearchAgent = (source: ReviewEvidence) =>
  ReturnType<typeof worksheetDraft> | Promise<ReturnType<typeof worksheetDraft>>;

async function settings(tx: ReadTransaction) {
  return whenAvailable(async () => {
    const fact = await researchReader(tx).fact(settingsId, { mode: 'following' });
    const { enabled, coordinatorRef, scoutConsent } = researchSettings(fact.value);
    return { enabled, coordinatorRef, scoutBudget: scoutConsent, revision: fact.ref.rev };
  });
}

async function eligibleBasis(tx: ReadTransaction, spec: TodoSpec) {
  const { id, revision, accessEpoch, anchor } = spec.sourceFactRev;
  // The installed executor serves zero-cost retry sheets only. Other profiles and tiers need their own admission.
  if (spec.workerProfile !== 'deterministic_compute' || spec.goal !== reviewGoal || spec.budgetCap !== 0 ||
      spec.autonomyTier !== 1 || spec.expiresAtMs <= Date.now() || !anchor) return null;
  return whenAvailable(async () => {
    if (spec.dedupKey !== reviewDedupKey(spec.sourceFactRev)) return null;
    const basis = researchOrder({ settingsId, settingsRevision: spec.settingsRevision,
      source: { attemptId: id, revision, accessEpoch, questionId: anchor } });
    const read = researchReader(tx);
    for (const ref of spec.refs) {
      const fact = await read.fact(ref.id, { mode: 'following' });
      if (fact.ref.rev !== ref.revision || fact.accessEpoch !== ref.accessEpoch) return null;
    }
    const source = await readResearchBasis(read, basis);
    if (source.type === retentionReviewPermissionType) {
      if (anchor !== retentionReviewAnchor || !await activeRetentionReview(tx, source)) return null;
      return { basis, evidence: null };
    }
    if (source.type !== workbookAttemptType ||
        workbookAttempt(source.value).feedback.find(item => item.result === 'incorrect')?.questionId !== anchor) return null;
    if (!await reviewMaterialAvailable(tx, workbookAttempt(source.value).paper)) return null;
    return { basis, evidence: reviewEvidence(source.value, anchor) };
  });
}

function settingInput(input: Record<string, unknown>, minimum: number, field: 'enabled' | 'allowed') {
  const { revision } = input;
  const value = input[field];
  if (typeof value !== 'boolean' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < minimum)
    throw new RequestError(400, '请提交明确的教研开关和原版本。');
  return { requestId: clientRequest(input.requestId), revision, value };
}

async function updateSettings<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && /Fact revision conflict|Fact already exists|Command ID already used/.test(error.message))
      throw new RequestError(409, '教研设置或原作用途已更新，请重新核对。');
    throw error;
  }
}

export function openResearch(db: Db, activity: LoadedModule, companion: LoadedModule,
  agent?: ResearchAgent, scoutHost?: ResearchScoutHost, understandingTransport?: UnderstandingTransport,
  correctionAuthority?: CorrectionRetestAuthority) {
  const extract = openUnderstandingExtraction(db, companion, understandingTransport);
  const settingsCurrent = async (tx: ReadTransaction, revision: number) => {
    const current = await settings(tx);
    return current?.enabled === true && current.revision === revision;
  };
  const hooks: CommandHooks = { async onFactsChanged(tx, tick, changes) {
    for (const change of changes) {
      if (change.factType === researchSettingsType) {
        await cancelResearchTodos(tx);
        await enqueueWork(tx, tick, wake);
      } else if ((change.factType === workbookAttemptType || change.factType === retentionReviewPermissionType) &&
          (await settings(tx))?.enabled) {
        await enqueueWork(tx, tick, wake);
      }
    }
  } };
  const handle = createCommandHandler(db, { modules: [activity, companion], hooks });

  const read = () => db.snapshot(scope, async tx => {
    const current = await settings(tx);
    const budget = current?.scoutBudget;
    const { held, settled } = await effectBudgetUsage(tx);
    return { enabled: current?.enabled ?? false, revision: current?.revision ?? 0, paidBudget: budget?.limitMicros ?? 0,
      ...(scoutHost && {scoutOffer: {route: scoutHost.route, maxRetentionDays: scoutHost.retentionDays,
        maxPerCallMicros: scoutHost.reserveUsdMicros}}),
      ...(budget || held > 0n || settled > 0n ? { scoutBudget: budget ?? null, unit: 'USD_MICROS',
        heldUsdMicros: held.toString(), settledUsdMicros: settled.toString() } : {}) };
  });
  const permission = (paperId: string, attemptId: string) => db.snapshot(scope, async tx => {
    const fact = await workbookSource(tx, paperId, attemptId);
    return { allowed: fact.purpose.includes(researchPurpose), revision: fact.ref.rev };
  });

  const readRetentionPermission = (tx: ReadTransaction, key: string) =>
    whenAvailable(() => researchReader(tx).fact(retentionReviewPermissionId(key), { mode: 'following' }));

  const retentionReview = (key: string) => db.snapshot(scope, async tx => {
    const enabled = (await settings(tx))?.enabled ?? false;
    const fact = await readRetentionPermission(tx, key);
    const active = fact && await activeRetentionReview(tx, fact);
    const opened = enabled && active && await readWorksheetById(tx, worksheetId(fact.ref.id, fact.ref.rev, fact.accessEpoch));
    return { enabled, revision: fact?.ref.rev ?? 0, allowed: Boolean(active),
      worksheet: opened ? opened.worksheet : null };
  });

  const workbookChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
    const correction = changes.find(change => change.factType === workbookCorrectionType && change.kind === 'create');
    if (correction) {
      const current = await settings(tx);
      if (current?.enabled && await registerCorrectionRetest(tx, tick, correction.ref.id, current.revision, settingsId))
        await enqueueWork(tx, tick, wake);
    }
    const created = changes.find(change => change.factType === workbookAttemptType && change.kind === 'create');
    if (!created || !(await settings(tx))?.enabled) return;
    const permitted = await tx.query(
      `SELECT 1 FROM facts WHERE learner_id=$1 AND id=$2 AND current_rev=$3
        AND $4=ANY(purpose) AND retracted_rev IS NULL`,
      [tx.learner, created.ref.id, created.ref.rev, researchPurpose],
    );
    if (!permitted.rowCount) return;
    const fact = await whenAvailable(() => researchReader(tx).fact(created.ref.id, { mode: 'pinned', rev: created.ref.rev }));
    if (!fact) return;
    await recordTodoEvent(tx, tick, { type: 'on_attempt_submitted', subject: workbookAttempt(fact.value).paperId });
    await enqueueWork(tx, tick, wake);
  };

  const activityChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
    if (extract && changes.some(change => change.factType !== turnEvidenceType &&
        (activityEvidenceTypes.includes(change.factType) || change.kind === 'set_purpose' &&
          [workbookPaperType, workspaceEntryType].includes(change.factType)) && change.kind !== 'retract') &&
        (await settings(tx))?.enabled) await enqueueWork(tx, tick, wake);
  };

  const turnCompleted = async (tx: DbTransaction, tick: Tick, id: string) => {
    if (extract && (await settings(tx))?.enabled &&
        await whenAvailable(() => researchReader(tx).fact(factId(id), {mode: 'following'}))) await enqueueWork(tx, tick, wake);
  };

  const advance: AdvanceCoordinator = async ({ coordinatorRef }, signal) => {
    const scan = await db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const current = await settings(tx);
      if (!current?.enabled || current.coordinatorRef !== coordinatorRef) return { status: 'disabled' } as const;
      signal.throwIfAborted();
      const now = Date.now();
      const eligible = async (spec: TodoSpec) => (await (extract && spec.workerProfile === extractorProfile
        ? eligibleExtraction(tx, spec, understandingTransport?.maySend) : eligibleBasis(tx, spec))) !== null;
      const due = await checkTodoTriggers(tx, now, (spec, route) => route === correctionRetestDeriver
        ? eligibleCorrectionRetest(tx, spec, current.revision, now, correctionAuthority) : eligible(spec), correctionRetestDeriver);
      if (due.advanced) return { status: 'advanced' } as const;
      const waiting = { status: 'waiting', recheckAtMs: Math.min(due.nextAt ?? Infinity, now + idleRecheckMs) } as const;
      const watermark = await newResearchWatermark(tx);
      if (watermark) {
        if (extract) {
          const todos = await discoverUnderstandingTodos(tx, watermark.reviewed, current.revision, now, understandingTransport?.maySend);
          if (todos.length) {
            await tx.withLearnerWrite(async tick => {
              for (const spec of todos) await emitTodo(tx, tick, spec, now, eligible);
            });
            return { status: 'advanced' } as const;
          }
        }
        const local = await prepareResearchTriage(tx, watermark.reviewed, current.revision, now, Boolean(current.scoutBudget), eligible);
        if (local?.intent && researchDecision(local) === 'review') {
          const todo = local.intent;
          await tx.withLearnerWrite(tick => emitTodo(tx, tick, todo, now, eligible));
          return { status: 'advanced' } as const;
        }
        await saveFactWatermark(tx, watermark.observed);
      }
      const budget = current.scoutBudget;
      if (!budget || scoutHost?.route !== budget.route || budget.expiresAtMs <= Date.now()) return waiting;
      const prepared = await preparePaidResearchTriage(tx, settingsId, current.revision, now);
      return prepared ? { status: 'sample', prepared, waiting, settingsRevision: current.revision, budget } as const : waiting;
    });
    if (scan.status !== 'sample' || !scoutHost) return scan.status === 'sample' ? scan.waiting : scan;
    signal.throwIfAborted();
    const { budget, prepared, settingsRevision } = scan;
    const authorizeScout = async (tx: ReadTransaction) => {
      const current = await settings(tx);
      if (current?.enabled !== true || current.revision !== settingsRevision ||
          current.coordinatorRef !== coordinatorRef || !(await eligibleBasis(tx, prepared.intent)))
        throw new ScoutAuthorizationChanged();
      const { id } = prepared.intent.sourceFactRev;
      const source = await whenAvailable(() => researchReader(tx).fact(id, { mode: 'following' }));
      if (!source || !await independentScoutSource(tx, source) || budget.expiresAtMs <= Date.now())
        throw new ScoutAuthorizationChanged();
    };
    const review = await sampleResearchScout(db, settingsId, settingsRevision, budget, scoutHost,
      prepared, authorizeScout, signal);
    if (review === undefined) return scan.waiting;
    return db.tx(scope, async tx => {
      signal.throwIfAborted();
      const consumed = await consumePricedEffect(tx, scoutEffectIdentity(settingsId, prepared.intent.dedupKey), review === 'superseded' ? 'discard' : async tick => {
        if (!review) return null;
        try {
          await authorizeScout(tx);
        } catch (error) {
          if (error instanceof ScoutAuthorizationChanged) return null;
          throw error;
        }
        return (await emitTodo(tx, tick, prepared.intent, Date.now(), async spec => Boolean(await eligibleBasis(tx, spec))))?.id ?? null;
      });
      return consumed ? { status: 'advanced' } : scan.waiting;
    });
  };

  return {
    read,
    async configure(input: Record<string, unknown>) {
      const { requestId, revision, value: enabled } = settingInput(input, 0, 'enabled');
      let scoutBudget: ReturnType<typeof researchScoutBudget> | undefined;
      try {
        if (input.scoutBudget !== undefined) scoutBudget = researchScoutBudget(input.scoutBudget);
      } catch {
        throw new RequestError(400, '前哨额度、到期时间、服务标识或留存天数无效。');
      }
      await updateSettings(() => handle({
        ...scope, actor: 'learner', purpose: researchPurpose, type: configureResearch,
        id: commandId(stableId('configure-research', requestId)), input: { id: settingsId, revision, enabled, ...(scoutBudget !== undefined && { scoutBudget }) },
      }));
      return read();
    },
    permission,
    retentionReview,
    async allowRetentionReview(key: string, input: Record<string, unknown>) {
      const { requestId, revision, value: allowed } = settingInput(input, 0, 'allowed');
      await updateSettings(() => db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        const previous = await readRetentionPermission(tx, key);
        const resultId = allowed ? await readMissedPosttest(tx, key)
          : previous && retentionReviewPermission(previous.value).resultId;
        if (!resultId) throw new RequestError(409, '当前没有可授权的独立后测偏差。');
        const handlePermission = createCommandHandler(withinLearnerTransaction(db, tx), { modules: [companion], hooks });
        await handlePermission({ ...scope, actor: 'learner', purpose: researchPurpose, type: allowRetentionReview,
          id: commandId(stableId('allow-retention-review', key, requestId)),
          input: { id: retentionReviewPermissionId(key), revision, permission: { key, resultId, allowed } } });
      }));
      return retentionReview(key);
    },
    async allow(paperId: string, attemptId: string, input: Record<string, unknown>) {
      const { requestId, revision, value: allowed } = settingInput(input, 1, 'allowed');
      await permission(paperId, attemptId);
      const receipt = await whenAvailable(() => updateSettings(() => handle({
        ...scope, actor: 'learner', purpose: storagePurpose, type: setWorkbookResearchUse,
        id: commandId(stableId('workbook-research-use', attemptId, requestId)),
        input: { paperId, attemptId, revision, allowed },
      })));
      if (!receipt) throw new RequestError(404, '找不到这次作答。');
      return permission(paperId, attemptId);
    },
    worksheet: (paperId: string, attemptId: string) =>
      db.snapshot(scope, async tx => (await readWorksheet(tx, paperId, attemptId))?.worksheet ?? null),
    async source(paperId: string, attemptId: string, id: string) {
      const result = await db.snapshot(scope, tx => readWorksheet(tx, paperId, attemptId));
      if (result?.worksheet.id !== id) throw new RequestError(404, '这份复习依据当前不可读。');
      return result.source;
    },
    workbookChanged,
    activityChanged,
    turnCompleted,
    advance,
    async reconcile() {
      await db.tx(scope, async tx => {
        if (!(await settings(tx))?.enabled) return;
        await lockLearner(tx, tx.learner);
        if (!(await settings(tx))?.enabled) return;
        const pending = await tx.query(
          `SELECT 1 FROM work w JOIN work_outbox o ON o.intent_id = w.execution_ref
           WHERE w.learner_id = $1 AND w.slot_type = $2 AND w.state = 'ready' AND o.state = 'pending'`,
          [tx.learner, wakeSlot],
        );
        if (!pending.rowCount) await tx.withLearnerWrite(tick => enqueueWork(tx, tick, wake));
      });
    },
    async relayWake(client: Client, taskQueue: string, ref: WorkRef, id: string) {
      const work = await readWork(db, ref);
      if (!work) return true;
      if (work.slotType !== wakeSlot) return false;
      const current = await db.snapshot(scope, settings);
      if (current) await startOrWakeCoordinator(client, current.coordinatorRef, id, { taskQueue });
      await acknowledgeStartedWork(db, id);
      await finishWork(db, ref);
      return true;
    },
    async execute(ref: WorkRef, terminal = false) {
      const work = await readWork(db, ref);
      if (!work) return true;
      if (work.slotType === 'companion.researchDelivery') {
        await cancelWork(db, ref);
        return true;
      }
      if (work.slotType !== todoSlot) return false;
      const todoId = factId(work.slotKey);
      if (terminal) {
        await failWork(db, ref);
        return true;
      }
      if (work.deriver === extractorProfile) {
        if (extract) await extract(ref, todoId, settingsCurrent);
        else await cancelWork(db, ref);
        return true;
      }
      if (work.deriver === correctionRetestDeriver) {
        await executeCorrectionRetest(db, ref, todoId, settingsCurrent, correctionAuthority);
        return true;
      }
      const prepared = await db.snapshot(scope, async tx => {
        if (!(await readReadyWork(tx, ref))) return null;
        const todo = await readTodo(tx, todoId);
        if (todo?.state !== 'dispatched') return null;
        const eligible = await eligibleBasis(tx, todo.spec);
        if (!eligible) return null;
        const { basis, evidence } = eligible;
        const { attemptId, revision, accessEpoch } = basis.source;
        const id = worksheetId(attemptId, revision, accessEpoch);
        return { todo, id, basis, evidence };
      });
      if (!prepared) {
        await cancelWork(db, ref);
        return true;
      }
      const draft = worksheetDraft(prepared.evidence ? await (agent ?? deterministicReview)(prepared.evidence) : retentionReviewDraft);
      const publish = createCommandHandler(db, {
        modules: [companion],
        hooks: { async onFactsChanged(tx, tick) {
          const current = await readTodo(tx, todoId);
          if (current?.revision !== prepared.todo.revision || !(await readReadyWork(tx, ref)) ||
              !(await eligibleBasis(tx, current.spec)) || !await completeTodo(tx, tick, ref, current, prepared.id))
            throw new ResearchBasisChanged('工作单已失效。');
          await enqueueWork(tx, tick, wake);
        } },
      });
      const receipt = await whenAvailable(() => publish({
        ...scope, actor: 'companion', purpose: researchPurpose, type: publishWorksheet,
        id: commandId(stableId('publish-worksheet', prepared.id)),
        input: { id: prepared.id, todoId, basis: prepared.basis, draft,
          method: agent && prepared.evidence ? 'local-agent' : 'deterministic-v1', questionNumber: prepared.evidence?.questionNumber ?? 1 },
      }));
      if (!receipt) await cancelWork(db, ref);
      return true;
    },
  };
}
