import { fileURLToPath } from 'node:url';
import { learningToolError } from '../../executors/teaching/tool-error.ts';
import { openLearningLimit, type WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import { readRecordedCommand } from '../../kernel/src/commands/handle.ts';
import { isUneditedCompanionDraft } from '../../kernel/src/commands/writes.ts';
import { commandId, createLearnerHost, factId, isFactUnavailable, isKernelErrorKind, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { parseLearningReference } from '../../modules/activity/source-values.ts';
import { parseSavePage, parseTextbookRevision, previewTextbookRevision } from '../../modules/content/textbook-edits.ts';
import { checkTextbookBasis, parseTextbookBasis, textbookPageFrom, textbookPageType } from '../../modules/content/textbook-page.ts';
import { classifyTextbookWriteError, findTextbookPreviewFailure, findUnopenedTextbookLink, violatesTextbookBlockAnchor } from '../../modules/content/workspace-slice.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purposeReader } from './fact-read-helpers.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

export const createTextbookCommand = 'content.createTextbookPage', reviseTextbookDraftCommand = 'content.reviseTextbookDraft';
export const reviseTextbookCommand = 'content.reviseTextbookPage', undoTextbookCommand = 'content.undoTextbookWrite';
const following = { mode: 'following' } as const;
const loadContent = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/content', import.meta.url)));
let content: ReturnType<typeof loadContent> | undefined;

export function openWorkspaceTextbook(options: {
  db: Db; turn: string; authorize(tx: ReadTransaction): Promise<void>; maySend: WorkspaceSourceRecipient;
  opened: ReadonlyMap<string, WorkspaceWitness>; basis(): readonly WorkspaceWitness[];
  currentPage?: { id: string; rev: number } | undefined; saved(receipt: WorkspaceWriteReceipt, witness?: WorkspaceWitness): void;
}) {
  const { db, turn, opened } = options, host = createLearnerHost(db, studioLearner, { actor: 'companion' });
  const reader = (tx: ReadTransaction) => purposeReader(tx, options.maySend);
  const createHandler = async () => host.boundHandler([await (content ??= loadContent())], {
    ...createStudioCommandHooks({ afterFactsChanged: options.authorize }),
    async beforeProposal(tx, request) {
      await options.authorize(tx);
      const input = parseTextbookRevision(request.input), read = reader(tx);
      if ((await read.fact(input.id, following)).ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${input.id}`);
      await checkTextbookBasis(read, input.basis ?? []);
    },
  });
  const correct = { tool: 'save_page' as const, args: {}, why: '按工具声明提供新建字段或局部修改。' };
  const error = (code: Parameters<typeof learningToolError>[0], field: string, message: string, next = correct as Parameters<typeof learningToolError>[3]) => learningToolError(code, field, message, next);
  const reopen = (refs: string | string[]) => ({ tool: 'open_learning' as const, args: { refs }, why: '重新打开当前获准的依据及页版本。' });

  return async (args: Record<string, unknown>, step: number) => {
    let parsed: ReturnType<typeof parseSavePage>;
    try { parsed = parseSavePage(args); } catch (cause) { return error('invalid_args', 'args', cause instanceof Error ? cause.message : '教材保存参数无效。'); }
    const links = args.links ?? [];
    if (!Array.isArray(links) || links.length > openLearningLimit || !links.every(link => typeof link === 'string'))
      return error('invalid_args', 'links', '请提供至多 8 个本轮已打开的来源引用。');
    const references = (links as string[]).map(parseLearningReference);
    if (references.some(ref => !ref)) return error('invalid_args', 'links', '请使用记录 id 或 sourceRef。');
    const missingLink = findUnopenedTextbookLink(references.filter((r): r is NonNullable<typeof r> => Boolean(r)), opened);
    if (missingLink) return error('evidence_not_opened', 'links', '请先打开要使用的来源。', reopen(missingLink));
    const key = commandId(stableId('save-page-command', turn, String(step)));
    const base = parsed.kind === 'patch' ? (parsed.ref === 'current_page' ? options.currentPage : parseLearningReference(parsed.ref)) : undefined;
    const selectedId = typeof base === 'string' ? base : base && ('fact' in base ? base.fact.id : base.id);
    const id = factId(selectedId ?? stableId('save-page', turn, String(step)));
    if (parsed.kind === 'patch' && !base) return error('invalid_args', 'ref', '请使用已打开的个人教材引用。', reopen(parsed.ref));
    if (violatesTextbookBlockAnchor(base, parsed)) return error('invalid_args', 'patch', '块引用只可修改该块或在其后插入。', reopen(id));
    const finishSaved = (rev: number, title: string, epoch: string) => {
      options.saved({ id, rev, title, page: { status: 'saved', undo_token: key } }, { id, rev, type: textbookPageType, epoch, mode: 'pinned' });
      return { ok: true, status: 'saved', ref: id, rev, undo_token: key };
    };
    try {
      const basis = parseTextbookBasis(options.basis().filter(w => w.id !== id).map(({ id: wId, rev, epoch, type }) => ({ id: wId, rev, epoch, type })));
      const handle = await createHandler();
      if (parsed.kind === 'create') {
        const receipt = await handle({ purpose, id: key, type: createTextbookCommand, input: { id, clientEditSeq: step, purpose: ['storage', purpose], page: { ...parsed.page, basis } } });
        return finishSaved(receipt.wrote[0]!.rev, parsed.page.title, '0');
      }
      const pinned = base && typeof base !== 'string' ? ('fact' in base ? base.fact.rev : base.rev) : undefined;
      const openedHead = [...opened.values()].reverse().find(w => w.id === id && w.type === textbookPageType && (pinned === undefined || w.rev === pinned));
      if (!openedHead) return error('evidence_not_opened', 'ref', '本轮尚未打开这份教材版本。', reopen(id));
      if (parsed.expectedRev !== undefined && parsed.expectedRev !== openedHead.rev) return error('version_conflict', 'expected_rev', '预期版本和已打开版本不一致。', reopen(id));
      const input = parseTextbookRevision({ id, expectedRev: openedHead.rev, clientEditSeq: step, edits: parsed.edits, basis });
      const plan = await host.snapshot(async tx => {
        const read = reader(tx), current = await read.fact(id, following), existing = await readRecordedCommand(tx, key);
        if (!existing && current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${id}`);
        await checkTextbookBasis(read, input.basis ?? []);
        const draft = existing ? existing.type === reviseTextbookDraftCommand : await isUneditedCompanionDraft(tx, id);
        const preview = await previewTextbookRevision({ learner: tx.learner, read }, input);
        const baseFact = await read.fact(id, { mode: 'pinned', rev: input.expectedRev });
        await checkTextbookBasis(read, textbookPageFrom(baseFact).basis ?? []);
        return { title: textbookPageFrom(baseFact).title, epoch: current.accessEpoch, draft, preview };
      });
      const previewFailure = findTextbookPreviewFailure(plan.draft, plan.preview.items);
      if (previewFailure) return error('invalid_args', 'patch', previewFailure, reopen(id));
      const receipt = await handle({ purpose, id: key, type: plan.draft ? reviseTextbookDraftCommand : reviseTextbookCommand, input });
      if (receipt.state === 'proposed') {
        options.saved({ id, rev: input.expectedRev, title: plan.title, page: { status: 'proposed', proposalId: key } });
        return { ok: true, status: 'proposed', ref: id, rev: input.expectedRev, proposalId: key, base: plan.preview.base, items: plan.preview.items };
      }
      return finishSaved(receipt.wrote[0]!.rev, plan.title, plan.epoch);
    } catch (cause) {
      if (isFactUnavailable(cause)) return error('access_revoked', 'ref', '本轮打开的教材或来源已不可用。', reopen(selectedId ?? links as string[]));
      if (isKernelErrorKind(cause, 'revision_conflict')) return error('version_conflict', 'expected_rev', '教材版本已变更，请重新打开。', reopen(id));
      const classified = cause instanceof Error ? classifyTextbookWriteError(cause.message) : null;
      if (classified) return error(classified.code, classified.field, classified.message, classified.reopen ? reopen(classified.code === 'basis_stale' ? (selectedId ?? links as string[]) : id) : correct);
      throw cause;
    }
  };
}
