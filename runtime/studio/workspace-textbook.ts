import {fileURLToPath} from 'node:url';
import {createCommandHandler, readRecordedCommand} from '../../kernel/src/commands/handle.ts';
import {isFactUnavailable, purposeReader} from './fact-read-helpers.ts';
import {isUneditedCompanionDraft} from '../../kernel/src/commands/writes.ts';
import {commandId, factId} from '../../kernel/src/declarations/ids.ts';
import type {Db, ReadTransaction} from '../../kernel/src/db/types.ts';
import {loadModuleDirectory} from '../../kernel/src/loader.ts';
import {openLearningLimit, type WorkspaceWriteReceipt} from '../../executors/teaching/workspace-tools.ts';
import {parseSavePage, parseTextbookRevision, previewTextbookRevision} from '../../modules/content/textbook-edits.ts';
import {checkTextbookBasis, parseTextbookBasis, textbookPageFrom, textbookPageType} from '../../modules/content/textbook-page.ts';
import {createStudioCommandHooks} from './command-hooks.ts';
import {purpose, stableId, studioLearner} from './identity.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import {parseLearningReference} from '../../modules/activity/source-values.ts';
import type {WorkspaceSourceRecipient} from './source-read.ts';
import type {WorkspaceWitness} from './workspace-agent.ts';

export const createTextbookCommand = 'content.createTextbookPage';
export const reviseTextbookDraftCommand = 'content.reviseTextbookDraft';
export const reviseTextbookCommand = 'content.reviseTextbookPage';
export const undoTextbookCommand = 'content.undoTextbookWrite';
const scope = {learner:studioLearner};
const loadContent = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/content', import.meta.url)));
let content: ReturnType<typeof loadContent> | undefined;

export function openWorkspaceTextbook(options: {
  db: Db; turn: string;
  authorize(tx: ReadTransaction): Promise<void>;
  maySend: WorkspaceSourceRecipient;
  opened: ReadonlyMap<string, WorkspaceWitness>;
  basis(): readonly WorkspaceWitness[];
  currentPage?: {id:string; rev:number} | undefined;
  saved(receipt: WorkspaceWriteReceipt, witness?: WorkspaceWitness): void;
}) {
  const {db, turn, opened} = options;
  const following = {mode:'following'} as const;
  const reader = (tx:ReadTransaction) => purposeReader(tx, options.maySend);
  const createHandler = async () => createCommandHandler(db, {
    modules:[await (content ??= loadContent())],
    hooks:{...createStudioCommandHooks({afterFactsChanged:options.authorize}), async beforeProposal(tx, request) {
      await options.authorize(tx);
      const input = parseTextbookRevision(request.input);
      const read = reader(tx);
      const page = await read.fact(input.id, following);
      if (page.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${input.id}`);
      await checkTextbookBasis(read, input.basis ?? []);
    }},
  });
  const correct = {tool:'save_page' as const,args:{},why:'按工具声明提供新建字段或局部修改。'};
  const error = (code:Parameters<typeof learningToolError>[0], field:string, message:string, next = correct as Parameters<typeof learningToolError>[3]) =>
    learningToolError(code,field,message,next);
  const reopen = (refs: string | string[]) => ({tool:'open_learning' as const,args:{refs},why:'重新打开当前获准的依据及页版本。'});

  return async (args: Record<string, unknown>, step: number) => {
    let parsed: ReturnType<typeof parseSavePage>;
    try { parsed = parseSavePage(args); }
    catch (cause) { return error('invalid_args','args',cause instanceof Error ? cause.message : '教材保存参数无效。'); }
    const links = args.links ?? [];
    if (!Array.isArray(links) || links.length > openLearningLimit || !links.every(link => typeof link === 'string'))
      return error('invalid_args','links','请提供至多 8 个本轮已打开的来源引用。');
    const references = (links as string[]).map(parseLearningReference);
    if (references.some(ref => !ref)) return error('invalid_args','links','请使用记录 id 或 sourceRef。');
    for (const ref of references) {
      const id = typeof ref === 'string' ? ref : ref!.fact.id;
      if (![...opened.values()].some(w => w.id === id &&
          (typeof ref === 'string' || (w.rev === ref!.fact.rev && w.type === ref!.fact.type))))
        return error('evidence_not_opened','links','请先打开要使用的来源。',reopen(id));
    }
    const key = commandId(stableId('save-page-command',turn,String(step)));
    const base = parsed.kind === 'patch'
      ? parsed.ref === 'current_page' ? options.currentPage : parseLearningReference(parsed.ref)
      : undefined;
    const selectedId = typeof base === 'string' ? base : base && ('fact' in base ? base.fact.id : base.id);
    const id = factId(selectedId ?? stableId('save-page',turn,String(step)));
    if (parsed.kind === 'patch' && !base) return error('invalid_args','ref','请使用已打开的个人教材引用。',reopen(parsed.ref));
    if (base && typeof base !== 'string' && 'anchor' in base && base.anchor.kind === 'block') {
      const blockId = base.anchor.blockId;
      if (parsed.kind === 'patch' && parsed.edits.some(edit => (edit.kind === 'insert_after' ? edit.afterId : edit.blockId) !== blockId))
        return error('invalid_args','patch','块引用只可修改该块或在其后插入。',reopen(id));
    }
    try {
      const basis = parseTextbookBasis(options.basis().filter(w => w.id !== id)
        .map(({id,rev,epoch,type}) => ({id,rev,epoch,type})));
      const handle = await createHandler();
      if (parsed.kind === 'create') {
        const receipt = await handle({...scope, actor:'companion', purpose, id:key, type:createTextbookCommand,
          input:{id,clientEditSeq:step,purpose:['storage',purpose],page:{...parsed.page,basis}}});
        const written = receipt.wrote[0]!;
        options.saved({id,rev:written.rev,title:parsed.page.title,page:{status:'saved',undo_token:key}},
          {id,rev:written.rev,type:textbookPageType,epoch:'0',mode:'pinned'});
        return {ok:true,status:'saved',ref:id,rev:written.rev,undo_token:key};
      }

      const pinned = base && typeof base !== 'string' ? 'fact' in base ? base.fact.rev : base.rev : undefined;
      const openedHead = [...opened.values()].reverse().find(w => w.id === id && w.type === textbookPageType &&
        (pinned === undefined || w.rev === pinned));
      if (!openedHead) return error('evidence_not_opened','ref','本轮尚未打开这份教材版本。',reopen(id));
      if (parsed.expectedRev !== undefined && parsed.expectedRev !== openedHead.rev)
        return error('version_conflict','expected_rev','预期版本和已打开版本不一致。',reopen(id));
      const input = parseTextbookRevision({id, expectedRev:openedHead.rev, clientEditSeq:step, edits:parsed.edits, basis});
      const plan = await db.snapshot(scope, async tx => {
        const read = reader(tx);
        const current = await read.fact(id, following);
        const existing = await readRecordedCommand(tx,key);
        if (!existing && current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${id}`);
        await checkTextbookBasis(read, input.basis ?? []);
        const draft = existing ? existing.type === reviseTextbookDraftCommand : await isUneditedCompanionDraft(tx,id);
        const ctx = {learner:tx.learner,read};
        const preview = await previewTextbookRevision(ctx,input);
        const base = await read.fact(id,{mode:'pinned',rev:input.expectedRev});
        await checkTextbookBasis(read,textbookPageFrom(base).basis ?? []);
        return {title:textbookPageFrom(base).title, epoch:current.accessEpoch, draft, preview};
      });
      if ((plan.draft && plan.preview.items.some(item => item.state === 'invalid')) ||
          plan.preview.items.every(item => item.state === 'invalid')) {
        const invalid = plan.preview.items.find(item => item.state === 'invalid')!;
        return error('invalid_args','patch',invalid.reason,reopen(id));
      }
      const receipt = await handle({...scope,actor:'companion',purpose,id:key,
        type:plan.draft ? reviseTextbookDraftCommand : reviseTextbookCommand,input});
      if (receipt.state === 'proposed') {
        options.saved({id,rev:input.expectedRev,title:plan.title,page:{status:'proposed',proposalId:key}});
        return {ok:true,status:'proposed',ref:id,rev:input.expectedRev,proposalId:key,base:plan.preview.base,items:plan.preview.items};
      }
      const written = receipt.wrote[0]!;
      options.saved({id,rev:written.rev,title:plan.title,page:{status:'saved',undo_token:key}},
        {id,rev:written.rev,type:textbookPageType,epoch:plan.epoch,mode:'pinned'});
      return {ok:true,status:'saved',ref:id,rev:written.rev,undo_token:key};
    } catch (cause) {
      if (isFactUnavailable(cause))
        return error('access_revoked','ref','本轮打开的教材或来源已不可用。',reopen(selectedId ?? links as string[]));
      if (cause instanceof Error && (cause.message.startsWith('Fact revision conflict:') ||
          cause.message === 'Only an unedited companion draft can be revised'))
        return error('version_conflict','expected_rev','教材版本已变更，请重新打开。',reopen(id));
      if (cause instanceof Error && cause.message === '教材依据已变更。')
        return error('basis_stale','links','教材来源已变更。',reopen(selectedId ?? links as string[]));
      if (cause instanceof Error && /^(教材|请先打开教材块|引用|插入位置|来源)/.test(cause.message))
        return error('invalid_args','patch',cause.message);
      throw cause;
    }
  };
}
