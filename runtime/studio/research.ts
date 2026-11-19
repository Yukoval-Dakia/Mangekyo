import type { Client } from '@temporalio/client';
import { startOrWakeCoordinator } from '../../executors/temporal/src/index.ts';
import type { AdvanceCoordinator } from '../../executors/temporal/src/worker.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import {
  acknowledgeStartedWork, cancelWork, failWork, finishWork, readReadyWork, readWork, requestWork, type WorkRef, type WorkRequest,
} from '../../kernel/src/work/index.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { setWorkbookResearchUse, workbookAttempt, workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import {
  configureResearch, prepareResearch, publishWorksheet, readResearchBasis, ResearchBasisChanged,
  researchOrder, researchOrderType, researchPurpose, researchSettings, researchSettingsType, worksheetDraft,
} from '../../modules/companion/research.ts';
import { stableId, studioLearner } from './identity.ts';
import {
  readWorksheet, researchReader, reviewEvidence, whenAvailable, workbookSource, worksheetId, type ReviewEvidence,
} from './research-sources.ts';
import { clientRequest, RequestError } from './sessions.ts';

const scope = { learner: studioLearner };
const settingsId = factId(stableId('research-settings', studioLearner));
const wakeSlot = 'companion.researchWake';
const worksheetSlot = 'companion.researchDelivery';
const wake = { slotType: wakeSlot, slotKey: settingsId, deriver: 'studio/research-wake-v1' };

async function enqueue(tx: DbTransaction, tick: Tick, work: WorkRequest) {
  await tx.query(
    `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
     VALUES ($1, $2, $3, '{}', $4) ON CONFLICT (learner_id, slot_type, slot_key) DO NOTHING`,
    [tx.learner, work.slotType, work.slotKey, tick],
  );
  return requestWork(tx, tick, work);
}

/** Runs entirely locally under the zero-cost policy. Pi transport needs its own effect and budget admission. */
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

async function hasActiveOrder(tx: ReadTransaction) {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM work WHERE learner_id = $1 AND slot_type = $2 AND state = 'ready' LIMIT 1",
    [tx.learner, worksheetSlot],
  );
  return rowCount > 0;
}

function waitForWork() {
  return { status: 'waiting', recheckAtMs: Date.now() + 5000 } as const;
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
        if (change.factType === researchSettingsType ||
            (change.factType === workbookAttemptType && (await settings(tx))?.enabled)) {
          await enqueue(tx, tick, wake);
        }
        if (change.factType === researchOrderType) {
          if (await hasActiveOrder(tx)) throw new ResearchBasisChanged('已有教研工作单在执行。');
          await enqueue(tx, tick, { slotType: worksheetSlot, slotKey: change.ref.id, deriver: 'studio/review-v1' });
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

  const advance: AdvanceCoordinator = async ({ coordinatorRef }, signal) => {
    const next = await db.snapshot(scope, async tx => {
      const current = await settings(tx);
      if (!current?.enabled || current.coordinatorRef !== coordinatorRef) return { status: 'disabled' } as const;
      if (await hasActiveOrder(tx)) return waitForWork();
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM facts WHERE learner_id = $1 AND type = $2
         AND $3 = ANY(purpose) AND retracted_rev IS NULL ORDER BY created_tick DESC, id`,
        [tx.learner, workbookAttemptType, researchPurpose],
      );
      const available = researchReader(tx);
      for (const row of rows) {
        const attemptId = factId(row.id);
        const attempt = await available.fact(attemptId, { mode: 'following' });
        const feedback = workbookAttempt(attempt.value).feedback.find(item => item.result === 'incorrect');
        if (!feedback) continue;
        const resultId = worksheetId(attemptId, attempt.ref.rev, attempt.accessEpoch);
        const orderId = factId(stableId('research-order-v1', resultId, String(current.revision)));
        const known = await tx.query(
          'SELECT 1 FROM facts WHERE learner_id = $1 AND id IN ($2, $3) LIMIT 1',
          [tx.learner, resultId, orderId],
        );
        if (!known.rowCount) {
          return { orderId, data: {
            settingsId, settingsRevision: current.revision,
            source: { attemptId, revision: attempt.ref.rev, accessEpoch: attempt.accessEpoch, questionId: feedback.questionId },
          } };
        }
      }
      return { status: 'waiting' } as const;
    });
    if ('status' in next) return next;
    signal.throwIfAborted();
    const prepared = await whenAvailable(() => handle({
      ...scope, actor: 'companion', purpose: researchPurpose, type: prepareResearch,
      id: commandId(stableId('prepare-research', next.orderId)), input: { id: next.orderId, data: next.data },
    }));
    return prepared ? { status: 'advanced' } : waitForWork();
  };

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
        if (!pending.rowCount) await tx.withLearnerWrite(tick => enqueue(tx, tick, wake));
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
      if (work.slotType !== worksheetSlot) return false;
      if (terminal) {
        await failWork(db, ref);
        return true;
      }
      const orderId = factId(work.slotKey);
      const prepared = await db.snapshot(scope, tx => whenAvailable(async () => {
        if (!(await readReadyWork(tx, ref))) return null;
        const read = researchReader(tx);
        const order = researchOrder((await read.fact(orderId, { mode: 'following' })).value);
        const attempt = await readResearchBasis(read, order);
        const { attemptId, revision, accessEpoch, questionId } = order.source;
        const id = worksheetId(attemptId, revision, accessEpoch);
        const delivered = await whenAvailable(() => read.fact(id, { mode: 'following' }));
        return { id, evidence: delivered ? null : reviewEvidence(attempt.value, questionId) };
      }));
      if (!prepared) {
        await cancelWork(db, ref);
        return true;
      }
      if (prepared.evidence) {
        const draft = worksheetDraft(await generate(prepared.evidence));
        const publish = createCommandHandler(db, {
          modules: [companion],
          hooks: { async onFactsChanged(tx) {
            if (!(await readReadyWork(tx, ref))) throw new ResearchBasisChanged('工作单已失效。');
          } },
        });
        const receipt = await whenAvailable(() => publish({
          ...scope, actor: 'companion', purpose: researchPurpose, type: publishWorksheet,
          id: commandId(stableId('publish-worksheet', prepared.id)),
          input: { id: prepared.id, orderId, draft, method: agent ? 'local-agent' : 'deterministic-v1' },
        }));
        if (!receipt) {
          await cancelWork(db, ref);
          return true;
        }
      }
      await finishWork(db, ref);
      return true;
    },
  };
}
