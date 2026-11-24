import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { readEffectiveSlotVersion } from '../../kernel/src/derivations/revalidate.ts';
import {commandId, createCommandReadContext, isFactUnavailable, LifecycleError, type CommandHooks, type CommandId, type Db, type DerivationSnapshot, type FactId, type FactSnapshot, type Json, type ReadContext, type ReadTransaction, type SlotRef} from '../../kernel/src/index.ts';
import { assertDeletionWatermark, assertUnburned } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { issuedPosttestPaper, posttestIssuanceType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import { printedWorkbookPresentation, recordWorkbookPresentationCommand, WorkbookPresentationError } from '../../modules/activity/workbook-presentation.ts';
import { workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { layeredExtractionDeriver, layeredExtractionSlot, type LayeredExtractionValue } from '../../modules/capture/extraction.ts';
import type { IntakeOriginal } from '../../modules/capture/intake-values.ts';
import { bindPaperCommandRead, checkedPaperIssuance, collectPaperInput, collectPaperWrites, defaultPaperRunId, newPaperIssuance, openIssuedPaper, paperCollectionReceipt, paperIssuanceType, paperReturnCaptureInput, paperReturnSelection, paperReturnUploadReceipt, paperReturnView, paperRun, paperRunType, projectNewPaper, readPaperDisplayInput, readPaperReprintInput, resolvePaperIssue, validPaperReturnIndices, type PaperExtractionReader, type PaperIssuance } from '../../modules/capture/paper.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { AssetBasisError, assetType, textbookPageType } from '../../modules/content/asset.ts';
import { matchesQuestionVerificationSlot, questionVerificationType, type QuestionVerification } from '../../modules/content/question-state.ts';
import { stableId } from './identity.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';
import { studioHost } from './fact-read-helpers.ts';

const purpose = 'storage', conflict = '卷面、题目发放状态或回收依据已变化。', previewLayout = { lines: 60, columns: 80 };
const stale = () => new RequestError(409, conflict);
const printKinds = new Map<string, 'workbook' | 'posttest' | 'question' | 'textbook'>([
  [workbookPaperType, 'workbook'], [posttestIssuanceType, 'posttest'], [assetType, 'question'], [textbookPageType, 'textbook'],
]);

function bindRead(tx: ReadTransaction, base: ReadContext, use: string) {
  const readExtraction: PaperExtractionReader = async ({ learner, source, extraction }, mode) => {
    const row = learner === tx.learner ? await readEffectiveSlotVersion<LayeredExtractionValue>(tx,
      { learner, type: layeredExtractionSlot, key: source.id }, layeredExtractionDeriver, use, mode === 'pinned' ? extraction.derivationId : undefined) : undefined;
    if (!row || row.snapshot.id !== extraction.derivationId) throw stale();
    return row;};
  const readQuestionSlot: ReadContext['slot'] = async <Value = Json>(slot: SlotRef, { mode }: Parameters<ReadContext['slot']>[1]) => {
    const result = slot.learner === tx.learner && slot.type === questionVerificationType && mode === 'following'
      ? await readEffectiveSlotVersion<QuestionVerification>(tx, slot, 'content/question-verification', use) : undefined;
    if (!result || !matchesQuestionVerificationSlot(slot.key, result.snapshot.outcome.value?.basis, result.manifest.inputs)) throw stale();
    return result.snapshot as DerivationSnapshot<Value>;};
  return bindPaperCommandRead(base, { readExtraction, readQuestionSlot });
}

const learnerRead = (tx: ReadTransaction) => bindRead(tx, createCommandReadContext(tx, purpose), purpose);
const parseInput = <T>(parse: () => T): T => { try { return parse(); } catch { throw new RequestError(400, '纸面请求格式无效。'); } };

async function admitSource(tx: ReadTransaction, read: ReadContext, { source }: PaperIssuance) {
  const fact = await read.fact(source.id, { mode: 'pinned', rev: source.rev });
  if (fact.type === retentionPaperType) throw new RequestError(404, '后测卷尚无可用的发放题项。');
  if (fact.type === posttestIssuanceType) {
    const { issuance, fact: released } = await readPosttestIssuance(tx, read, source.id);
    if (released.ref.rev !== source.rev) throw stale();
    await issuedPosttestPaper(createCommandReadContext(tx, retentionTeachingPurpose), issuance);
  }
  return fact;
}

async function readIssuance(tx: ReadTransaction, read: ReadContext, id: FactId, fact?: FactSnapshot) {
  const stored = fact ?? await read.fact(id, { mode: 'following' });
  if (stored.type !== paperIssuanceType || stored.ref.rev !== 1) throw new RequestError(404, '找不到已发行纸卷。');
  const issue = await checkedPaperIssuance(stored, id);
  return { id, issue, source: await admitSource(tx, read, issue) };
}

async function paperRequest<T>(work: () => Promise<T>) { try { return await work(); }
  catch (error) { if (error instanceof LifecycleError) throw error;
    if (isFactUnavailable(error)) throw new RequestError(404, '找不到当前可读取的纸面依据。');
    if (error instanceof AssetBasisError || error instanceof WorkbookPresentationError || (error instanceof Error && error.constructor === Error)) throw stale();
    throw error;
  }
}

const ifAvailable = <T>(work: () => Promise<T>) => paperRequest(work)
  .catch(error => error instanceof RequestError && [404, 409, 422].includes(error.status) ? undefined : Promise.reject(error));

async function printCandidate(tx: ReadTransaction, read: ReadContext, fact: FactSnapshot, kind: 'workbook' | 'posttest' | 'question' | 'textbook' | 'photo' | 'pdf') {
  const { id, rev } = fact.ref, definition = { source: { id, rev }, epoch: fact.accessEpoch, layout: previewLayout };
  await admitSource(tx, read, definition);
  const project = async ({ layout, ...ref }: PaperIssuance) => ({ kind, title: (await projectNewPaper(read, { layout, ...ref })).title, ...ref });
  if (kind === 'photo' || kind === 'pdf') { const layered = await ifAvailable(async () => {
      const version = await readEffectiveSlotVersion<LayeredExtractionValue>(tx, { learner: tx.learner, type: layeredExtractionSlot, key: id }, layeredExtractionDeriver, purpose);
      if (!version) throw stale();
      const { basis } = version.snapshot.outcome.value;
      return project({ ...definition, extraction: { derivationId: version.snapshot.id, sourceRev: basis.target.rev, modelMethod: basis.modelMethod } });
    });
    if (layered) return layered;
  }
  return project(definition);
}

async function listPapers(tx: ReadTransaction) { const read = learnerRead(tx);
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL ORDER BY created_tick DESC,id`,
    [tx.learner, [paperIssuanceType, captureSourceType, ...printKinds.keys()]]);
  const sources: Awaited<ReturnType<typeof printCandidate>>[] = [], issued: { issuanceId: FactId; title: string; pageCount: number }[] = [], returns: ReturnType<typeof paperReturnView>[] = [];
  for (const { id } of rows) { const fact = await ifAvailable(() => read.fact(id, { mode: 'following' }));
    if (!fact) continue;
    if (fact.type === paperIssuanceType) {
      const paper = await ifAvailable(async () => (await readIssuance(tx, read, id, fact), openIssuedPaper(read, id)));
      if (paper) issued.push({ issuanceId: paper.issuanceId, title: paper.title, pageCount: paper.pages.length });
      continue;
    }
    const captured = fact.type === captureSourceType ? await ifAvailable(async () => sourceEnvelope(fact.value)) : undefined;
    if (captured?.kind === 'paper-return') returns.push(paperReturnView(id, fact.ref.rev, captured));
    else if (!captured?.workbookAttachment) {
      const kind = captured?.kind === 'photo' || captured?.kind === 'pdf' ? captured.kind : printKinds.get(fact.type);
      const candidate = kind ? await ifAvailable(() => printCandidate(tx, read, fact, kind)) : undefined;
      if (candidate) sources.push(candidate);
    }
  }
  return { sources, returns, issued };
}

type PaperCommand = (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>;

async function collect(read: ReadContext, command: PaperCommand, data: ReturnType<typeof collectPaperInput>) {
  const runId = data.retryId ?? await defaultPaperRunId(data.issuanceId);
  await command('capture.collectPaper', data as Json);
  if ((await collectPaperWrites(read, data)).length) throw stale();
  const run = await read.fact(runId, { mode: 'following' });
  if (run.type !== paperRunType || paperRun(run.value).issuanceId !== data.issuanceId) throw stale();
  return { run, receipt: paperCollectionReceipt(data, runId, run.ref.rev) };
}

async function present(tx: ReadTransaction, read: ReadContext, command: PaperCommand, id: FactId, permit?: FactId) {
  const { issue, source } = await readIssuance(tx, read, id), printed = await openIssuedPaper(read, id);
  if (source.type !== workbookPaperType) { if (permit) throw stale(); return { ...printed, presentation: null }; }
  // The learner lock commits the #65 permit before the HTTP response can carry these prompts.
  const data = printedWorkbookPresentation(issue.source, printed, permit);
  const presentationId = commandId(stableId(recordWorkbookPresentationCommand, canonicalJsonString(data)));
  await command(recordWorkbookPresentationCommand, { id: presentationId, data }, presentationId);
  return { ...printed, presentation: { paper: data.paper, items: data.items, permit: presentationId } };
}

export function openCapturePapers(db: Db, capture: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  const host = studioHost(db);
  const write = <T>(run: (read: ReadContext, command: PaperCommand, tx: ReadTransaction) => Promise<T>) =>
    paperRequest(() => host.lockedCommand([capture, activity], hooks, (tx, handle) =>
      run(learnerRead(tx), async (type, data, id = commandId(stableId(type, canonicalJsonString(data))), deletionWatermark) => {
        const receipt = await host.runCommand(handle, { purpose, type, id, input: data, ...(deletionWatermark === undefined ? {} : { deletionWatermark }) });
        if (receipt.state !== 'done') throw stale();
      }, tx), { bindCommandRead: (inner, request, base) => bindRead(inner, base, request.purpose) }));

  return {list: () => host.snapshot(listPapers),
    issue: (body: Record<string, unknown>) => { const issue = parseInput(() => newPaperIssuance(body));
      return write(async (read, command, tx) => { await admitSource(tx, read, issue);
        const { printed: { issuanceId: id }, existing } = await resolvePaperIssue(read, issue);
        if (!existing) await command('capture.issuePaper', issue, commandId(stableId('capture.issuePaper', id)));
        return present(tx, read, command, id);});},
    upload(selection: ReturnType<typeof paperReturnSelection>, upload: { command: CommandId; deletionWatermark: string; title: string; original: IntakeOriginal; install: () => Promise<void> }) {
      const { source, purpose: selectedPurpose, ...assignment } = selection, { id, rev } = source;
      return write(async (read, command, tx) => {
        await assertUnburned(tx, 'fact', [id]); await assertUnburned(tx, 'command', [upload.command]);
        await assertDeletionWatermark(tx, upload.deletionWatermark);
        const prior = await readRecordedCommand(tx, upload.command);
        if (prior && prior.type !== captureSourceCommand) throw new RequestError(409, '同一个请求标识已用于普通交入。');
        const recordedAt = prior ? sourceEnvelope((await read.fact(id, { mode: 'pinned', rev })).value).recordedAt : new Date().toISOString();
        await command(captureSourceCommand, paperReturnCaptureInput(id, assignment, upload.original, upload.title, recordedAt, selectedPurpose), upload.command, upload.deletionWatermark);
        await readIssuance(tx, read, assignment.issuanceId);
        const { run, receipt } = await collect(read, command, { ...assignment, source });
        const target = paperRun(run.value).pages.find(page => page.number === assignment.page);
        if (target?.source.id !== id || target.source.rev !== rev) throw new RequestError(409, '这页已回收。请使用原请求或另起一次作答。');
        if (!prior) try { await upload.install(); } catch { throw new RequestError(500, '拍回原件未能保存。'); }
        return paperReturnUploadReceipt(receipt, id, rev, upload.title, source, !prior);});
    }, collect(body: Record<string, unknown>) { const data = parseInput(() => collectPaperInput(body));
      if (!validPaperReturnIndices(data.page, data.original)) throw new RequestError(400, '回收页码或原图索引无效。');
      return write(async (read, command, tx) => {
        await assertUnburned(tx, 'fact', [data.source.id]); await readIssuance(tx, read, data.issuanceId);
        const { rows: [row] } = await tx.query<{ assignment: unknown }>(
          `SELECT c.input#>'{input,paperReturn}' AS assignment FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
           WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND c.type=$3`, [tx.learner, data.source.id, captureSourceCommand]);
        const { source: _, ...assignment } = data;
        if (row?.assignment && canonicalJsonString(row.assignment) !== canonicalJsonString(assignment)) throw new RequestError(409, '回收页归属与本人上传时的选择不符。');
        return (await collect(read, command, data)).receipt;});},
    reprint: (body: Record<string, unknown>) => write((read, command, tx) => present(tx, read, command, parseInput(() => readPaperReprintInput(body)))),
    displayed: (body: Record<string, unknown>) => {
      const [id, permit] = parseInput(() => readPaperDisplayInput(body));
      return write(async (read, command, tx) => (await present(tx, read, command, id, permit), { recorded: true }));
    },
  };
}
