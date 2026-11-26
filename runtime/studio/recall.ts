import {
  commandId, createCommandReadContext, factId, mapKernelError, parseManifest, readAvailable, readEffectiveDerivation,
  type CommandHooks, type CommandReceipt, type Db, type DbTransaction, type FactId, type FactRef, type ReadTransaction, type Revision,
} from '../../kernel/src/index.ts';
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
import { purpose, slotType, stableId, studioHost, studioLearner } from './identity.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { readActivityHelpEvents, readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { RecallRequestError } from '../../modules/activity/recall-http-support.ts';
export { RecallRequestError };
type DisplayWitness = { mount: RecallMount; revealId: string };
type Issuance = ReturnType<typeof recallIssuance>;
type Item = Issuance['items'][number];
type Submission = ReturnType<typeof recallSubmission>;
const firstRevision = 1 as Revision;
export const recallItemId = (turnId: string, version: string, position: number): FactId =>
  factId(stableId('recall-item', turnId, version, String(position)));
const input = <T>(parse: () => T): T => { try { return parse(); } catch { throw new RecallRequestError(400, '回忆题请求格式无效。'); } };
const issuanceRef = (mount: RecallMount): HelpRef =>
  ({ id: factId(stableId('recall-issuance', mount.turnId, mount.derivationId)), rev: firstRevision });
function itemFor(issuance: Parameters<typeof recallMountedItem>[0], mount: RecallMount) {
  const item = recallMountedItem(issuance, mount);
  if (!item) throw new RecallRequestError(404, '回忆题与此回合版本不匹配。');
  return item;
}
  const authorized = <T>(read: () => Promise<T>): Promise<T> => read().catch(error => { throw mapKernelError(error, {
    denied: () => new RecallRequestError(403, '回忆题依据已不可读。'), not_found: () => new RecallRequestError(404, '找不到回忆题记录。'),
  }); });
  const optionalPinned = async (tx: ReadTransaction, ref: HelpRef) =>
    (await readAvailable(() => createCommandReadContext(tx, storagePurpose).fact(ref.id, { mode: 'pinned', rev: ref.rev }))) ?? null;
  async function readSource(tx: ReadTransaction, mount: RecallMount, requireCurrent: boolean, check: CheckNotionRead) {
    const row = await readEffectiveDerivation(tx, { slotType, slotKey: mount.turnId, id: mount.derivationId, requireCurrent });
    if (!row) throw new RecallRequestError(404, '此回合没有可用的回忆题版本。');
    const turn = await createCommandReadContext(tx, purpose).fact(mount.turnId, { mode: 'following' });
    const submission = studyTurn(turn.value), origin = await teachingOrigin(tx, submission), manifest = parseManifest(row.manifest);
    if (turn.type !== 'activity.studyTurn' || manifest.purpose !== purpose ||
        !manifest.inputs.some(entry => entry.kind === 'fact' && entry.id === turn.ref.id &&
          (entry.mode === 'following' || (entry.rev === turn.ref.rev && entry.accessEpoch === turn.accessEpoch))) ||
        (await teachingResultAuthority(tx, mount.turnId, submission, manifest, workspaceGrantChecker(tx), check, origin)).state !== 'authorized')
      throw new RecallRequestError(409, '回忆题的教学依据已变化。');
    return { turn, feedback: row.value, attachment: origin.attachment };
  }
  async function readIssuance(tx: ReadTransaction, mount: RecallMount, ref: HelpRef, value: unknown, check: CheckNotionRead) {
    const issuance = recallIssuance(value), item = itemFor(issuance, mount), { turn } = await readSource(tx, mount, false, check);
    if (!sameHelpRef(turn.ref, issuance.turn)) throw new RecallRequestError(409, '回忆题的原回合已变化。');
    const read = createCommandReadContext(tx, storagePurpose);
    for (const w of issuance.materials)
      if ((await read.fact(w.ref.id, { mode: 'pinned', rev: w.ref.rev })).accessEpoch !== w.accessEpoch)
        throw new RecallRequestError(403, '回忆题材料的授权已变化。');
    return { ref, item };
  }
  async function mounted(tx: ReadTransaction, mount: RecallMount, check: CheckNotionRead) {
    const ref = issuanceRef(mount), fact = await optionalPinned(tx, ref);
    if (fact?.type !== recallIssuanceType) throw new RecallRequestError(404, '这道回忆题尚未发放。');
    return readIssuance(tx, mount, ref, fact.value, check);
  }
  function writtenRef(receipt: CommandReceipt) {
    const ref = receipt.wrote[0];
  if (receipt.state !== 'done' || !ref) throw new RecallRequestError(409, '此回忆题操作已失效。');
  return ref;
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
  const host = studioHost(db);
  const hooks = options.hooks ?? createStudioCommandHooks(), notionRead = () => notionReadScope(db, studioLearner);
  function write<T>(mount: RecallMount, run: (tx: DbTransaction, handle: ReturnType<typeof host.boundHandler>, check: CheckNotionRead) => Promise<T>,
    notion = notionRead()) {
    return authorized(() => notion.read((tx, check) => readSource(tx, mount, false, check), (tx, check) =>
      run(tx, host.boundHandler([activity], hooks, tx), check).catch(error => {
        throw mapKernelError(error, { duplicate_command: () => new RecallRequestError(409, '同一请求标识已用于不同回忆题操作。') });
      })));
  }
  const writeMounted = <T>(mount: RecallMount, run: (tx: DbTransaction, handle: ReturnType<typeof host.boundHandler>,
    check: CheckNotionRead, mounted: { ref: HelpRef; item: Item }) => Promise<T>) =>
    write(mount, async (tx, handle, check) => run(tx, handle, check, await mounted(tx, mount, check)));
  return {
    async mount(locator: unknown, notion = notionRead()) {
      const mount = input(() => parseRecallMount(locator));
      return write(mount, async (tx, handle, check) => {
        const ref = issuanceRef(mount), existing = await optionalPinned(tx, ref);
        if (existing) {
          if (existing.type !== recallIssuanceType) throw new Error('Invalid Recall issuance identity');
          return recallItemView(mount, ref, (await readIssuance(tx, mount, ref, existing.value, check)).item);
        }
        const { turn, feedback, attachment } = await readSource(tx, mount, true, check);
        const kit = studyKit(feedback && typeof feedback === 'object' && 'studyKit' in feedback ? feedback.studyKit : null);
        if (!kit) throw new RecallRequestError(404, '此回合没有可用的回忆题。');
        const materials = attachment ? await attachmentSources(tx, attachment) : undefined;
        if (attachment && !materials) throw new RecallRequestError(409, '本轮选段已无法对应到授权原文。');
        const data = { turn: { id: turn.ref.id, rev: turn.ref.rev }, version: mount.derivationId, materials: materials?.witnesses ?? [],
          items: kit.questions.map((item, index) => ({ ...item, itemId: recallItemId(mount.turnId, mount.derivationId, index) })) };
        const item = itemFor(data, mount);
        writtenRef(await handle({ purpose, type: issueRecallCommand, id: commandId(ref.id), input: { id: ref.id, data } }));
        return recallItemView(mount, ref, item);
      }, notion);
    },
    async get(locator: unknown, notion = notionRead()) {
      const mount = input(() => parseRecallMount(locator));
      return authorized(() => notion.read(async (tx, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        return recallItemView(mount, ref, item);
      }));
    },
    async readState(locator: unknown) {
      const mount = input(() => parseRecallMount(locator));
      return authorized(() => notionRead().read(async (tx, check) => {
        const { ref, item } = await mounted(tx, mount, check);
        const { rows: [latest] } = await tx.query<{ id: string }>(
          `SELECT r.fact_id AS id FROM fact_revs r JOIN facts f ON f.learner_id=r.learner_id AND f.id=r.fact_id
           JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
           WHERE r.learner_id=$1 AND f.type=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner'
             AND r.data->'issuance'=$3::jsonb AND r.data->>'itemId'=$4 AND r.data->>'responseId'=$5 AND c.type=$6 AND c.state='done'
           ORDER BY r.tick DESC LIMIT 1`,
          [tx.learner, recallSubmissionType, JSON.stringify(ref), item.itemId, recallResponseId, submitRecallCommand]);
        if (!latest) return null;
        const fact = await createCommandReadContext(tx, storagePurpose).fact(factId(latest.id), { mode: 'pinned', rev: firstRevision });
        const submission = recallSubmission(fact.value);
        return { answer: submission.answer, receipt: await resultFor(tx, submission, fact.ref, item) };
      }));
    },
    async requestReveal(body: unknown) {
      const { mount, requestId } = input(() => recallRevealInput(body));
      return writeMounted(mount, async (_tx, handle, _check, { ref, item }) => {
        const revealId = factId(stableId('recall-reveal', requestId));
        writtenRef(await handle(helpExposureRequest(revealId,
          { kind: 'opened', mount: recallTarget(ref, item.itemId), content: ref, step: { kind: 'solution', order: 1 }, alsoAppliesTo: [] })));
        return recallRevealView(revealId, item);
      });
    },
    async confirmDisplay(receipt: unknown) {
      const witness = await options.verifyDisplay?.(receipt);
      if (!witness) throw new RecallRequestError(403, '缺少可信的回忆题显示回执。');
      const mount = input(() => parseRecallMount(witness.mount)), revealId = input(() => factId(witness.revealId));
      return writeMounted(mount, async (tx, handle, _check, { ref, item }) => {
        const fact = await optionalPinned(tx, { id: revealId, rev: firstRevision });
        const display = recallDisplayEvent(fact?.type === helpExposureType ? helpExposure(fact.value) : null, ref, item);
        if (!display) throw new RecallRequestError(409, '显示回执与获准揭示的题项不匹配。');
        return { display: writtenRef(await handle(helpExposureRequest(factId(stableId('recall-display', revealId)), display))) };
      });
    },
    /** Only the server host can attest complete coverage. Preserve its first admission on retries. */
    async submit(body: unknown, observation: Submission['observation'] = 'unknown') {
      const { mount, requestId, answer } = input(() => recallSubmitInput(body));
      return writeMounted(mount, async (tx, handle, _check, { ref, item }) => {
        const id = factId(stableId('recall-submission', requestId)), existing = await optionalPinned(tx, { id, rev: firstRevision });
        const data = { issuance: ref, itemId: item.itemId, responseId: recallResponseId, answer,
          observation: existing?.type === recallSubmissionType ? recallSubmission(existing.value).observation : observation };
        const receipt = await handle({ purpose: storagePurpose, type: submitRecallCommand, id: commandId(id), input: { id, data } });
        return resultFor(tx, data, writtenRef(receipt), item);
      });
    },
  };
}
