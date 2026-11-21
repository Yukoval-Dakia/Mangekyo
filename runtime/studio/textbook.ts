import { invalid, parseInput, scopedLearner, selectedBlockIds, TextbookConflictError } from '../../surfaces/shared/textbook-request.ts';
export { TextbookConflictError } from '../../surfaces/shared/textbook-request.ts';
import {
  textbookProposalView, textbookWriteProblem, accessPurpose, checkBodyReference, creationPurposes, pageView, textbookWriteReceipt as writeReceipt, TextbookReferenceScopeError,
  type TextbookCreateInput, type TextbookGetInput, type TextbookOpenBlockInput, type TextbookPageView,
  type TextbookReadInput, type TextbookReviseInput, type TextbookSummary, type TextbookWriteReceipt,
} from '../../modules/content/textbook-view.ts';
import { openTurnDistillation } from './turn-distillation.ts';
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
import { commandId, factId, type CommandId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
import type {
  CommandReceipt,
  FactSnapshot,
  Json,
  ReadContext,
} from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { organizerNote, organizerNoteType, projectLegacyTextbookNote as legacyView } from '../../modules/activity/organizer-values.ts';
import { editSequence, key, pageId, revision } from '../../modules/content/parse.ts';
import { parseTextbookRevision, previewTextbookRevision, selectTextbookEdits, type TextbookRevision } from '../../modules/content/textbook-edits.ts';
import { checkTextbookBasis, openTextbookBlock, parseTextbookPage, textbookPageFrom, textbookPageType } from '../../modules/content/textbook-page.ts';
import { purpose as teaching, stableId, textbookUndoId } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { createTextbookCommand as createCommand, reviseTextbookCommand as reviseCommand, reviseTextbookDraftCommand,
  undoTextbookCommand } from './workspace-textbook.ts';

const storage = 'storage';
const decisionId = (proposalId: string) => commandId(stableId('textbook-proposal-decision', proposalId));

function translateRead(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof FactNotFoundError) throw new RequestError(404, '找不到这份教材或笔记。');
  if (error instanceof TextbookReferenceScopeError) throw new RequestError(403, error.message);
  if (error instanceof FactReadDeniedError) throw new RequestError(403, '当前用途不能读取这份内容或其引用。');
  throw error;
}

function translateWrite(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof FactNotFoundError) throw new RequestError(404, '找不到要编辑的教材或引用。');
  if (error instanceof FactReadDeniedError) throw new RequestError(403, '当前用途不能读取或引用这份内容。');
  const problem = textbookWriteProblem(error);
  if (problem) throw new RequestError(problem.status, problem.message);
  throw error;
}

async function readFact(tx: ReadTransaction, check: CheckNotionRead, purpose: string, id: string, rev?: unknown) {
  const read = createCommandReadContext(tx,purpose);
  const fact = await read.fact(pageId(id),rev === undefined ? {mode:'following'} : {mode:'pinned',rev:revision(rev)});
  await checkStudioNotionFact(tx,fact,storage,'learner');
  const sources: FactSnapshot[] = [fact];
  if (fact.type === textbookPageType) {
    const page = textbookPageFrom(fact);
    if ((page.basis?.length || page.blocks.some(({body}) => body.kind === 'reference' || body.kind === 'image')) &&
        !await resolveSource(tx,sourceReference(fact,{kind:'whole'}),{recipient:'learner',track: source => sources.push(source)}))
      throw new FactReadDeniedError('recipient','教材的来源已不可用。');
  }
  for (const source of sources) await check(source);
  return fact;
}

export function openTextbook(db: Db, contentModule: LoadedModule, hooks: CommandHooks) {
  const handle = createCommandHandler(db, { modules: [contentModule], hooks });
  const distillation = openTurnDistillation(db, {modules:[contentModule], hooks}, (tx, check) => ({
    fact: (id, options) => readFact(tx, check, storage, id, options.mode === 'pinned' ? options.rev : undefined),
  }));
  type Proposal = Awaited<ReturnType<typeof readCommandProposals>>[number];

  async function previewProposal(tx: ReadTransaction, check: CheckNotionRead, input: unknown) {
    const edit = parseTextbookRevision(input);
    const read = {fact:(...[id, options]: Parameters<ReadContext['fact']>) =>
      readFact(tx,check,teaching,id,options.mode === 'pinned' ? options.rev : undefined)};
    const pinned = await readFact(tx,check,teaching,edit.id,edit.expectedRev);
    await checkTextbookBasis(read,[...textbookPageFrom(pinned).basis ?? [], ...edit.basis ?? []]);
    return previewTextbookRevision({learner:tx.learner,read},edit);
  }

  async function proposalView(tx: ReadTransaction, check: CheckNotionRead, proposal: Proposal) {
    const {base,items} = await previewProposal(tx,check,proposal.input);
    const current = await readFact(tx,check,storage,base.id);
    const decision = await readRecordedCommand(tx,decisionId(proposal.id));
    return textbookProposalView(proposal,base,items,current.ref.rev,decision?.receipt as CommandReceipt | undefined,decisionId(proposal.id));
  }

  async function get(input: TextbookGetInput): Promise<TextbookPageView | ReturnType<typeof legacyView>> {
    const learner = scopedLearner(input.learner);
    const purpose = parseInput(() => accessPurpose(input.purpose));
    return confirmNotionRead(db, learner, async (tx, check) => {
      const fact = await readFact(tx,check, purpose, pageId(input.id), input.rev);
      if (fact.type === textbookPageType) return pageView(createCommandReadContext(tx, purpose), fact);
      if (fact.type === organizerNoteType) return legacyView(fact);
      throw new RequestError(404, '这份内容不是个人教材或旧笔记。');
    }).catch(translateRead);
  }

  async function conflict(
    code: TextbookConflictError['code'], input: TextbookReviseInput, originalEdit: TextbookRevision,
    requestId: string, previousReceipt?: CommandReceipt,
  ): Promise<never> {
    const current = await get({ learner: input.learner, id: originalEdit.id, purpose: input.purpose });
    if (current.kind !== 'textbook') throw new RequestError(409, '旧笔记是只读内容，不能作为教材修订。');
    throw new TextbookConflictError(code, current, originalEdit, requestId, previousReceipt);
  }

  async function priorEdit(learner: LearnerId, edit: TextbookRevision, purpose: string) {
    const { rows } = await db.query<{ id: CommandId; receipt: CommandReceipt; input: unknown }>(
      `SELECT id,receipt,input FROM commands
       WHERE learner_id=$1 AND type=$2 AND state='done'
       AND input->>'purpose'=$3
       AND input->'input'->>'id'=$4 AND input->'input'->>'clientEditSeq'=$5
       ORDER BY tick,id LIMIT 1`,
      [learner, reviseCommand, purpose, edit.id, String(edit.clientEditSeq)],
    );
    const row = rows[0];
    return row && { ...row, input: typeof row.input === 'string' ? JSON.parse(row.input) : row.input };
  }

  return {
    distill: distillation.distill,
    async proposals(input: TextbookGetInput) {
      const learner = scopedLearner(input.learner);
      const id = parseInput(() => pageId(input.id));
      return confirmNotionRead(db, learner, async (tx, check) => {
        textbookPageFrom(await readFact(tx,check,storage,id));
        const proposals = [];
        for (const proposal of await readCommandProposals(tx,reviseCommand,{id})) {
          try {
            const {proposalId,status,base} = await proposalView(tx,check,proposal);
            proposals.push({proposalId,status,base});
          } catch (error) {
            if (!(error instanceof FactReadDeniedError || error instanceof FactNotFoundError ||
                (error instanceof Error && error.message === '教材依据已变更。'))) throw error;
          }
        }
        return {proposals};
      }).catch(translateWrite);
    },
    async proposal(input: TextbookGetInput, proposalId: string, selection?: { blockIds: unknown }) {
      const learner = scopedLearner(input.learner);
      const id = parseInput(() => pageId(input.id));
      const proposalKey = commandId(proposalId);
      const read = async (tx: ReadTransaction, check: CheckNotionRead) => {
        const [proposal] = await readCommandProposals(tx,reviseCommand,{id},proposalKey);
        if (!proposal) throw new RequestError(404, '找不到教材提议。');
        return proposalView(tx,check,proposal);
      };
      if (!selection) return confirmNotionRead(db, learner, read).catch(translateWrite);
      const selected = selectedBlockIds(selection.blockIds, key);
      return confirmNotionRead(db, learner, read, async (tx, check) => {
        await read(tx, check);
        const decide = createCommandHandler(withinLearnerTransaction(db, tx), {modules:[contentModule], hooks});
        await decide.decideProposal({learner, purpose:storage, type:reviseCommand, id:decisionId(proposalKey),
          proposalId:proposalKey, selection:selected}, async (inner, proposedInput) => {
          const edit = parseTextbookRevision(proposedInput);
          if (edit.id !== id) throw new RequestError(404, '找不到教材提议。');
          const preview = await previewProposal(inner,check,proposedInput);
          if (!selected.length) return null;
          if ((await readFact(inner,check,storage,id)).ref.rev !== edit.expectedRev)
            throw new RequestError(409, '教材已更新。');
          return parseInput(() => selectTextbookEdits(preview,selected));
        });
        return read(tx, check);
      }).catch(translateWrite);
    },
    async undo(input: TextbookGetInput, token: unknown) {
      const learner = scopedLearner(input.learner);
      const id = parseInput(() => pageId(input.id));
      const undoToken = parseInput(() => commandId(key(token)));
      const {rows:[original]} = await db.query<{rev:number; priorRev:number|null; grouped:boolean}>(
        `SELECT r.rev,r.corrects_rev AS "priorRev", c.input->'input'->'selection' ? 'confirmationId' AS grouped
         FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
         JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.id=$3 AND c.state='done' AND f.type=$4
           AND ((c.type=ANY($5::text[]) AND r.author='companion') OR
             (c.type=$6 AND r.author='learner' AND c.input->'input' ? 'proposalId'))`,
        [learner,id,undoToken,textbookPageType,[createCommand,reviseTextbookDraftCommand],reviseCommand]);
      if (!original) throw new RequestError(404, '找不到可撤回的教材变更。');
      if (original.grouped) return db.tx({learner}, tx => distillation.undoGroup(tx, id, undoToken)).catch(translateWrite);
      const receipt = await handle({learner, actor:'learner', purpose:storage,
        id:textbookUndoId(undoToken), type:undoTextbookCommand,
        input:{id,expectedRev:original.rev,priorRev:original.priorRev},
      }).catch(error => {
        if (error instanceof FactReadDeniedError && error.reason === 'retracted')
          throw new RequestError(409, '教材已撤回。');
        return translateWrite(error);
      });
      return {status:original.priorRev === null ? 'withdrawn' : 'reverted',ref:{id,rev:receipt.wrote[0]!.rev}};
    },

    async list(input: TextbookReadInput) {
      const learner = scopedLearner(input.learner);
      const purpose = parseInput(() => accessPurpose(input.purpose));
      return confirmNotionRead(db, learner, async (tx, check) => {
        const { rows } = await tx.query<{ id: string; type: string }>(
          `SELECT id,type FROM facts
           WHERE learner_id=$1 AND type=ANY($2::text[]) AND retracted_rev IS NULL
           ORDER BY created_tick DESC,id DESC`,
          [learner, [textbookPageType, organizerNoteType]],
        );
        const pages: TextbookSummary[] = [];
        const legacyNotes: TextbookSummary[] = [];
        for (const row of rows) {
          try {
            const fact = await readFact(tx,check, purpose, row.id);
            const view = fact.type === textbookPageType
              ? { title: textbookPageFrom(fact).title, kind: 'textbook' as const, readOnly: false }
              : { title: organizerNote(fact.value).title, kind: 'legacyNote' as const, readOnly: true };
            const summary = { id: row.id, rev: fact.ref.rev, purpose: fact.purpose, ...view };
            (view.kind === 'textbook' ? pages : legacyNotes).push(summary);
          } catch (error) {
            if (!(error instanceof FactReadDeniedError) && !(error instanceof FactNotFoundError)) throw error;
          }
        }
        return { pages, legacyNotes };
      }).catch(translateRead);
    },

    get,

    async openBlock(input: TextbookOpenBlockInput) {
      const learner = scopedLearner(input.learner);
      const purpose = parseInput(() => accessPurpose(input.purpose));
      return confirmNotionRead(db, learner, async (tx, check) => {
        const read = createCommandReadContext(tx, purpose);
        const base = await readFact(tx,check, purpose, pageId(input.id), input.rev);
        if (base.type !== textbookPageType) throw new RequestError(404, '旧笔记没有教材块。');
        const mode = input.mode ?? 'pinned';
        if (mode !== 'pinned' && mode !== 'following') invalid('教材块定位方式无效。');
        const opened = await openTextbookBlock(read, base.ref, key(input.blockId), mode);
        await readFact(tx,check,purpose,opened.ref.id,opened.ref.rev);
        const source = await checkBodyReference(read, learner, opened.block.id, opened.block.body);
        return { kind: 'textbookBlock' as const, ...opened, source };
      }).catch(translateRead);
    },

    async create(input: TextbookCreateInput): Promise<TextbookWriteReceipt> {
      const learner = scopedLearner(input.learner);
      const requestId = clientRequest(input.requestId);
      const purposes = parseInput(() => creationPurposes(input.purpose));
      const page = parseInput(() => parseTextbookPage(input.page));
      const id = input.id === undefined
        ? factId(stableId('textbook-page', learner, requestId, canonicalJsonString(page as Json)))
        : pageId(input.id);
      const clientEditSeq = parseInput(() => editSequence(input.clientEditSeq));
      const commandInput = { id, clientEditSeq, purpose: purposes.fact, page };
      const receipt = await handle({
        learner, actor: 'learner', purpose: purposes.access, type: createCommand,
        id: commandId(stableId('textbook-command', learner, createCommand, requestId)),
        input: commandInput as Json,
      }).catch(translateWrite);
      return writeReceipt(receipt, requestId, { id, clientEditSeq, expectedRev: null });
    },

    async revise(input: TextbookReviseInput): Promise<TextbookWriteReceipt> {
      const learner = scopedLearner(input.learner);
      const requestId = clientRequest(input.requestId);
      const originalEdit = parseInput(() => parseTextbookRevision({
        id: input.id, expectedRev: input.expectedRev, clientEditSeq: input.clientEditSeq, edits: input.edits,
      }));
      const key = commandId(stableId('textbook-command', learner, reviseCommand, requestId));
      const purpose = parseInput(() => accessPurpose(input.purpose));
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
        if (error instanceof Error && (
          error.message === '目标事实不是教材页。' ||
          error.message === `Fact type is not registry-owned: ${originalEdit.id}`
        )) {
          const current = await get({ learner, id: originalEdit.id, purpose: input.purpose });
          if (current.kind === 'legacyNote') {
            throw new RequestError(409, '旧笔记保留原所有者，只能读取，不能作为教材修订。');
          }
        }
        if (error instanceof Error && (
          error.message.startsWith('Fact revision conflict: ') || error.message === 'Fact update conflict'
        )) return conflict('REVISION_CONFLICT', input, originalEdit, requestId);
        if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
          return conflict('REQUEST_ID_CONFLICT', input, originalEdit, requestId);
        }
        return translateWrite(error);
      }
    },
  };
}
