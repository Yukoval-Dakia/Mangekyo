import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import type { CommandHandler, CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandReadContext, isFactNotFound, isFactReadDenied } from './fact-read-helpers.ts';
import { withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt, FactRef, Json } from '../../kernel/src/declarations/types.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { notionReadScope, teachingResultAuthority, type CheckNotionRead } from './notion.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyKit } from '../../executors/teaching/study-kit.ts';
import { helpExposure, helpExposureRequest, helpExposureType, sameHelpRef, type HelpRef } from '../../modules/activity/help-exposure-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  issueRecallCommand, parseRecallMount, recallDisplayEvent, recallIssuance, recallIssuanceType, recallItemView, recallMountedItem,
  recallResponseId, recallResultView, recallRevealInput, recallRevealView, recallSubmission, recallSubmissionType, recallSubmitInput,
  recallTarget, submitRecallCommand, type RecallMount,
} from '../../modules/activity/recall-values.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { attachmentSources, teachingOrigin } from './reading.ts';
import { workspaceGrantChecker } from './harness.ts';
import { purpose, slotType, studioLearner } from './identity.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { RecallRequestError } from '../../modules/activity/recall-http-support.ts';
import {
  firstRevision, parseBody, recallDisplayId, recallIssuanceRef, recallItemId, recallRevealId,
  recallSubmissionData, recallSubmissionId, rejectDuplicateCommand, requireIssued, requireKit,
  requireMountedItem, manifestFollowsTurn, writtenRefOr, type SliceReject,
} from '../../modules/companion/facts/recall-practice-slice.ts';

export { RecallRequestError };
export { recallItemId };

type DisplayWitness = { mount: RecallMount; revealId: string };
type Issuance = ReturnType<typeof recallIssuance>;
type Item = Issuance['items'][number];
type Submission = ReturnType<typeof recallSubmission>;

const reject: SliceReject = (status, message) => new RecallRequestError(status, message);
const input = <T>(body: unknown, parse: (value: unknown) => T) => parseBody(reject, body, parse);

const issuanceRef = (mount: RecallMount): HelpRef => recallIssuanceRef(mount.turnId, mount.derivationId);

function itemFor(issuance: Parameters<typeof recallMountedItem>[0], mount: RecallMount) {
  return requireMountedItem(reject, recallMountedItem(issuance, mount));
}

async function authorized<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (isFactReadDenied(error)) throw new RecallRequestError(403, '回忆题依据已不可读。');
    if (isFactNotFound(error)) throw new RecallRequestError(404, '找不到回忆题记录。');
    throw error;
  }
}

async function optionalPinned(tx: ReadTransaction, ref: HelpRef) {
  try {
    return await createCommandReadContext(tx, storagePurpose).fact(ref.id, { mode: 'pinned', rev: ref.rev });
  } catch (error) {
    if (isFactNotFound(error)) return null;
    throw error;
  }
}

async function readSource(tx: ReadTransaction, mount: RecallMount, requireCurrent: boolean, check: CheckNotionRead) {
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
  const origin = await teachingOrigin(tx,submission);
  const manifest = parseManifest(row.manifest);
  if (turn.type !== 'activity.studyTurn' || !manifestFollowsTurn(manifest, turn, purpose) ||
      (await teachingResultAuthority(tx, mount.turnId, submission, manifest, workspaceGrantChecker(tx), check, origin)).state !== 'authorized') {
    throw new RecallRequestError(409, '回忆题的教学依据已变化。');
  }
  return { turn, feedback: row.value, attachment: origin.attachment };
}

async function readIssuance(tx: ReadTransaction, mount: RecallMount, ref: HelpRef, value: unknown, check: CheckNotionRead) {
  const issuance = recallIssuance(value);
  const item = itemFor(issuance, mount);
  const { turn } = await readSource(tx, mount, false, check);
  if (!sameHelpRef(turn.ref, issuance.turn)) throw new RecallRequestError(409, '回忆题的原回合已变化。');
  const read = createCommandReadContext(tx, storagePurpose);
  for (const witness of issuance.materials) {
    const fact = await read.fact(witness.ref.id, { mode: 'pinned', rev: witness.ref.rev });
    if (fact.accessEpoch !== witness.accessEpoch) throw new RecallRequestError(403, '回忆题材料的授权已变化。');
  }
  return { ref, item };
}

async function mounted(tx: ReadTransaction, mount: RecallMount, check: CheckNotionRead) {
  const ref = issuanceRef(mount);
  const fact = await optionalPinned(tx, ref);
  const value = requireIssued(reject, fact?.type, recallIssuanceType, fact?.value);
  return readIssuance(tx, mount, ref, value, check);
}

function writtenRef(receipt: CommandReceipt) {
  return writtenRefOr(reject, receipt, '此回忆题操作已失效。') as FactRef;
}

async function resultFor(tx: ReadTransaction, submission: Submission, ref: FactRef, item: Item) {
  const admission = await readActivitySubmissionBirth(tx, ref, recallSubmissionType);
  if (!admission) throw new RecallRequestError(409, '回忆题交答尚未确认。');
  const review = await readActivityHelpEvents(tx, createCommandReadContext(tx, storagePurpose), {
    activities: [submission.issuance.id], cutoff: admission.tick, mode: 'pinned', issuance: submission.issuance,
  });
  return recallResultView(submission, ref, item, admission.tick, review);
}

export function openRecall(db: Db, activity: LoadedModule, options: {
  hooks?: CommandHooks;
  /** The host must authenticate the actual render event and correlate it to its mount and reveal grant. */
  verifyDisplay?: (receipt: unknown) => Promise<DisplayWitness | null>;
} = {}) {
  const scope = { learner: studioLearner };
  const hooks = options.hooks ?? createStudioCommandHooks();

  const notionRead = () => notionReadScope(db, studioLearner);
  function write<T>(mount: RecallMount, run: (tx: DbTransaction, handle: CommandHandler, check: CheckNotionRead) => Promise<T>, notion = notionRead()) {
    return authorized(() => notion.read((tx, check) => readSource(tx, mount, false, check), async (tx, check) => {
      const handle = createCommandHandler(withinLearnerTransaction(db, tx), { modules: [activity], hooks });
      try { return await run(tx, handle, check); }
      catch (error) { rejectDuplicateCommand(reject, error, '同一请求标识已用于不同回忆题操作。'); throw error; }
    }));
  }

  const execute = (handle: CommandHandler, id: FactId, type: string, data: Json, allowed = storagePurpose) =>
    handle({ ...scope, actor: 'learner', purpose: allowed, id: commandId(id), type, input: { id, data } });

  return {
    async mount(locator: unknown, notion = notionRead()) {
      const mount = input(locator, parseRecallMount);
      return write(mount, async (tx, handle, check) => {
        const ref = issuanceRef(mount);
        const existing = await optionalPinned(tx, ref);
        if (existing) {
          if (existing.type !== recallIssuanceType) throw new Error('Invalid Recall issuance identity');
          const { item } = await readIssuance(tx, mount, ref, existing.value, check);
          return recallItemView(mount, ref, item);
        }
        const { turn, feedback, attachment } = await readSource(tx, mount, true, check);
        const kit = requireKit(reject, studyKit(
          feedback && typeof feedback === 'object' && 'studyKit' in feedback ? feedback.studyKit : null));
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
        return recallItemView(mount, ref, item);
      }, notion);
    },

    async get(locator: unknown, notion = notionRead()) {
      const mount = input(locator, parseRecallMount);
      return authorized(() => notion.read(async (tx, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        return recallItemView(mount, ref, item);
      }));
    },

    async readState(locator: unknown) {
      const mount = input(locator, parseRecallMount);
      return authorized(() => notionRead().read(async (tx, check) => {
        const { ref, item } = await mounted(tx, mount, check);
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
      const { mount, requestId } = input(body, recallRevealInput);
      return write(mount, async (tx, handle, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        const revealId = recallRevealId(requestId);
        const request = helpExposureRequest(revealId, {
          kind: 'opened', mount: recallTarget(ref, item.itemId), content: ref,
          step: { kind: 'solution', order: 1 }, alsoAppliesTo: [],
        });
        writtenRef(await handle({ ...scope, actor: 'learner', ...request }));
        return recallRevealView(revealId, item);
      });
    },

    async confirmDisplay(receipt: unknown) {
      const witness = await options.verifyDisplay?.(receipt);
      if (!witness) throw new RecallRequestError(403, '缺少可信的回忆题显示回执。');
      const mount = input(witness.mount, parseRecallMount);
      const revealId = factId(witness.revealId);
      return write(mount, async (tx, handle, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        const fact = await optionalPinned(tx, { id: revealId, rev: firstRevision });
        const reveal = fact?.type === helpExposureType ? helpExposure(fact.value) : null;
        const display = recallDisplayEvent(reveal, ref, item);
        if (!display) throw new RecallRequestError(409, '显示回执与获准揭示的题项不匹配。');
        const request = helpExposureRequest(recallDisplayId(revealId), display);
        return { display: writtenRef(await handle({ ...scope, actor: 'learner', ...request })) };
      });
    },

    /** Only the server host can attest complete coverage. Preserve its first admission on retries. */
    async submit(body: unknown, observation: Submission['observation'] = 'unknown') {
      const { mount, requestId, answer } = input(body, recallSubmitInput);
      return write(mount, async (tx, handle, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        const id = recallSubmissionId(requestId);
        const existing = await optionalPinned(tx, { id, rev: firstRevision });
        const data = recallSubmissionData(ref, item.itemId, recallResponseId, answer,
          existing?.type === recallSubmissionType ? recallSubmission(existing.value).observation : undefined,
          observation);
        const receipt = await execute(handle, id, submitRecallCommand, data);
        return resultFor(tx, data, writtenRef(receipt), item);
      });
    },
  };
}
