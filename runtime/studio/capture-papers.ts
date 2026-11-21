import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { assertDeletionWatermark, assertUnburned, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type CommandId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { DerivationSnapshot, FactSnapshot, Json, ReadContext, SlotRef } from '../../kernel/src/declarations/types.ts';
import { readEffectiveSlotVersion } from '../../kernel/src/derivations/revalidate.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { issuedPosttestPaper, posttestIssuanceType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import { printedWorkbookPresentation, recordWorkbookPresentationCommand, WorkbookPresentationError } from '../../modules/activity/workbook-presentation.ts';
import { workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { layeredExtractionDeriver, layeredExtractionSlot, type LayeredExtractionValue } from '../../modules/capture/extraction.ts';
import {
  bindPaperCommandRead, checkedPaperIssuance, collectPaperInput, collectPaperWrites, defaultPaperRunId, newPaperIssuance,
  openIssuedPaper, paperCollectionReceipt, paperIssuanceType, paperReturnSelection, paperReturnView, paperRun, paperRunType,
  projectNewPaper, readPaperDisplayInput, readPaperReprintInput, resolvePaperIssue, validPaperReturnIndices,
  type PaperExtractionReader, type PaperIssuance,
} from '../../modules/capture/paper.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { AssetBasisError, assetType, textbookPageType } from '../../modules/content/asset.ts';
import { questionVerificationKey, questionVerificationType, type QuestionVerification } from '../../modules/content/question-state.ts';
import type { IntakeOriginal } from '../../modules/capture/intake-values.ts';
import { stableId, studioLearner } from './identity.ts';
import { readPosttestIssuance } from './retention-posttest.ts';
import { RequestError } from './sessions.ts';

const purpose = 'storage';
const scope = { learner: studioLearner };
const conflict = '卷面、题目发放状态或回收依据已变化。';
const printKinds = new Map<string, 'workbook' | 'posttest' | 'question' | 'textbook'>([
  [workbookPaperType, 'workbook'], [posttestIssuanceType, 'posttest'], [assetType, 'question'], [textbookPageType, 'textbook'],
]);
const previewLayout = { lines: 60, columns: 80 };


function bindRead(tx: ReadTransaction, base: ReadContext, use: string) {
  const readExtraction: PaperExtractionReader = async ({ learner, source, extraction }, mode) => {
    if (learner !== tx.learner) throw new RequestError(409, conflict);
    const row = await readEffectiveSlotVersion<LayeredExtractionValue>(tx, { learner, type: layeredExtractionSlot, key: source.id },
      layeredExtractionDeriver, use, mode === 'pinned' ? extraction.derivationId : undefined);
    if (!row || row.snapshot.id !== extraction.derivationId) throw new RequestError(409, conflict);
    return row;
  };
  const readQuestionSlot: ReadContext['slot'] = async <Value = Json>(
    slot: SlotRef, options: Parameters<ReadContext['slot']>[1],
  ) => {
    if (slot.learner !== tx.learner || slot.type !== questionVerificationType || options.mode !== 'following')
      throw new RequestError(409, conflict);
    const result = await readEffectiveSlotVersion<QuestionVerification>(tx, slot, 'content/question-verification', use);
    if (!result) throw new RequestError(409, conflict);
    const { manifest, snapshot } = result;
    const basis = snapshot.outcome.value?.basis;
    if (!basis || questionVerificationKey(basis) !== slot.key || !manifest.inputs.some(input =>
      input.kind === 'fact' && input.mode === 'following' && input.id === basis.id &&
      input.rev === basis.rev && input.accessEpoch === basis.accessEpoch)) throw new RequestError(409, conflict);
    return snapshot as DerivationSnapshot<Value>;
  };
  return bindPaperCommandRead(base, { readExtraction, readQuestionSlot });
}

const learnerRead = (tx: ReadTransaction) => bindRead(tx, createCommandReadContext(tx, purpose), purpose);

async function admitSource(tx: ReadTransaction, read: ReadContext, { source }: PaperIssuance) {
  const fact = await read.fact(source.id, { mode: 'pinned', rev: source.rev });
  if (fact.type === retentionPaperType) throw new RequestError(404, '后测卷尚无可用的发放题项。');
  if (fact.type === posttestIssuanceType) {
    const { issuance, fact: released } = await readPosttestIssuance(tx, read, source.id);
    if (released.ref.rev !== source.rev) throw new RequestError(409, conflict);
    await issuedPosttestPaper(createCommandReadContext(tx, retentionTeachingPurpose), issuance);
  }
  return fact;
}

async function readIssuance(tx: ReadTransaction, read: ReadContext, id: FactId,
  fact?: FactSnapshot) {
  const stored = fact ?? await read.fact(id, { mode: 'following' });
  if (stored.type !== paperIssuanceType || stored.ref.rev !== 1) throw new RequestError(404, '找不到已发行纸卷。');
  const issue = await checkedPaperIssuance(stored, id);
  return { id, issue, source: await admitSource(tx, read, issue) };
}

function input<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new RequestError(400, '纸面请求格式无效。'); }
}

async function paperRequest<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) {
    if (error instanceof LifecycleError) throw error;
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError)
      throw new RequestError(404, '找不到当前可读取的纸面依据。');
    if (error instanceof AssetBasisError || error instanceof WorkbookPresentationError ||
        (error instanceof Error && error.constructor === Error)) throw new RequestError(409, conflict);
    throw error;
  }
}

async function ifAvailable<T>(work: () => Promise<T>) {
  try { return await paperRequest(work); }
  catch (error) {
    if (error instanceof RequestError && ([404, 409, 422].includes(error.status))) return undefined;
    throw error;
  }
}

async function printCandidate(tx: ReadTransaction, read: ReadContext, fact: FactSnapshot,
  kind: 'workbook' | 'posttest' | 'question' | 'textbook' | 'photo' | 'pdf') {
  const { id, rev } = fact.ref;
  const definition = { source: { id, rev }, epoch: fact.accessEpoch, layout: previewLayout };
  await admitSource(tx, read, definition);
  const project = async ({ layout, ...ref }: PaperIssuance) => {
    const { title } = await projectNewPaper(read, { layout, ...ref });
    return { kind, title, ...ref };
  };
  if (kind === 'photo' || kind === 'pdf') {
    const layered = await ifAvailable(async () => {
      const version = await readEffectiveSlotVersion<LayeredExtractionValue>(tx,
        { learner: tx.learner, type: layeredExtractionSlot, key: id }, layeredExtractionDeriver, purpose);
      if (!version) throw new RequestError(409, conflict);
      const { snapshot } = version;
      const { basis } = snapshot.outcome.value;
      const extraction = { derivationId: snapshot.id, sourceRev: basis.target.rev, modelMethod: basis.modelMethod };
      return project({ ...definition, extraction });
    });
    if (layered) return layered;
  }
  return project(definition);
}

async function listPapers(tx: ReadTransaction) {
  const read = learnerRead(tx);
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL
     ORDER BY created_tick DESC,id`, [tx.learner, [paperIssuanceType, captureSourceType, ...printKinds.keys()]]);
  const sources: Awaited<ReturnType<typeof printCandidate>>[] = [];
  const issued: { issuanceId: FactId; title: string; pageCount: number }[] = [];
  const returns: ReturnType<typeof paperReturnView>[] = [];
  for (const { id } of rows) {
    const fact = await ifAvailable(() => read.fact(id, { mode: 'following' }));
    if (!fact) continue;
    if (fact.type === paperIssuanceType) {
      const paper = await ifAvailable(async () => {
        await readIssuance(tx, read, id, fact);
        return openIssuedPaper(read, id);
      });
      if (paper) issued.push({ issuanceId: paper.issuanceId, title: paper.title, pageCount: paper.pages.length });
    } else {
      const captured = fact.type === captureSourceType ? await ifAvailable(async () => sourceEnvelope(fact.value)) : undefined;
      if (captured?.kind === 'paper-return') {
        returns.push(paperReturnView(id, fact.ref.rev, captured));
      } else if (!captured?.workbookAttachment) {
        const kind = captured?.kind === 'photo' || captured?.kind === 'pdf' ? captured.kind : printKinds.get(fact.type);
        if (kind) {
          const candidate = await ifAvailable(() => printCandidate(tx, read, fact, kind));
          if (candidate) sources.push(candidate);
        }
      }
    }
  }
  return { sources, returns, issued };
}

type Collect = ReturnType<typeof collectPaperInput>;
type PaperCommand = (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>;

async function collect(read: ReadContext, command: PaperCommand, data: Collect) {
  const runId = data.retryId ?? await defaultPaperRunId(data.issuanceId);
  await command('capture.collectPaper', data as Json);
  // Reopen all witnesses even if the command kernel replayed a saved receipt.
  if ((await collectPaperWrites(read,data)).length) throw new RequestError(409, conflict);
  const run = await read.fact(runId,{mode:'following'});
  if (run.type !== paperRunType || paperRun(run.value).issuanceId !== data.issuanceId) throw new RequestError(409, conflict);
  return {run,receipt:paperCollectionReceipt(data, runId, run.ref.rev)};
}

async function present(read: ReadContext, command: PaperCommand, { id, issue, source }: Awaited<ReturnType<typeof readIssuance>>,
  permit?: FactId) {
  const printed = await openIssuedPaper(read, id);
  if (source.type !== workbookPaperType) {
    if (permit) throw new RequestError(409, conflict);
    return { ...printed, presentation: null };
  }
  // The learner lock commits the #65 permit before the HTTP response can carry these prompts.
  const data = printedWorkbookPresentation(issue.source, printed, permit);
  const presentationId = commandId(stableId(recordWorkbookPresentationCommand, canonicalJsonString(data)));
  await command(recordWorkbookPresentationCommand, { id: presentationId, data }, presentationId);
  return { ...printed, presentation: { paper: data.paper, items: data.items, permit: presentationId } };
}

export function openCapturePapers(db: Db, capture: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  async function write<T>(run: (read: ReadContext, command: PaperCommand, tx: ReadTransaction) => Promise<T>) {
    return paperRequest(() => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const read = learnerRead(tx);
      const handle = createCommandHandler(withinLearnerTransaction(db, tx), {
        modules: [capture, activity], hooks, bindCommandRead: (inner, request, base) => bindRead(inner, base, request.purpose) });
      return run(read, async (type, data, id = commandId(stableId(type,canonicalJsonString(data))), deletionWatermark) => {
        const receipt = await handle({learner:tx.learner,actor:'learner',purpose,type,id,input:data,
          ...(deletionWatermark === undefined ? {} : {deletionWatermark})});
        if (receipt.state !== 'done') throw new RequestError(409, conflict);
      },tx);
    }));
  }

  return {
    list: () => db.snapshot(scope, listPapers),
    async issue(body: Record<string, unknown>) {
      const issue = input(() => newPaperIssuance(body));
      return write(async (read, command, tx) => {
        await admitSource(tx, read, issue);
        const { printed: { issuanceId: id }, existing } = await resolvePaperIssue(read, issue);
        if (!existing) await command('capture.issuePaper', issue, commandId(stableId('capture.issuePaper', id)));
        return present(read, command, await readIssuance(tx, read, id));
      });
    },
    async upload(selection: ReturnType<typeof paperReturnSelection>, upload: {
      command: CommandId; deletionWatermark: string; title: string; original: IntakeOriginal; install: () => Promise<void>;
    }) {
      const {source,purpose: selectedPurpose,...assignment} = selection;
      const {id,rev} = source;
      return write(async (read,command,tx) => {
        await assertUnburned(tx,'fact',[id]);
        await assertUnburned(tx,'command',[upload.command]);
        await assertDeletionWatermark(tx,upload.deletionWatermark);
        const prior = await readRecordedCommand(tx,upload.command);
        if (prior && prior.type !== captureSourceCommand) throw new RequestError(409,'同一个请求标识已用于普通交入。');
        const recordedAt = prior
          ? sourceEnvelope((await read.fact(id,{mode:'pinned',rev})).value).recordedAt
          : new Date().toISOString();
        await command(captureSourceCommand,{id,paperReturn:assignment,envelope:{
          kind:'paper-return',retentionPolicy:'retained',occurredAt:null,recordedAt,
          originals:[{...upload.original,blobRef:id}],unit:{kind:'capture',title:upload.title,blocks:[]},
        },purpose:selectedPurpose === purpose ? [purpose] : [purpose,selectedPurpose]},upload.command,upload.deletionWatermark);
        await readIssuance(tx, read, assignment.issuanceId);
        const {run,receipt} = await collect(read,command,{...assignment,source});
        const target = paperRun(run.value).pages.find(page => page.number === assignment.page);
        if (target?.source.id !== id || target.source.rev !== rev)
          throw new RequestError(409,'这页已回收。请使用原请求或另起一次作答。');
        if (!prior) {
          try { await upload.install(); }
          catch { throw new RequestError(500,'拍回原件未能保存。'); }
        }
        return {...receipt,intent:'paper-return' as const,id,revision:rev,title:upload.title,source,original:0,created:!prior};
      });
    },
    async collect(body: Record<string, unknown>) {
      const data = input(() => collectPaperInput(body));
      const {page,original,source} = data;
      if (!validPaperReturnIndices(page, original))
        throw new RequestError(400,'回收页码或原图索引无效。');
      return write(async (read,command,tx) => {
        await assertUnburned(tx,'fact',[source.id]);
        await readIssuance(tx, read, data.issuanceId);
        const {rows:[row]} = await tx.query<{assignment: unknown}>(
          `SELECT c.input#>'{input,paperReturn}' AS assignment FROM fact_revs r
          JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
          WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND c.type=$3`,[tx.learner,source.id,captureSourceCommand]);
        const {source: _,...assignment} = data;
        if (row?.assignment && canonicalJsonString(row.assignment) !== canonicalJsonString(assignment))
          throw new RequestError(409,'回收页归属与本人上传时的选择不符。');
        return (await collect(read,command,data)).receipt;
      });
    },
    async reprint(body: Record<string, unknown>) {
      const id = input(() => readPaperReprintInput(body));
      return write(async (read, command, tx) => present(read, command, await readIssuance(tx, read, id)));
    },
    async displayed(body: Record<string, unknown>) {
      const [id, permit] = input(() => readPaperDisplayInput(body));
      return write(async (read, command, tx) => {
        await present(read, command, await readIssuance(tx, read, id), permit);
        return { recorded: true };
      });
    },
  };
}
