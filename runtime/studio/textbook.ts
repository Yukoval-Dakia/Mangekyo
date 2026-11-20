import { sourceReference } from '../../modules/activity/source-values.ts';
import { resolveSource } from './source-read.ts';
import { createCommandHandler, readCommandProposals, readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { commandId, factId, learnerId, type CommandId, type LearnerId } from '../../kernel/src/declarations/ids.ts';
import type {
  CommandReceipt,
  FactSnapshot,
  Json,
  ReadContext,
} from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { organizerNote, organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { editSequence, key, pageId, revision } from '../../modules/content/parse.ts';
import { parseTextbookRevision, previewTextbookRevision, selectTextbookEdits, type TextbookRevision } from '../../modules/content/textbook-edits.ts';
import {
  checkTextbookBasis,
  openTextbookBlock,
  openTextbookReference,
  parseTextbookPage,
  textbookPageFrom,
  textbookPageType,
  type TextbookBlockBody,
} from '../../modules/content/textbook-page.ts';
import { purpose as teaching, stableId, textbookUndoId } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { createTextbookCommand as createCommand, reviseTextbookCommand as reviseCommand, reviseTextbookDraftCommand,
  undoTextbookCommand } from './workspace-textbook.ts';

const storage = 'storage';
const decisionId = (proposalId: string) => commandId(stableId('textbook-proposal-decision', proposalId));

export type TextbookReadInput = {
  readonly learner: unknown;
  readonly purpose?: unknown;
};

export type TextbookGetInput = TextbookReadInput & {
  readonly id: unknown;
  readonly rev?: unknown;
};

export type TextbookOpenBlockInput = TextbookGetInput & {
  readonly blockId: unknown;
  readonly mode?: unknown;
};

export type TextbookCreateInput = TextbookReadInput & {
  readonly requestId: unknown;
  readonly id?: unknown;
  readonly clientEditSeq: unknown;
  readonly page: unknown;
};

export type TextbookReviseInput = TextbookReadInput & {
  readonly requestId: unknown;
  readonly id: unknown;
  readonly expectedRev: unknown;
  readonly clientEditSeq: unknown;
  readonly edits: unknown;
};

type ReferenceWitness = Awaited<ReturnType<typeof openTextbookReference>> & {
  readonly blockId: string;
};

export type TextbookPageView = {
  readonly kind: 'textbook';
  readonly id: string;
  readonly rev: number;
  readonly learner: LearnerId;
  readonly accessEpoch: string;
  readonly purpose: readonly string[];
  readonly title: string;
  readonly blocks: ReturnType<typeof textbookPageFrom>['blocks'];
  readonly references: readonly ReferenceWitness[];
};

export type LegacyNoteView = {
  readonly kind: 'legacyNote';
  readonly readOnly: true;
  readonly owner: typeof organizerNoteType;
  readonly id: string;
  readonly rev: number;
  readonly learner: LearnerId;
  readonly accessEpoch: string;
  readonly purpose: readonly string[];
  readonly title: string;
  readonly markdown: string;
  readonly source: ReturnType<typeof organizerNote>['source'];
};

export type TextbookSummary = {
  readonly kind: 'textbook' | 'legacyNote';
  readonly id: string;
  readonly rev: number;
  readonly title: string;
  readonly purpose: readonly string[];
  readonly readOnly: boolean;
};

export type TextbookWriteReceipt = CommandReceipt & {
  readonly requestId: string;
  readonly clientEditSeq: number;
  readonly id: string;
  readonly expectedRev: number | null;
  readonly rev: number;
};

export class TextbookConflictError extends RequestError {
  constructor(
    readonly code: 'REVISION_CONFLICT' | 'REQUEST_ID_CONFLICT' | 'CLIENT_EDIT_SEQ_CONFLICT',
    readonly current: TextbookPageView,
    readonly originalEdit: TextbookRevision,
    readonly requestId: string,
    readonly previousReceipt?: CommandReceipt,
  ) {
    super(409, '教材已在别处更新，原编辑已保留，请核对当前版本。');
    this.name = 'TextbookConflictError';
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      current: this.current,
      originalEdit: this.originalEdit,
      requestId: this.requestId,
      ...(this.previousReceipt ? { previousReceipt: this.previousReceipt } : {}),
    };
  }
}

function invalid(message: string): never {
  throw new RequestError(400, message);
}

function parseInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) { return invalid(error instanceof Error ? error.message : '教材数据无效。'); }
}

function scopedLearner(value: unknown): LearnerId {
  if (typeof value !== 'string') return invalid('学习者标识无效。');
  try { return learnerId(value); } catch { return invalid('学习者标识无效。'); }
}

function accessPurpose(value: unknown): string {
  if (value === undefined) return storage;
  if (typeof value !== 'string' || !value.trim()) return invalid('读取用途无效。');
  return value;
}

function creationPurposes(value: unknown): { readonly access: string; readonly fact: readonly string[] } {
  if (value === undefined || typeof value === 'string') {
    const access = accessPurpose(value);
    return { access, fact: [access] };
  }
  if (!Array.isArray(value) || !value.length || value.some(entry => typeof entry !== 'string' || !entry)
    || new Set(value).size !== value.length) {
    return invalid('教材用途无效。');
  }
  return { access: value[0] as string, fact: [...value] as string[] };
}

function translateRead(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof FactNotFoundError) throw new RequestError(404, '找不到这份教材或笔记。');
  if (error instanceof FactReadDeniedError) throw new RequestError(403, '当前用途不能读取这份内容或其引用。');
  throw error;
}

function translateWrite(error: unknown): never {
  if (error instanceof RequestError) throw error;
  if (error instanceof FactNotFoundError) throw new RequestError(404, '找不到要编辑的教材或引用。');
  if (error instanceof FactReadDeniedError) throw new RequestError(403, '当前用途不能读取或引用这份内容。');
  if (error instanceof Error) {
    if (error.message === 'Command ID already used with a different command identity') {
      throw new RequestError(409, '同一个请求标识已经用于不同编辑。');
    }
    if (error.message.startsWith('Fact already exists: ')) throw new RequestError(409, '教材标识已经存在。');
    if (error.message.startsWith('Fact does not exist: ')) throw new RequestError(404, '找不到要编辑的教材。');
    if (error.message.startsWith('Fact is retracted: ')) throw new RequestError(409, '这份教材已经撤回。');
    if (error.message.startsWith('Fact purpose does not allow this write: ')) {
      throw new RequestError(403, '当前用途不能编辑这份教材。');
    }
    if (error.message === '教材依据已变更。') throw new RequestError(403, '教材来源已变更。');
    if (error.message === 'Proposal not found') throw new RequestError(404, '找不到教材提议。');
    if (error.message === 'Proposal already decided' || error.message.startsWith('Fact revision conflict: ') ||
        error.message === 'Only an unedited companion draft can be revised')
      throw new RequestError(409, '教材或提议已变更，请刷新。');
    if (/^(教材|引用|插入位置|来源)/.test(error.message)) throw new RequestError(400, error.message);
  }
  throw error;
}

async function checkBodyReference(read: ReadContext, learner: LearnerId, blockId: string, body: TextbookBlockBody) {
  const reference = body.kind === 'image' ? body.source : body.kind === 'reference' ? body.target : null;
  if (!reference) return null;
  if (reference.fact.learner !== learner) throw new RequestError(403, '不能读取其他学习者的引用。');
  const witness = await openTextbookReference(read, reference);
  return { blockId, ...witness };
}

async function pageView(read: ReadContext, fact: FactSnapshot): Promise<TextbookPageView> {
  const page = textbookPageFrom(fact);
  const references: ReferenceWitness[] = [];
  for (const block of page.blocks) {
    const witness = await checkBodyReference(read, fact.ref.learner, block.id, block.body);
    if (witness) references.push(witness);
  }
  return { kind: 'textbook', ...fact.ref, accessEpoch: fact.accessEpoch, purpose: fact.purpose, ...page, references };
}

function legacyView(fact: FactSnapshot): LegacyNoteView {
  return {
    kind: 'legacyNote', readOnly: true, owner: organizerNoteType,
    ...fact.ref, accessEpoch: fact.accessEpoch, purpose: fact.purpose, ...organizerNote(fact.value),
  };
}

async function readFact(tx: ReadTransaction, purpose: string, id: string, rev?: unknown) {
  const read = createCommandReadContext(tx,purpose);
  const fact = await read.fact(pageId(id),rev === undefined ? {mode:'following'} : {mode:'pinned',rev:revision(rev)});
  if (fact.type === textbookPageType) {
    const page = textbookPageFrom(fact);
    if ((page.basis?.length || page.blocks.some(({body}) => body.kind === 'reference' || body.kind === 'image')) &&
        !await resolveSource(tx,sourceReference(fact,{kind:'whole'}),{recipient:'learner'}))
      throw new FactReadDeniedError('recipient','教材的来源已不可用。');
  }
  return fact;
}

export function openTextbook(db: Db, contentModule: LoadedModule, hooks: CommandHooks) {
  const handle = createCommandHandler(db, { modules: [contentModule], hooks });
  type Proposal = Awaited<ReturnType<typeof readCommandProposals>>[number];

  async function previewProposal(tx: ReadTransaction, input: unknown) {
    const edit = parseTextbookRevision(input);
    const read = createCommandReadContext(tx, teaching);
    const pinned = await read.fact(edit.id,{mode:'pinned',rev:edit.expectedRev});
    await checkTextbookBasis(read, textbookPageFrom(pinned).basis ?? []);
    await checkTextbookBasis(read, edit.basis ?? []);
    return previewTextbookRevision({learner:tx.learner,read},edit);
  }

  async function proposalView(tx: ReadTransaction, proposal: Proposal) {
    const {base,items} = await previewProposal(tx,proposal.input);
    const current = await readFact(tx,storage,base.id);
    const decision = await readRecordedCommand(tx,decisionId(proposal.id));
    const output = (decision?.receipt as CommandReceipt | undefined)?.output;
    const blockIds = output && typeof output === 'object' && 'selection' in output && Array.isArray(output.selection)
      ? output.selection as readonly string[] : [];
    const written = (decision?.receipt as CommandReceipt | undefined)?.wrote[0];
    const status = proposal.state === 'confirmed' ? 'applied' : proposal.state === 'rejected' ? 'rejected' :
      proposal.state === 'conflict' || current.ref.rev !== base.rev ? 'conflict' : 'proposed';
    return {proposalId:proposal.id,status,base,items,blockIds,
      result:written ? {id:written.id,rev:written.rev,undo_token:decisionId(proposal.id)} : null};
  }

  async function get(input: TextbookGetInput): Promise<TextbookPageView | LegacyNoteView> {
    const learner = scopedLearner(input.learner);
    const purpose = accessPurpose(input.purpose);
    return db.snapshot({ learner }, async tx => {
      const fact = await readFact(tx, purpose, pageId(input.id), input.rev);
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

  function writeReceipt(receipt: CommandReceipt, requestId: string, edit: {
    readonly id: string; readonly clientEditSeq: number; readonly expectedRev: number | null;
  }): TextbookWriteReceipt {
    const written = receipt.wrote.find(ref => ref.id === edit.id);
    if (!written) throw new Error('Textbook command receipt has no page write');
    return { ...receipt, requestId, clientEditSeq: edit.clientEditSeq, id: edit.id,
      expectedRev: edit.expectedRev, rev: written.rev };
  }

  return {
    async proposals(input: TextbookGetInput) {
      const learner = scopedLearner(input.learner);
      const id = parseInput(() => pageId(input.id));
      return db.snapshot({learner},async tx => {
        textbookPageFrom(await readFact(tx,storage,id));
        const proposals = [];
        for (const proposal of await readCommandProposals(tx,reviseCommand,{id})) {
          try {
            const {proposalId,status,base} = await proposalView(tx,proposal);
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
      if (selection) {
        const {blockIds} = selection;
        if (!Array.isArray(blockIds) || blockIds.length > 24) invalid('请选择教材块。');
        const selected = parseInput(() => blockIds.map(key).sort());
        if (new Set(selected).size !== selected.length) invalid('请勿重复选择教材块。');
        await db.snapshot({learner},async tx => {
          const [proposal] = await readCommandProposals(tx,reviseCommand,{id},proposalKey);
          if (!proposal) throw new RequestError(404, '找不到教材提议。');
        });
        await handle.decideProposal({learner, purpose:storage, type:reviseCommand, id:decisionId(proposalKey),
          proposalId:proposalKey, selection:selected}, async (tx, proposedInput) => {
          const edit = parseTextbookRevision(proposedInput);
          if (edit.id !== id) throw new RequestError(404, '找不到教材提议。');
          const preview = await previewProposal(tx,proposedInput);
          if (!selected.length) return null;
          if ((await readFact(tx,storage,id)).ref.rev !== edit.expectedRev)
            throw new RequestError(409, '教材已更新。');
          return parseInput(() => selectTextbookEdits(preview,selected));
        }).catch(translateWrite);
      }
      return db.snapshot({learner},async tx => {
        const [proposal] = await readCommandProposals(tx,reviseCommand,{id},proposalKey);
        if (!proposal) throw new RequestError(404, '找不到教材提议。');
        return proposalView(tx,proposal);
      }).catch(translateWrite);
    },
    async undo(input: TextbookGetInput, token: unknown) {
      const learner = scopedLearner(input.learner);
      const id = parseInput(() => pageId(input.id));
      const undoToken = parseInput(() => commandId(key(token)));
      const {rows:[original]} = await db.query<{rev:number; priorRev:number|null}>(
        `SELECT r.rev,r.corrects_rev AS "priorRev"
         FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
         JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.id=$3 AND c.state='done' AND f.type=$4
           AND ((c.type=ANY($5::text[]) AND r.author='companion') OR
             (c.type=$6 AND r.author='learner' AND c.input->'input' ? 'proposalId'))`,
        [learner,id,undoToken,textbookPageType,[createCommand,reviseTextbookDraftCommand],reviseCommand]);
      if (!original) throw new RequestError(404, '找不到可撤回的教材变更。');
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
      const purpose = accessPurpose(input.purpose);
      return db.snapshot({ learner }, async tx => {
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
            const fact = await readFact(tx, purpose, row.id);
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
      const purpose = accessPurpose(input.purpose);
      return db.snapshot({ learner }, async tx => {
        const read = createCommandReadContext(tx, purpose);
        const base = await readFact(tx, purpose, pageId(input.id), input.rev);
        if (base.type !== textbookPageType) throw new RequestError(404, '旧笔记没有教材块。');
        const mode = input.mode ?? 'pinned';
        if (mode !== 'pinned' && mode !== 'following') invalid('教材块定位方式无效。');
        const opened = await openTextbookBlock(read, base.ref, key(input.blockId), mode);
        await readFact(tx,purpose,opened.ref.id,opened.ref.rev);
        const source = await checkBodyReference(read, learner, opened.block.id, opened.block.body);
        return { kind: 'textbookBlock' as const, ...opened, source };
      }).catch(translateRead);
    },

    async create(input: TextbookCreateInput): Promise<TextbookWriteReceipt> {
      const learner = scopedLearner(input.learner);
      const requestId = clientRequest(input.requestId);
      const purposes = creationPurposes(input.purpose);
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
      const purpose = accessPurpose(input.purpose);
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
