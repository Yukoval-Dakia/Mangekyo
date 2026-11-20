import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHandler, CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, derivationId, factId, type FactId, type Revision, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt, FactRef, Json } from '../../kernel/src/declarations/types.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyKit } from '../../executors/teaching/study-kit.ts';
import { helpExposure, helpExposureRequest, helpExposureType, sameHelpRef, sameHelpTarget, type HelpRef } from '../../modules/activity/help-exposure-values.ts';
import { projectHelpExposure } from '../../modules/activity/help-exposure.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  issueRecallCommand, recallIssuance, recallIssuanceType, recallResponseId, recallSubmission,
  recallSubmissionType, recallTarget, recallText, submitRecallCommand,
} from '../../modules/activity/recall-values.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { gradeWorkbook, workbookRequestId, type WorkbookQuestion } from '../../modules/activity/workbook-values.ts';
import { attachmentCurrent, attachmentSources } from './reading.ts';
import { workspaceGrantChecker } from './harness.ts';
import { purpose, slotType, stableId, studioLearner } from './identity.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from './learning-attempt-read.ts';

export type RecallMount = { turnId: string; derivationId: string; itemId: string };
type DisplayWitness = { mount: RecallMount; revealId: string };
type Issuance = ReturnType<typeof recallIssuance>;
type Item = Issuance['items'][number];
type Submission = ReturnType<typeof recallSubmission>;
const firstRevision = 1 as Revision;

export class RecallRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Existing StudyKits have positional questions. A position is meaningful only in its frozen version. */
export function recallItemId(turnId: string, version: string, position: number): FactId {
  return factId(stableId('recall-item', turnId, version, String(position)));
}

function input<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new RecallRequestError(400, '回忆题请求格式无效。'); }
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('回忆题请求字段无效。');
  }
  return value as Record<string, unknown>;
}

function parseMount(value: unknown) {
  const { turnId, derivationId: version, itemId } = fields(value, ['turnId', 'derivationId', 'itemId']);
  if (typeof turnId !== 'string' || typeof version !== 'string' || typeof itemId !== 'string') {
    throw new Error('回忆题挂载标识无效。');
  }
  return { turnId: factId(turnId), derivationId: derivationId(version), itemId: factId(itemId) };
}

type Mount = ReturnType<typeof parseMount>;

function issuanceRef(mount: Mount): HelpRef {
  return { id: factId(stableId('recall-issuance', mount.turnId, mount.derivationId)), rev: firstRevision };
}

function itemFor(issuance: Issuance, mount: Mount): Item {
  const item = issuance.items.find(item => item.itemId === mount.itemId);
  if (!item || issuance.turn.id !== mount.turnId || issuance.version !== mount.derivationId) {
    throw new RecallRequestError(404, '回忆题与此回合版本不匹配。');
  }
  return item;
}

async function authorized<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (error instanceof FactReadDeniedError) throw new RecallRequestError(403, '回忆题依据已不可读。');
    if (error instanceof FactNotFoundError) throw new RecallRequestError(404, '找不到回忆题记录。');
    throw error;
  }
}

async function optionalPinned(tx: ReadTransaction, ref: HelpRef) {
  try {
    return await createCommandReadContext(tx, storagePurpose).fact(ref.id, { mode: 'pinned', rev: ref.rev });
  } catch (error) {
    if (error instanceof FactNotFoundError) return null;
    throw error;
  }
}

async function readSource(tx: ReadTransaction, mount: Mount, requireCurrent: boolean) {
  const { rows: [row] } = await tx.query<{ value: unknown; manifest: unknown }>(
    `SELECT d.value, d.manifest FROM derivations d
     WHERE d.learner_id=$1 AND d.slot_type=$2 AND d.slot_key=$3 AND d.id=$4
       AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.effective_tick IS NOT NULL
       AND d.lifecycle IN ('effective', 'superseded')
       AND (NOT $5::boolean OR (d.lifecycle='effective' AND EXISTS (
         SELECT 1 FROM slot_state s WHERE s.learner_id=d.learner_id
           AND s.slot_type=d.slot_type AND s.slot_key=d.slot_key AND s.current_id=d.id AND s.last_error IS NULL
       )))`, [tx.learner, slotType, mount.turnId, mount.derivationId, requireCurrent],
  );
  if (!row) throw new RecallRequestError(404, '此回合没有可用的回忆题版本。');
  const read = createCommandReadContext(tx,purpose);
  const turn = await read.fact(mount.turnId,{mode:'following'});
  const submission = studyTurn(turn.value);
  const origin = submission.parentId ? studyTurn((await read.fact(submission.sessionId,{mode:'following'})).value) : submission;
  const grantCurrent = workspaceGrantChecker();
  const manifest = parseManifest(row.manifest);
  if (turn.type !== 'activity.studyTurn' || manifest.purpose !== purpose ||
      !await grantCurrent(submission) || !await grantCurrent(origin) || !await attachmentCurrent(tx,origin) ||
      !manifest.inputs.some(entry => entry.kind === 'fact' && entry.id === turn.ref.id &&
        entry.rev === turn.ref.rev && entry.accessEpoch === turn.accessEpoch) ||
      (await revalidateManifest(tx, manifest, purpose)).kind !== 'valid') {
    throw new RecallRequestError(409, '回忆题的教学依据已变化。');
  }
  return { turn, feedback: row.value, attachment: origin.attachment };
}

async function readIssuance(tx: ReadTransaction, mount: Mount, ref: HelpRef, value: unknown) {
  const issuance = recallIssuance(value);
  const item = itemFor(issuance, mount);
  const { turn } = await readSource(tx, mount, false);
  if (!sameHelpRef(turn.ref, issuance.turn)) throw new RecallRequestError(409, '回忆题的原回合已变化。');
  const read = createCommandReadContext(tx, storagePurpose);
  for (const witness of issuance.materials) {
    const fact = await read.fact(witness.ref.id, { mode: 'pinned', rev: witness.ref.rev });
    if (fact.accessEpoch !== witness.accessEpoch) throw new RecallRequestError(403, '回忆题材料的授权已变化。');
  }
  return { ref, item };
}

async function mounted(tx: ReadTransaction, mount: Mount) {
  const ref = issuanceRef(mount);
  const fact = await optionalPinned(tx, ref);
  if (fact?.type !== recallIssuanceType) throw new RecallRequestError(404, '这道回忆题尚未发放。');
  return readIssuance(tx, mount, ref, fact.value);
}

function view(mount: Mount, ref: HelpRef, item: Item) {
  return { ...mount, issuanceId: ref.id, responseId: recallResponseId, prompt: item.prompt };
}

function writtenRef(receipt: CommandReceipt) {
  const ref = receipt.wrote[0];
  if (receipt.state !== 'done' || !ref) throw new RecallRequestError(409, '此回忆题操作已失效。');
  return ref;
}

async function resultFor(tx: ReadTransaction, submission: Submission, ref: FactRef, item: Item) {
  const admission = await readActivitySubmissionBirth(tx, ref, recallSubmissionType);
  if (!admission) throw new RecallRequestError(409, '回忆题交答尚未确认。');
  const target = recallTarget(submission.issuance, submission.itemId);
  const cutoff = admission.tick;
  const { events, omitted } = await readActivityHelpEvents(tx, createCommandReadContext(tx, storagePurpose), {
    activities: [target.activityId], cutoff, mode: 'pinned', issuance: submission.issuance,
  });
  const coverage = !omitted && submission.observation === 'complete' ? { submission: ref, target, through: cutoff } : null;
  const base = { id: item.itemId, prompt: item.prompt, explanation: null };
  const question: WorkbookQuestion = item.rubric
    ? { ...base, kind: 'rubric', rubric: item.rubric, rubricVersion: 'rubric-v1' }
    : { ...base, kind: 'exact', answers: [item.answer], selfCheck: false };
  const { feedback: [feedback] } = gradeWorkbook(
    { title: '回忆题', materialId: null, savedAt: '', questions: [question] },
    { [item.itemId]: submission.answer },
  );
  if (!feedback) throw new Error('Missing Recall result');
  return { submission: ref, itemId: item.itemId, responseId: recallResponseId,
    result: feedback.result, exposure: projectHelpExposure({ submission: { ref, target, cutoff }, events, coverage }) };
}

export function openRecall(db: Db, activity: LoadedModule, options: {
  hooks?: CommandHooks;
  /** The host must authenticate the actual render event and correlate it to its mount and reveal grant. */
  verifyDisplay?: (receipt: unknown) => Promise<DisplayWitness | null>;
} = {}) {
  const scope = { learner: studioLearner };
  const hooks = options.hooks ?? { async onFactsChanged() {} };

  function write<T>(run: (tx: DbTransaction, handle: CommandHandler) => Promise<T>) {
    return authorized(() => db.tx(scope, async tx => {
      // Recheck authorization and write against the same learner lock. Bind the
      // existing command handler to this transaction so it still owns receipts and ticks.
      await lockLearner(tx, tx.learner);
      const handle = createCommandHandler({
        ...db,
        query: tx.query,
        tx: async (requested, apply) => {
          if (requested.learner !== tx.learner) throw new Error('Recall transaction learner mismatch');
          return apply(tx);
        },
      }, { modules: [activity], hooks });
      try { return await run(tx, handle); }
      catch (error) {
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          throw new RecallRequestError(409, '同一请求标识已用于不同回忆题操作。');
        }
        throw error;
      }
    }));
  }

  const execute = (handle: CommandHandler, id: FactId, type: string, data: Json, allowed = storagePurpose) =>
    handle({ ...scope, actor: 'learner', purpose: allowed, id: commandId(id), type, input: { id, data } });

  return {
    async mount(locator: unknown) {
      const mount = input(() => parseMount(locator));
      return write(async (tx, handle) => {
        const ref = issuanceRef(mount);
        const existing = await optionalPinned(tx, ref);
        if (existing) {
          if (existing.type !== recallIssuanceType) throw new Error('Invalid Recall issuance identity');
          const { item } = await readIssuance(tx, mount, ref, existing.value);
          return view(mount, ref, item);
        }
        const { turn, feedback, attachment } = await readSource(tx, mount, true);
        const kit = studyKit(feedback && typeof feedback === 'object' && 'studyKit' in feedback ? feedback.studyKit : null);
        if (!kit) throw new RecallRequestError(404, '此回合没有可用的回忆题。');
        const materials = attachment ? await attachmentSources(tx,attachment) : undefined;
        if (attachment && !materials) throw new RecallRequestError(409,'本轮选段已无法对应到授权原文。');
        const data = {
          turn: { id: turn.ref.id, rev: turn.ref.rev },
          version: mount.derivationId,
          materials: materials?.witnesses ?? [],
          items: kit.questions.map((item, index) => ({ ...item, itemId: recallItemId(mount.turnId, mount.derivationId, index) })),
        };
        const item = itemFor(data, mount);
        writtenRef(await execute(handle, ref.id, issueRecallCommand, data, purpose));
        return view(mount, ref, item);
      });
    },

    async get(locator: unknown) {
      const mount = input(() => parseMount(locator));
      return authorized(() => db.snapshot(scope, async tx => {
        const { ref, item } = await mounted(tx, mount);
        return view(mount, ref, item);
      }));
    },

    async readState(locator: unknown) {
      const mount = input(() => parseMount(locator));
      return authorized(() => db.snapshot(scope, async tx => {
        const { ref, item } = await mounted(tx, mount);
        const { rows: [latest] } = await tx.query<{ id: string }>(
          `SELECT r.fact_id AS id FROM fact_revs r
           JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
           JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
           WHERE r.learner_id=$1 AND f.type=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
             AND r.data->'issuance'=$3::jsonb AND r.data->>'itemId'=$4 AND r.data->>'responseId'=$5
             AND c.type=$6 AND c.state='done'
           ORDER BY r.tick DESC LIMIT 1`,
          [tx.learner, recallSubmissionType, JSON.stringify(ref), item.itemId, recallResponseId, submitRecallCommand],
        );
        if (!latest) return null;
        const fact = await createCommandReadContext(tx, storagePurpose).fact(factId(latest.id), { mode: 'pinned', rev: firstRevision });
        const submission = recallSubmission(fact.value);
        return { answer: submission.answer, receipt: await resultFor(tx, submission, fact.ref, item) };
      }));
    },

    async requestReveal(body: unknown) {
      const { mount, requestId } = input(() => {
        const row = fields(body, ['mount', 'requestId']);
        return { mount: parseMount(row.mount), requestId: workbookRequestId(row.requestId) };
      });
      return write(async (tx, handle) => {
        const { ref, item } = await mounted(tx, mount);
        const revealId = factId(stableId('recall-reveal', requestId));
        const request = helpExposureRequest(revealId, {
          kind: 'opened', mount: recallTarget(ref, item.itemId), content: ref,
          step: { kind: 'solution', order: 1 }, alsoAppliesTo: [],
        });
        writtenRef(await handle({ ...scope, actor: 'learner', ...request }));
        return { revealId, itemId: item.itemId, reference: item.answer, ...(item.rubric ? { rubric: item.rubric } : {}) };
      });
    },

    async confirmDisplay(receipt: unknown) {
      const witness = await options.verifyDisplay?.(receipt);
      if (!witness) throw new RecallRequestError(403, '缺少可信的回忆题显示回执。');
      const mount = input(() => parseMount(witness.mount));
      const revealId = input(() => factId(witness.revealId));
      return write(async (tx, handle) => {
        const { ref, item } = await mounted(tx, mount);
        const fact = await optionalPinned(tx, { id: revealId, rev: firstRevision });
        const reveal = fact?.type === helpExposureType ? helpExposure(fact.value) : null;
        if (reveal?.kind !== 'opened' || !sameHelpTarget(reveal.mount, recallTarget(ref, item.itemId)) ||
            !sameHelpRef(reveal.content, ref) || reveal.step.kind !== 'solution' ||
            reveal.step.order !== 1 || reveal.alsoAppliesTo.length !== 0) {
          throw new RecallRequestError(409, '显示回执与获准揭示的题项不匹配。');
        }
        const displayId = factId(stableId('recall-display', revealId));
        const request = helpExposureRequest(displayId, { ...reveal, kind: 'displayed' });
        return { display: writtenRef(await handle({ ...scope, actor: 'learner', ...request })) };
      });
    },

    /** Only the server host can attest complete coverage. Preserve its first admission on retries. */
    async submit(body: unknown, observation: Submission['observation'] = 'unknown') {
      const { mount, requestId, answer } = input(() => {
        const row = fields(body, ['mount', 'requestId', 'answer']);
        return { mount: parseMount(row.mount), requestId: workbookRequestId(row.requestId), answer: recallText(row.answer, 4000) };
      });
      return write(async (tx, handle) => {
        const { ref, item } = await mounted(tx, mount);
        const id = factId(stableId('recall-submission', requestId));
        const existing = await optionalPinned(tx, { id, rev: firstRevision });
        const data = {
          issuance: ref, itemId: item.itemId, responseId: recallResponseId, answer,
          observation: existing?.type === recallSubmissionType ? recallSubmission(existing.value).observation : observation,
        };
        const receipt = await execute(handle, id, submitRecallCommand, data);
        return resultFor(tx, data, writtenRef(receipt), item);
      });
    },
  };
}
