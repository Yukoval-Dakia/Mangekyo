import { fileURLToPath } from 'node:url';
import { learningToolError } from '../../executors/teaching/tool-error.ts';
import { openLearningLimit, type WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import { readCommandProposals } from '../../kernel/src/commands/handle.ts';
import { commandId, createLearnerHost, factId, FactReadDeniedError, isFactUnavailable, matchKernelError, type CommandHooks, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { loadModuleDirectory, type LoadedModule } from '../../kernel/src/loader.ts';
import { isSourceFactId, parseLearningReference, type SourceRefV1 } from '../../modules/activity/source-values.ts';
import { createKnowledgeEdgeCommand, createVerifiedKnowledgeEdgeCommand, KnowledgeEdgeBasisError, knowledgeEdgeEvidenceType, KnowledgeEdgeEvidenceError, knowledgeEdgeType, knowledgeEndpointKind, knowledgeUseKey, parseEdgeClaim, parseEdgeWrite, withdrawKnowledgeEdgeCommand } from '../../modules/content/knowledge-edge.ts';
import { buildSavedEdgeRef, projectConfirmedRelationState, resolveOpenedRelationInputs } from '../../modules/content/workspace-slice.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purposeReader, studioHost} from './fact-read-helpers.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { readKnowledgeSources } from './knowledge-graph.ts';
import { RequestError } from './sessions.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

const owner = { recipient: 'learner' } as const;
let content: Promise<LoadedModule> | undefined;
export type OpenedRelationSource = { ref: SourceRefV1; witness: WorkspaceWitness };
const reopen = (refs: string | string[]) => ({ tool: 'open_learning' as const, args: { refs }, why: '打开并核对这次写入所用的固定来源。' });
const retry = { tool: 'save_relation' as const, args: {}, why: '使用已打开的 from、to，填写 kind 与 scope。' };
const search = { tool: 'search_workspace' as const, args: {}, why: '选择当前获准的端点和来源。' };

export function openWorkspaceRelation(options: {
  db: Db; turn: string; opened: ReadonlyMap<string, OpenedRelationSource>; maySend: WorkspaceSourceRecipient;
  modelBasis?(): readonly WorkspaceWitness[]; authorize(tx: ReadTransaction): Promise<void>;
  saved(key: string, receipt: WorkspaceWriteReceipt): void; afterFactsChanged?: CommandHooks['onFactsChanged'];
}) { const { db, opened } = options, host = createLearnerHost(db, studioLearner, { actor: 'companion' });
  const access = { recipient: 'workspace', maySend: options.maySend } as const, read = (tx: ReadTransaction) => purposeReader(tx, options.maySend);
  return async (args: Record<string, unknown>, step: number) => {
    const { kind, from, to, scope: relationScope, sources = [], verification, variant } = args;
    if (!Array.isArray(sources) || sources.length > openLearningLimit - 2)
      return learningToolError('invalid_args', 'sources', '请传至多 6 个补充来源引用。', retry);
    const rawInputs: [string, unknown][] = [['from', from], ['to', to], ...sources.map((ref): [string, unknown] => ['sources', ref]),
      ...(verification === undefined ? [] : [['verification', verification] as [string, unknown]])];
    const resolved = resolveOpenedRelationInputs(
      rawInputs.map(([field, raw]) => ({ field, ref: typeof raw === 'string' && raw.length <= 4096 ? parseLearningReference(raw) : undefined })),
      opened, openLearningLimit, options.modelBasis?.() ?? [], verification !== undefined);
    if (!resolved.ok) return learningToolError(resolved.code, resolved.field, resolved.message, resolved.retryKind === 'reopen' ? reopen(resolved.reopenRefs) : retry);
    const { picked, refs, uses, proof } = resolved;
    const id = factId(stableId('knowledge-edge', options.turn, String(step))), key = commandId(stableId('save-relation-command', options.turn, String(step)));
    try { const endpoints = await host.snapshot(tx => Promise.all([0, 1].map(async i =>
        ({ kind: knowledgeEndpointKind(await read(tx).reopen({ ...uses[i]!, mode: 'pinned', type: picked[i]!.witness.type })), sourceUse: uses[i]! }))));
      let edge;
      try {edge = parseEdgeClaim({ kind, from: endpoints[0], to: endpoints[1], scope: relationScope,
          sourceUses: [...new Map(uses.map(use => [knowledgeUseKey(use), use])).values()], ...(variant === undefined ? {} : { variant }) });
      } catch (error) { return learningToolError('invalid_args', 'args', error instanceof Error ? error.message : '知识边参数无效。', retry); }
      const authorize = async (tx: ReadTransaction) => { await readKnowledgeSources(tx, edge, access);
        await readKnowledgeSources(tx, edge, owner);
        if (proof) await read(tx).reopen({ ...proof, mode: 'pinned', type: knowledgeEdgeEvidenceType });
        await options.authorize(tx);}; await host.snapshot(authorize);
      const handle = host.boundHandler([await (content ??= loadModuleDirectory(fileURLToPath(new URL('../../modules/content', import.meta.url))))],
        { ...createStudioCommandHooks({ async afterFactsChanged(tx, tick, changes) { await authorize(tx); await options.afterFactsChanged?.(tx, tick, changes); } }), beforeProposal: authorize });
      const receipt = await handle({ purpose, id: key, type: proof ? createVerifiedKnowledgeEdgeCommand : createKnowledgeEdgeCommand, input: { id, purpose, edge, ...(proof ? { verification: proof } : {}) } });
      if (receipt.state === 'proposed') {
        options.saved(key, { id, rev: 1, title: '知识关系提议', relation: { status: 'proposed', proposalId: key } });
        return { ok: true, status: 'proposed', proposalId: key };
      }
      const written = receipt.wrote[0]!;
      options.saved(key, { id: written.id, rev: written.rev, title: '已核验的知识关系', relation: { status: 'saved', undo_token: key } });
      return { ok: true, status: 'saved', ref: buildSavedEdgeRef(written.id, written.rev), rev: written.rev, undo_token: key };
    } catch (error) { if (error instanceof KnowledgeEdgeEvidenceError)
        return learningToolError('invalid_args', 'verification', error.message, { tool: 'open_learning', args: { refs: proof!.id }, why: '核对证明对应的有向边及来源，再决定是否使用这份证明。' });
      if (error instanceof KnowledgeEdgeBasisError || (error instanceof FactReadDeniedError && error.reason === 'changed'))
        return learningToolError('basis_stale', 'sources', '写入依据已变化，请重新打开。', reopen(refs));
      if (isFactUnavailable(error)) return learningToolError('access_revoked', 'sources', '本轮打开的依据当前不可用。', search);
      throw error;}};
}

export function openRelationReview(db: Db, contentModule: LoadedModule, afterFactsChanged?: CommandHooks['onFactsChanged']) {
  const host = studioHost(db);
  const handle = host.commandHandler([contentModule], createStudioCommandHooks(afterFactsChanged ? { afterFactsChanged } : {}));
  const unavailableBasis = (error: unknown) => isFactUnavailable(error) || error instanceof KnowledgeEdgeBasisError;
  const translate = (error: unknown): never => {
    if (unavailableBasis(error)) throw new RequestError(409, '知识边依据已变化或不可读。');
    throw matchKernelError(error, {proposal_not_found: () => new RequestError(404, '找不到知识边提议。'),
      proposal_decided: () => new RequestError(409, '知识边状态已变化。'),
      revision_conflict: () => new RequestError(409, '知识边状态已变化。'), otherwise: () => error,
    });};
  return {proposal: (id: string) => host.snapshot(async tx => {
      const [proposal] = await readCommandProposals(tx, createKnowledgeEdgeCommand, {}, commandId(id));
      if (!proposal) throw new RequestError(404, '找不到知识边提议。');
      if (proposal.state === 'rejected') return { proposalId: proposal.id, status: 'rejected' as const };
      const { edge, id: edgeId } = parseEdgeWrite(proposal.input);
      const result = proposal.state === 'confirmed'
        ? projectConfirmedRelationState((await tx.query<{ current_rev: number; retracted_rev: number | null }>('SELECT current_rev,retracted_rev FROM facts WHERE learner_id=$1 AND id=$2 AND type=$3', [tx.learner, edgeId, knowledgeEdgeType])).rows[0], edgeId, stableId('accept-knowledge-edge', id))
        : undefined;
      const decision = { proposalId: proposal.id, status: proposal.state, ...(result ? { result } : {}) };
      const description = await readKnowledgeSources(tx, edge, owner).catch((error: unknown) => {
        if (proposal.state === 'confirmed' && unavailableBasis(error)) return undefined;
        throw error;});
      if (!description) return decision;
      const { from, to, sources } = description;
      return { ...decision, kind: edge.kind, scope: edge.scope, from: from.sourceRef, to: to.sourceRef, fromTitle: from.title, toTitle: to.title, sources, ...(edge.variant ? { variant: edge.variant } : {}) };
    }).catch(translate), async accept(id: string) {
      const proposalId = commandId(id), key = commandId(stableId('accept-knowledge-edge', id));
      const receipt = await handle.decideProposal({ ...host.scope, id: key, type: createKnowledgeEdgeCommand, purpose, proposalId, selection: 'accept' }, async (tx, input) => {
        const { edge } = parseEdgeWrite(input);
        await readKnowledgeSources(tx, edge, { recipient: 'workspace', maySend: () => true });
        await readKnowledgeSources(tx, edge, owner);
        return input;}).catch(translate);
      const written = receipt.wrote[0]!;
      return { status: 'saved', proposalId, commandId: key, ref: buildSavedEdgeRef(written.id, written.rev), rev: written.rev, undo_token: key };
    }, async reject(id: string) { const proposalId = commandId(id);
      await handle.decideProposal({ ...host.scope, id: commandId(stableId('reject-knowledge-edge', id)), type: createKnowledgeEdgeCommand, purpose, proposalId, selection: 'reject' }, async () => null).catch(translate);
      return { status: 'rejected' as const, proposalId };},
    async undo(id: string, input: Record<string, unknown>) { const token = input.undo_token;
      if (!isSourceFactId(token)) throw new RequestError(400, '撤回凭据无效。');
      const { rows: [birth] } = await db.query<{ rev: number }>(
        `SELECT r.rev FROM fact_revs r JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id) JOIN facts f ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
         WHERE r.learner_id=$1 AND r.fact_id=$2 AND c.id=$3 AND f.type=$4 AND r.rev=1 AND c.state='done'
           AND ((c.type=$5 AND r.author='companion') OR (c.type=$6 AND c.input->'input' ? 'proposalId'))`,
        [studioLearner, id, token, knowledgeEdgeType, createVerifiedKnowledgeEdgeCommand, createKnowledgeEdgeCommand]);
      if (!birth) throw new RequestError(404, '找不到可撤回的知识边。');
      const written = (await host.runCommand(handle, { id: commandId(stableId('withdraw-knowledge-edge', token)), type: withdrawKnowledgeEdgeCommand, purpose: 'storage', input: { id, expectedRev: birth.rev } }).catch(translate)).wrote[0]!;
      return { status: 'withdrawn', ref: { id: written.id, rev: written.rev } };},
  };
}
