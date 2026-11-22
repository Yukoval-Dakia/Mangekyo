import {
  accessPurpose, checkBodyReference, pageView, textbookWriteReceipt as writeReceipt,
  type TextbookCreateInput, type TextbookGetInput, type TextbookOpenBlockInput, type TextbookPageView,
  type TextbookReadInput, type TextbookReviseInput, type TextbookSummary, type TextbookWriteReceipt,
  TextbookConflictError,
} from '../../modules/content/textbook-view.ts';
import { withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { sourceReference } from '../../modules/activity/source-values.ts';
import { checkStudioNotionFact, confirmNotionRead, type CheckNotionRead } from './notion.ts';
import { resolveSource } from './source-read.ts';
import { createCommandHandler, readCommandProposals, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { commandId, type CommandId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
import type {
  CommandReceipt,
  Json,
} from '../../kernel/src/declarations/types.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { organizerNote, organizerNoteType, projectLegacyTextbookNote as legacyView } from '../../modules/activity/organizer-values.ts';
import { key, pageId } from '../../modules/content/parse.ts';
import { parseTextbookRevision, previewTextbookRevision, selectTextbookEdits, type TextbookRevision } from '../../modules/content/textbook-edits.ts';
import {
  checkTextbookBasis,
  openTextbookBlock,
  textbookPageFrom,
  textbookPageType,
} from '../../modules/content/textbook-page.ts';
import {
  listRowTypes,
  missingUndoChange,
  parseSelectedTextbookBlockIds,
  parseTextbookInput,
  parseTextbookPageId,
  previewTextbookProposal,
  textbookProposalView,
  textbookProposalsBody,
  textbookProposalReadBody,
  textbookProposalDecideBody,
  textbookGetBody,
  textbookClaimBody,
  textbookOpenBlockBody,
  textbookListRowsBody,
  textbookReadFact,
  prepareTextbookGet,
  prepareTextbookAccess,
  issueBankArgs,
  runTextbookReviseTail,
  runTextbookConflict,
  runTextbookUndo,
  planTextbookCreate,
  planTextbookRevise,
  priorEditInputOf,
  scopedTextbookLearner,
  translateTextbookRead,
  translateTextbookWrite,
  undoTokenFor,
} from '../../modules/content/studio-textbook-helpers.ts';
import { purpose as teaching, textbookUndoId } from './identity.ts';
import { RequestError } from './sessions.ts';
import { createTextbookCommand as createCommand, reviseTextbookCommand as reviseCommand, reviseTextbookDraftCommand,
  undoTextbookCommand } from './workspace-textbook.ts';
import { textbookMasteryPulse, type TextbookPulseHost } from './textbook-pulse.ts';
import { parseTextbookPulseClaim, textbookPulseClaimMatches } from '../../modules/activity/textbook-pulse-evidence.ts';

const storage = 'storage';
const helpers = {
  RequestError,
  isFactNotFound: (error: unknown) => error instanceof FactNotFoundError,
  isFactDenied: (error: unknown) => error instanceof FactReadDeniedError,
  isRetracted: (error: unknown) => error instanceof FactReadDeniedError && error.reason === 'retracted',
  sourceUnavailable: () => new FactReadDeniedError('recipient','教材的来源已不可用。'),
  canonicalJsonString,
  organizerNoteType,
  organizerNote,
  createTextbookCommand: createCommand,
  reviseTextbookCommand: reviseCommand,
  reviseTextbookDraftCommand,
  undoTextbookCommand,
  textbookUndoId,
};

export { TextbookConflictError };

const readFactHost = {
  readContext: (tx: ReadTransaction, use: string) => createCommandReadContext(tx, use),
  checkStudioNotionFact,
  resolveSource,
  sourceReference,
  sourceUnavailable: helpers.sourceUnavailable,
};
const readFact = (tx: ReadTransaction, check: CheckNotionRead, purpose: string, id: string, rev?: unknown) => textbookReadFact(tx, check, readFactHost as never, purpose, id, rev);

export function openTextbook(db: Db, contentModule: LoadedModule, hooks: CommandHooks,
  pulse?: TextbookPulseHost, issueBank?: (tx: DbTransaction,
    input: { requestId: string; questionRefs: readonly { id: import('../../kernel/src/declarations/ids.ts').FactId; rev: import('../../kernel/src/declarations/ids.ts').Revision }[]; deletionWatermark?: string },
  ) => Promise<{ id: import('../../kernel/src/declarations/ids.ts').FactId }>,
) {
  const handle = createCommandHandler(db, { modules: [contentModule], hooks });
  const lambdaHost = (tx: ReadTransaction, check: CheckNotionRead) => ({
    readFact,
    readProposals: (inner: ReadTransaction, type: string, filter: {id: ReturnType<typeof pageId>}, proposalId?: CommandId) => readCommandProposals(inner, type, filter, proposalId),
    readRecordedCommand,
    proposalView,
    previewProposal,
    readContext: (inner: ReadTransaction, use: string) => createCommandReadContext(inner, use),
    pageView,
    textbookMasteryPulse: (inner: ReadTransaction, innerCheck: CheckNotionRead, view: unknown, pulseHost: unknown) => textbookMasteryPulse(inner, innerCheck, view as never, pulseHost as never),
    legacyView,
    openTextbookBlock,
    checkBodyReference,
    parseTextbookPulseClaim,
    textbookPulseClaimMatches,
    textbookPageFrom,
    organizerNote,
    reviseCommand,
  });
  type Proposal = Awaited<ReturnType<typeof readCommandProposals>>[number];

  const proposalHost = {
    readFact,
    checkTextbookBasis,
    previewTextbookRevision,
    readRecordedCommand,
    teaching,
    storage,
  };
  const previewProposal = async (tx: ReadTransaction, check: CheckNotionRead, input: unknown) => (await previewTextbookProposal(proposalHost as never, tx, check, input, parseTextbookRevision)) as Awaited<ReturnType<typeof previewTextbookRevision>>;
  const proposalView = (tx: ReadTransaction, check: CheckNotionRead, proposal: Proposal) => textbookProposalView(helpers, proposalHost as never, tx, check, proposal, parseTextbookRevision);

  async function get(input: TextbookGetInput): Promise<TextbookPageView | ReturnType<typeof legacyView>> {
    const { learner, purpose } = prepareTextbookGet(helpers, input);
    return (confirmNotionRead(db, learner, (tx, check) => textbookGetBody(helpers, lambdaHost(tx, check) as never, tx, check, { id: pageId(input.id), rev: input.rev, purpose, pulse })) as Promise<TextbookPageView | ReturnType<typeof legacyView>>).catch(error => translateTextbookRead(helpers, error));
  }

  const conflict = (code: TextbookConflictError['code'], input: TextbookReviseInput, originalEdit: TextbookRevision, requestId: string, previousReceipt?: CommandReceipt): Promise<never> => runTextbookConflict(helpers, () => get({ learner: input.learner, id: originalEdit.id, purpose: input.purpose }), code, originalEdit, requestId, TextbookConflictError as never, previousReceipt);

  async function priorEdit(learner: LearnerId, edit: TextbookRevision, purpose: string) {
    const { rows } = await db.query<{ id: CommandId; receipt: CommandReceipt; input: unknown }>(
      `SELECT id,receipt,input FROM commands
       WHERE learner_id=$1 AND type=$2 AND state='done'
       AND input->>'purpose'=$3
       AND input->'input'->>'id'=$4 AND input->'input'->>'clientEditSeq'=$5
       ORDER BY tick,id LIMIT 1`,
      [learner, reviseCommand, purpose, edit.id, String(edit.clientEditSeq)],
    );
    return priorEditInputOf(rows[0]);
  }

  return {
    async proposals(input: TextbookGetInput) {
      const learner = scopedTextbookLearner(helpers, input.learner);
      const id = parseTextbookPageId(helpers, input.id);
      return confirmNotionRead(db, learner, (tx, check) => textbookProposalsBody(helpers, lambdaHost(tx, check) as never, tx, check, id)).catch(error => translateTextbookWrite(helpers, error));
    },
    async proposal(input: TextbookGetInput, proposalId: string, selection?: { blockIds: unknown }) {
      const learner = scopedTextbookLearner(helpers, input.learner);
      const id = parseTextbookPageId(helpers, input.id);
      const proposalKey = commandId(proposalId);
      const read = (tx: ReadTransaction, check: CheckNotionRead) => textbookProposalReadBody(helpers, lambdaHost(tx, check) as never, tx, check, id, proposalKey);
      if (!selection) return confirmNotionRead(db, learner, read).catch(error => translateTextbookWrite(helpers, error));
      const {blockIds} = selection;
      const selected = parseSelectedTextbookBlockIds(helpers, blockIds);
      return confirmNotionRead(db, learner, read, async (tx, check) => {
        return textbookProposalDecideBody(helpers, {
          ...lambdaHost(tx, check),
          decideProposal: (inner: DbTransaction, decision: Record<string, unknown>, select: (i: DbTransaction, input: unknown) => Promise<unknown>) => createCommandHandler(withinLearnerTransaction(db, inner), {modules:[contentModule], hooks})
              .decideProposal(decision as never, select as never),
        } as never, tx, check, { learner, id, proposalKey, selected, selectTextbookEdits: (preview, sel) => selectTextbookEdits(preview as never, sel) });
      }).catch(error => translateTextbookWrite(helpers, error));
    },
    async undo(input: TextbookGetInput, token: unknown) {
      const learner = scopedTextbookLearner(helpers, input.learner);
      const id = parseTextbookPageId(helpers, input.id);
      const undoToken = undoTokenFor(helpers, token);
      const {rows:[original]} = await db.query<{rev:number; priorRev:number|null}>(
        `SELECT r.rev,r.corrects_rev AS "priorRev"
         FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
         JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.id=$3 AND c.state='done' AND f.type=$4
           AND ((c.type=ANY($5::text[]) AND r.author='companion') OR
             (c.type=$6 AND r.author='learner' AND c.input->'input' ? 'proposalId'))`,
        [learner,id,undoToken,textbookPageType,[createCommand,reviseTextbookDraftCommand],reviseCommand]);
      if (!original) return missingUndoChange(helpers);
      return runTextbookUndo(helpers, { handle, textbookUndoId, undoTextbookCommand }, { learner, id, undoToken, original });
    },

    async list(input: TextbookReadInput) {
      const { learner, purpose } = prepareTextbookAccess(helpers, input);
      return confirmNotionRead(db, learner, async (tx, check) => {
        const { rows } = await tx.query<{ id: string; type: string }>(
          `SELECT id,type FROM facts
           WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL
           ORDER BY created_tick DESC,id DESC`,
          [learner, listRowTypes(helpers)],
        );
        return textbookListRowsBody(helpers, lambdaHost(tx, check) as never, tx, check, rows, purpose) as Promise<{pages: TextbookSummary[]; legacyNotes: TextbookSummary[]}>;
      }).catch(error => translateTextbookRead(helpers, error));
    },

    get,

    async claim(input: TextbookGetInput, claim: Record<string, unknown>) {
      const learner = scopedTextbookLearner(helpers, input.learner);
      if (!pulse || !issueBank) throw new RequestError(404, '教材快检未开放。');
      const id = parseTextbookPageId(helpers, input.id);
      const selectedClaim = parseTextbookInput(helpers, () => parseTextbookPulseClaim(claim, id));
      return confirmNotionRead(db, learner, (tx, check) => textbookClaimBody(helpers, lambdaHost(tx, check) as never, tx, check, { id, teaching, pulse, selectedClaim }), async tx => issueBank(tx, {
        ...(issueBankArgs(selectedClaim) as { requestId: string; questionRefs: { id: typeof selectedClaim.id; rev: typeof selectedClaim.rev }[]; deletionWatermark?: string }),
      })).catch(error => translateTextbookWrite(helpers, error));
    },

    async openBlock(input: TextbookOpenBlockInput) {
      const { learner, purpose } = prepareTextbookAccess(helpers, input);
      return confirmNotionRead(db, learner, (tx, check) => textbookOpenBlockBody(helpers, lambdaHost(tx, check) as never, tx, check, { id: pageId(input.id), rev: input.rev, blockId: key(input.blockId), mode: input.mode, purpose, learner })).catch(error => translateTextbookRead(helpers, error));
    },

    async create(input: TextbookCreateInput): Promise<TextbookWriteReceipt> {
      const plan = planTextbookCreate(helpers, input);
      const receipt = await handle({
        learner: plan.learner, actor: 'learner', purpose: plan.accessPurpose, type: createCommand,
        id: plan.commandIdValue,
        input: plan.commandInput,
      }).catch(error => translateTextbookWrite(helpers, error));
      return writeReceipt(receipt, plan.requestId, { id: plan.id, clientEditSeq: plan.clientEditSeq, expectedRev: null });
    },

    async revise(input: TextbookReviseInput): Promise<TextbookWriteReceipt> {
      const plan = planTextbookRevise(helpers, input);
      const { learner, requestId, originalEdit, commandKey: key, purpose } = plan;
      const prior = await priorEdit(learner, originalEdit, purpose);
      if (prior && prior.id !== key) {
        if (canonicalJsonString(prior.input.input) === canonicalJsonString(originalEdit)) {
          return writeReceipt(prior.receipt, requestId, originalEdit);
        }
        return conflict('CLIENT_EDIT_SEQ_CONFLICT', input, originalEdit, requestId, prior.receipt);
      }
      try {
        const receipt = await handle({
          learner, actor: 'learner', purpose, type: reviseCommand,
          id: key, input: originalEdit as Json,
        });
        return writeReceipt(receipt, requestId, originalEdit);
      } catch (error) {
        return runTextbookReviseTail(helpers, {
          get: (args) => get(args as never) as never,
          conflict: (code, edit) => conflict(code, input, edit, requestId),
        }, { error, originalEdit, learner, purpose: input.purpose });
      }
    },
  };
}
