import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner, withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { assertDeletionWatermark, assertUnburned, LifecycleError } from '../../kernel/src/lifecycle.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, type CommandId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json, ReadContext } from '../../kernel/src/declarations/types.ts';
import { readEffectiveSlotVersion } from '../../kernel/src/derivations/revalidate.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { issuedPosttestPaper, posttestIssuanceType, retentionPaperType, retentionTeachingPurpose } from '../../modules/activity/retention-posttest.ts';
import { printedWorkbookPresentation, recordWorkbookPresentationCommand, WorkbookPresentationError } from '../../modules/activity/workbook-presentation.ts';
import { workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { layeredExtractionDeriver, layeredExtractionSlot } from '../../modules/capture/extraction.ts';
import {
  checkedPaperIssuance, collectPaperInput, collectPaperWrites, defaultPaperRunId, newPaperIssuance,
  openIssuedPaper, paperCollectionReceipt, paperIssuanceType, paperReturnSelection, paperReturnView, paperRun, paperRunType,
  projectNewPaper, readPaperDisplayInput, readPaperReprintInput, resolvePaperIssue, validPaperReturnIndices,
  type PaperIssuance,
} from '../../modules/capture/paper.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { AssetBasisError, assetType, textbookPageType } from '../../modules/content/asset.ts';
import type { IntakeOriginal } from '../../modules/capture/intake-values.ts';
import {
  bindStudioPaperRead,
  buildPrintKinds,
  checkIssuanceStored,
  invalidReturnIndices,
  paperUnavailable,
  parsePaperInput,
  translatePaperRequestError,
  runPaperCollect,
  runPaperUpload,
  paperCommandDone,
  paperDisplayInput,
  paperReprintId,
  runPaperIssue,
  runPaperCollectBody,
  paperListRow,
  admitPaperSource,
  paperPrintCandidate,
  runPaperPresent,
} from '../../modules/capture/studio-capture-papers-helpers.ts';
import { stableId, studioLearner } from './identity.ts';
import { readPosttestIssuance } from './retention-posttest.ts';

const purpose = 'storage';
const scope = { learner: studioLearner };
const printKinds = buildPrintKinds({ workbookPaperType, posttestIssuanceType, assetType, textbookPageType });
const paperErrors = { WorkbookPresentationError, AssetBasisError, isLifecycle: (error: unknown) => error instanceof LifecycleError, isDenied: (error: unknown) => error instanceof FactReadDeniedError, isNotFound: (error: unknown) => error instanceof FactNotFoundError };
const paperListDeps = { paperIssuanceType, captureSourceType, printKinds };


function bindRead(tx: ReadTransaction, base: ReadContext, use: string) {
  return bindStudioPaperRead(tx, base, use, { readEffectiveSlotVersion });
}

const learnerRead = (tx: ReadTransaction) => bindRead(tx, createCommandReadContext(tx, purpose), purpose);

const admitHost = {
  retentionPaperType,
  posttestIssuanceType,
  readPosttestIssuance: (tx: ReadTransaction, read: ReadContext, id: FactId) => readPosttestIssuance(tx, read, id),
  issuedPosttestPaper: (read: ReadContext, issuance: unknown) => issuedPosttestPaper(read as never, issuance as never),
  retentionTeachingPurpose,
  readContext: (tx: ReadTransaction, use: string) => createCommandReadContext(tx, use) as never,
};
const admitSource = (tx: ReadTransaction, read: ReadContext, issuance: PaperIssuance) => admitPaperSource(admitHost as never, tx, read, issuance);

async function readIssuance(tx: ReadTransaction, read: ReadContext, id: FactId,
  fact?: FactSnapshot) {
  const stored = fact ?? await read.fact(id, { mode: 'following' });
  checkIssuanceStored(stored, paperIssuanceType);
  const issue = await checkedPaperIssuance(stored, id);
  return { id, issue, source: await admitSource(tx, read, issue) };
}

function input<T>(parse: () => T): T {
  return parsePaperInput(parse);
}

async function paperRequest<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) { return translatePaperRequestError(paperErrors, error); }
}

async function ifAvailable<T>(work: () => Promise<T>) {
  try { return await paperRequest(work); }
  catch (error) {
    if (paperUnavailable(error)) return undefined;
    throw error;
  }
}

async function printCandidate(tx: ReadTransaction, read: ReadContext, fact: FactSnapshot,
  kind: 'workbook' | 'posttest' | 'question' | 'textbook' | 'photo' | 'pdf') {
  return paperPrintCandidate({
    readEffectiveSlotVersion: (inner: ReadTransaction, slot: never, deriver: string, use: string) => readEffectiveSlotVersion(inner, slot as never, deriver, use) as never,
    layeredExtractionSlot,
    layeredExtractionDeriver,
    projectNewPaper: (inner: ReadContext, def: unknown) => projectNewPaper(inner, def as never),
    admitSource: (inner: ReadTransaction, innerRead: ReadContext, def: unknown) => admitSource(inner, innerRead, def as PaperIssuance),
    ifAvailable,
    purpose,
  } as never, tx, read, fact, kind);
}

async function listPapers(tx: ReadTransaction) {
  const read = learnerRead(tx);
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL
     ORDER BY created_tick DESC,id`, [tx.learner, [paperIssuanceType, captureSourceType, ...printKinds.keys()]]);
  const sources: Awaited<ReturnType<typeof printCandidate>>[] = [];
  const issued: { issuanceId: FactId; title: string; pageCount: number }[] = [];
  const returns: ReturnType<typeof paperReturnView>[] = [];
  const rowHost = {
    ifAvailable,
    readFact: (inner: ReadContext, id: FactId) => inner.fact(id, { mode: 'following' }),
    readIssuance: (inner: ReadTransaction, innerRead: ReadContext, id: FactId, fact: never) => readIssuance(inner, innerRead, id, fact as never),
    openIssuedPaper: (inner: ReadContext, id: FactId) => openIssuedPaper(inner, id),
    sourceEnvelopeOf: (value: unknown) => sourceEnvelope(value) as { kind?: string; workbookAttachment?: unknown },
    printCandidate: (inner: ReadTransaction, innerRead: ReadContext, fact: never, kind: never) => printCandidate(inner, innerRead, fact as never, kind as never),
    ...paperListDeps,
  };
  for (const { id } of rows) {
    const outcome = await paperListRow(rowHost as never, tx, read, id);
    if (!outcome) continue;
    if ('issued' in outcome) issued.push(outcome.issued);
    else if ('returned' in outcome) returns.push(outcome.returned);
    else if ('sourced' in outcome) sources.push(outcome.sourced as never);
  }
  return { sources, returns, issued };
}

type Collect = ReturnType<typeof collectPaperInput>;
type PaperCommand = (type: string, data: Json, id?: CommandId, deletionWatermark?: string) => Promise<void>;

async function collect(read: ReadContext, command: PaperCommand, data: Collect) {
  // Reopen all witnesses even if the command kernel replayed a saved receipt.
  return runPaperCollect({ collectPaperWrites, defaultPaperRunId, paperRunType, paperCollectionReceipt }, read, command, data);
}

async function present(read: ReadContext, command: PaperCommand, { id, issue, source }: Awaited<ReturnType<typeof readIssuance>>,
  permit?: FactId) {
  // The learner lock commits the #65 permit before the HTTP response can carry these prompts.
  return runPaperPresent({ openIssuedPaper, printedWorkbookPresentation, workbookPaperType,
    recordWorkbookPresentationCommand, commandIdOf: commandId, stableIdOf: stableId, canonicalJsonString },
    read, command, { id, issue, source }, permit);
}

export function openCapturePapers(db: Db, capture: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  async function write<T>(run: (read: ReadContext, command: PaperCommand, tx: ReadTransaction) => Promise<T>) {
    return paperRequest(() => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const read = learnerRead(tx);
      const handle = createCommandHandler(withinLearnerTransaction(db, tx), {
        modules: [capture, activity], hooks, bindCommandRead: (inner, request, base) => bindRead(inner, base, request.purpose) });
      return run(read, (type, data, id = commandId(stableId(type,canonicalJsonString(data))), deletionWatermark) => paperCommandDone(handle, tx, type, data, id, deletionWatermark), tx);
    }));
  }


  return {
    list: () => db.snapshot(scope, listPapers),
    async issue(body: Record<string, unknown>) {
      const issue = input(() => newPaperIssuance(body));
      return write((read, command, tx) => runPaperIssue({
        admitSource: (inner, innerRead, issue) => admitSource(inner, innerRead, issue as never), resolvePaperIssue: (innerRead, issue) => resolvePaperIssue(innerRead, issue as never), readIssuance: (inner, innerRead, id) => readIssuance(inner, innerRead, id),
        present: (innerRead, cmd, issuance) => present(innerRead, cmd, issuance as never), commandIdOf: commandId, stableIdOf: stableId, learner: studioLearner, purpose,
      }, tx, read, command, issue as never));
    },
    async upload(selection: ReturnType<typeof paperReturnSelection>, upload: {
      command: CommandId; deletionWatermark: string; title: string; original: IntakeOriginal; install: () => Promise<void>;
    }) {
      return write((read, command, tx) => runPaperUpload({
        assertUnburned,
        assertDeletionWatermark,
        readRecordedCommand,
        readFact: (inner, id, options) => inner.fact(id, options),
        sourceEnvelopeOf: sourceEnvelope,
        readIssuance: (inner, innerRead, id) => readIssuance(inner, innerRead, id),
        collect,
        paperRunPages: value => paperRun(value).pages,
        captureSourceCommand,
      }, tx, read, command, { selection: selection as never, upload, storagePurpose: purpose }));
    },
    async collect(body: Record<string, unknown>) {
      const data = input(() => collectPaperInput(body));
      const {page,original,source} = data;
      if (!validPaperReturnIndices(page, original)) throw invalidReturnIndices();
      return write((read,command,tx) => runPaperCollectBody({
        assertUnburned,
        readIssuance: (inner, innerRead, id) => readIssuance(inner, innerRead, id),
        readAssignment: async inner => (await inner.query<{assignment: unknown}>(
          `SELECT c.input#>'{input,paperReturn}' AS assignment FROM fact_revs r
          JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
          WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND c.type=$3`,[inner.learner,source.id,captureSourceCommand])).rows[0],
        collect,
        canonicalJsonString,
      }, tx, read, command, data));
    },
    async reprint(body: Record<string, unknown>) {
      const id = paperReprintId(readPaperReprintInput, body);
      return write(async (read, command, tx) => present(read, command, await readIssuance(tx, read, id)));
    },
    async displayed(body: Record<string, unknown>) {
      const [id, permit] = paperDisplayInput(readPaperDisplayInput, body);
      return write(async (read, command, tx) => {
        await present(read, command, await readIssuance(tx, read, id), permit);
        return { recorded: true };
      });
    },
  };
}
