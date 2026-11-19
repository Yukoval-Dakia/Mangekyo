import type { Client } from '@temporalio/client';
import { startOrWakeCoordinator } from '../../executors/temporal/src/index.ts';
import type { AdvanceCoordinator } from '../../executors/temporal/src/worker.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, readReadyWork, readWork, type WorkRef,
} from '../../kernel/src/work/index.ts';
import {
  cancelResearchTodos, checkTodoTriggers, completeTodo, emitTodo, endDispatchedTodo, enqueueWork, newFactWatermark,
  readTodo, recordTodoEvent, saveFactWatermark, todoSlot, type TodoInput, type TodoSpec,
} from '../../kernel/src/work/todos.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { setWorkbookResearchUse, workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  configureResearch, publishWorksheet, readResearchBasis, ResearchBasisChanged, researchOrder, researchPurpose,
  researchSettings, researchSettingsType, worksheetDraft,
} from '../../modules/companion/research.ts';
import { stableId, studioLearner } from './identity.ts';
import {
  readWorksheet, researchReader, reviewEvidence, whenAvailable, workbookSource, worksheetId, type ReviewEvidence,
} from './research-sources.ts';
import { clientRequest, RequestError } from './sessions.ts';

const scope = { learner: studioLearner };
const settingsId = factId(stableId('research-settings', studioLearner));
const wakeSlot = 'companion.researchWake';
const wake = { slotType: wakeSlot, slotKey: settingsId, deriver: 'studio/research-wake-v1' };
const reviewGoal = '为一份正式错题作答准备复习单';
const retrySheetLifetimeMs = 24 * 60 * 60 * 1000;
const idleRecheckMs = 60_000;

/** Local execution under the zero-cost policy. Pi transport needs effect and budget admission. */
export type ResearchAgent = (source: ReviewEvidence) =>
  ReturnType<typeof worksheetDraft> | Promise<ReturnType<typeof worksheetDraft>>;

const deterministicReview: ResearchAgent = ({ questionNumber, feedback }) => ({
  title: `第 ${questionNumber} 题复习`,
  steps: [
    '这次原答与冻结卷面的判分规则不符。先盖住上次的答案和参考答案，独立重做一遍。',
    feedback.expected.kind === 'numeric'
      ? '写下用于求值的式子，再检查代入、运算和单位。'
      : '写下决定答案的题干条件，再检查回答是否满足每一项。',
    '做完后对照来源里的原答和参考答案，找出第一次出现差异的地方，记下一项下次要检查的内容。',
  ],
});

async function settings(tx: ReadTransaction) {
  return whenAvailable(async () => {
    const fact = await researchReader(tx).fact(settingsId, { mode: 'following' });
    return { ...researchSettings(fact.value), revision: fact.ref.rev };
  });
}

function reviewDedupKey({ id, revision, accessEpoch }: TodoSpec['sourceFactRev']) {
  return 'review-attempt:' + id + ':' + revision + ':' + accessEpoch;
}

async function eligibleBasis(tx: ReadTransaction, spec: TodoSpec) {
  // The installed executor serves zero-cost retry sheets only. Other profiles and tiers need their own admission.
  if (spec.workerProfile !== 'deterministic_compute' || spec.goal !== reviewGoal || spec.budgetCap !== 0 ||
      spec.autonomyTier !== 1 || spec.expiresAtMs <= Date.now() || !spec.sourceFactRev.anchor) return null;
  return whenAvailable(async () => {
    const { id, revision, accessEpoch, anchor } = spec.sourceFactRev;
    if (spec.dedupKey !== reviewDedupKey(spec.sourceFactRev)) return null;
    const basis = researchOrder({ settingsId, settingsRevision: spec.settingsRevision,
      source: { attemptId: id, revision, accessEpoch, questionId: anchor } });
    const read = researchReader(tx);
    for (const ref of spec.refs) {
      const fact = await read.fact(ref.id, { mode: 'following' });
      if (fact.ref.rev !== ref.revision || fact.accessEpoch !== ref.accessEpoch) return null;
    }
    const source = await readResearchBasis(read, basis);
    if (workbookAttempt(source.value).feedback.find(item => item.result === 'incorrect')?.questionId !== anchor) return null;
    return { basis, source };
  });
}

async function triage(tx: ReadTransaction, reviewed: Tick, settingsRevision: number, now: number): Promise<TodoInput | null> {
  // A completion can release a linked event Todo, but it cannot open a fresh chain from old evidence.
  const fresh = await tx.query(
    `SELECT 1 FROM facts WHERE learner_id = $1 AND changed_tick > $2
     AND (type = $3 OR (type = $4 AND $5 = ANY(purpose) AND retracted_rev IS NULL)) LIMIT 1`,
    [tx.learner, reviewed, researchSettingsType, workbookAttemptType, researchPurpose],
  );
  if (!fresh.rowCount) return null;
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM facts WHERE learner_id = $1 AND type = $2
     AND $3 = ANY(purpose) AND retracted_rev IS NULL ORDER BY created_tick DESC, id`,
    [tx.learner, workbookAttemptType, researchPurpose],
  );
  const read = researchReader(tx);
  for (const row of rows) {
    const id = factId(row.id);
    const attempt = await read.fact(id, { mode: 'following' });
    const feedback = workbookAttempt(attempt.value).feedback.find(item => item.result === 'incorrect');
    if (!feedback) continue;
    const sourceFactRev = { id, revision: attempt.ref.rev, accessEpoch: attempt.accessEpoch, anchor: feedback.questionId };
    const resultId = worksheetId(id, attempt.ref.rev, attempt.accessEpoch);
    const dedupKey = reviewDedupKey(sourceFactRev);
    const known = await tx.query(
      `SELECT 1 FROM facts WHERE learner_id = $1 AND id = $2
       UNION ALL SELECT 1 FROM working_todos WHERE learner_id = $1 AND dedup_key = $3
        AND spec->'sourceFactRev' = $4::jsonb AND spec->>'settingsRevision' = $5 LIMIT 1`,
      [tx.learner, resultId, dedupKey, JSON.stringify(sourceFactRev), String(settingsRevision)],
    );
    if (!known.rowCount) return {
      dedupKey, workerProfile: 'deterministic_compute', trigger: { kind: 'immediate' },
      goal: reviewGoal, refs: [], sourceFactRev, settingsRevision, autonomyTier: 1, budgetCap: 0,
      expiresAtMs: now + retrySheetLifetimeMs,
    };
  }
  return null;
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

export function openResearch(db: Db, activity: LoadedModule, companion: LoadedModule, agent?: ResearchAgent) {
  const generate = agent ?? deterministicReview;
  const handle = createCommandHandler(db, {
    modules: [activity, companion],
    hooks: { async onFactsChanged(tx, tick, changes) {
      for (const change of changes) {
        if (change.factType === researchSettingsType) {
          await cancelResearchTodos(tx);
          await enqueueWork(tx, tick, wake);
        } else if (change.factType === workbookAttemptType && (await settings(tx))?.enabled) {
          await enqueueWork(tx, tick, wake);
        }
      }
    } },
  });

  const read = () => db.snapshot(scope, async tx => {
    const current = await settings(tx);
    return { enabled: current?.enabled ?? false, revision: current?.revision ?? 0, paidBudget: 0 };
  });
  const permission = (paperId: string, attemptId: string) => db.snapshot(scope, async tx => {
    const fact = await workbookSource(tx, paperId, attemptId);
    return { allowed: fact.purpose.includes(researchPurpose), revision: fact.ref.rev };
  });

  const workbookChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
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

  const advance: AdvanceCoordinator = async ({ coordinatorRef }, signal) => db.tx(scope, async tx => {
    await lockLearner(tx, tx.learner);
    const current = await settings(tx);
    if (!current?.enabled || current.coordinatorRef !== coordinatorRef) return { status: 'disabled' };
    signal.throwIfAborted();
    const now = Date.now();
    const eligible = async (spec: TodoSpec) => (await eligibleBasis(tx, spec)) !== null;
    const due = await checkTodoTriggers(tx, now, eligible);
    if (due.advanced) return { status: 'advanced' };
    const watermark = await newFactWatermark(tx);
    if (watermark !== null) {
      const intent = await triage(tx, watermark.reviewed, current.revision, now);
      if (intent) await tx.withLearnerWrite(tick => emitTodo(tx, tick, intent, now, eligible));
      await saveFactWatermark(tx, watermark.observed);
    }
    return { status: 'waiting', recheckAtMs: Math.min(due.nextAt ?? Infinity, now + idleRecheckMs) };
  });

  return {
    read,
    async configure(input: Record<string, unknown>) {
      const { requestId, revision, value: enabled } = settingInput(input, 0, 'enabled');
      await updateSettings(() => handle({
        ...scope, actor: 'learner', purpose: researchPurpose, type: configureResearch,
        id: commandId(stableId('configure-research', requestId)), input: { id: settingsId, revision, enabled },
      }));
      return read();
    },
    permission,
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
        await failWork(db, ref, tx => endDispatchedTodo(tx, todoId, 'failed'));
        return true;
      }
      const prepared = await db.snapshot(scope, async tx => {
        if (!(await readReadyWork(tx, ref))) return null;
        const todo = await readTodo(tx, todoId);
        if (!todo || todo.state !== 'dispatched') return todo?.state === 'completed' ? { status: 'completed' } as const : null;
        const eligible = await eligibleBasis(tx, todo.spec);
        if (!eligible) return null;
        const { basis, source } = eligible;
        const { attemptId, revision, accessEpoch, questionId } = basis.source;
        const id = worksheetId(attemptId, revision, accessEpoch);
        return { status: 'ready', todo, id, basis, evidence: reviewEvidence(source.value, questionId) } as const;
      });
      const cancel = () => cancelWork(db, ref, tx => endDispatchedTodo(tx, todoId, 'cancelled'));
      if (!prepared) {
        await cancel();
        return true;
      }
      if (prepared.status === 'ready') {
        const draft = worksheetDraft(await generate(prepared.evidence));
        const publish = createCommandHandler(db, {
          modules: [companion],
          hooks: { async onFactsChanged(tx, tick) {
            const current = await readTodo(tx, todoId);
            if (current?.revision !== prepared.todo.revision || !(await readReadyWork(tx, ref)) ||
                !(await eligibleBasis(tx, current.spec)) || !await completeTodo(tx, tick, current, prepared.id))
              throw new ResearchBasisChanged('工作单已失效。');
            await enqueueWork(tx, tick, wake);
          } },
        });
        const receipt = await whenAvailable(() => publish({
          ...scope, actor: 'companion', purpose: researchPurpose, type: publishWorksheet,
          id: commandId(stableId('publish-worksheet', prepared.id)),
          input: { id: prepared.id, todoId, basis: prepared.basis, draft,
            method: agent ? 'local-agent' : 'deterministic-v1', questionNumber: prepared.evidence.questionNumber },
        }));
        if (!receipt) {
          await cancel();
          return true;
        }
      }
      await finishWork(db, ref);
      return true;
    },
  };
}
