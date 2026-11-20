import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import type { WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import {
  applyClaimCommand, claimExpiry, claimId, claimType, ClaimInputError, claimText, editableTurnClaim,
  requirePreservedObjectScope, structuredClaim,
} from '../../modules/companion/claim.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { OpenedCurrentLearningObject } from './current-learning-object.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { areMemoryClaimsCurrent, claimUndoToken, openClaimEvidence, openClaimFact } from './memory-claims.ts';
import { readMemoryGateway } from './memory-gateway.ts';

type Packet = NonNullable<Awaited<ReturnType<typeof readMemoryGateway>>>;
type Entry = {id: string; data: ReturnType<typeof structuredClaim>};
const loadCompanion = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
let companion: ReturnType<typeof loadCompanion> | undefined;

export const memoryWriteReceipt = (entry: Entry, rev: number, command: string): WorkspaceWriteReceipt => ({
  id: entry.id, rev, title: entry.data.action === 'forget' ? '已忘掉记忆' :
    entry.data.action === 'correct' ? '已更新记忆' : '已记住',
  memory: {status: 'saved', action: entry.data.action, undo_token: claimUndoToken(command, entry.id)},
});

export function openTurnMemory(options: {
  db: Db; answer: string; turn: string; source: {rev: number; accessEpoch: string}; currentObject?: OpenedCurrentLearningObject;
  retrieve: (query: string | undefined, step: number) => Promise<Packet>;
  authorize: (tx: ReadTransaction) => Promise<void>;
}) {
  const {db, answer, turn, source, currentObject} = options;
  const candidates = new Map<string, Packet['receipt']['basis'][number]>();
  const pending: Entry[] = [];
  const targets = new Set<string>();
  let opened = false;

  async function execute(name: string, args: Record<string, unknown>, step: number) {
    try {
      if (name === 'retrieve_memory') {
        if (Object.keys(args).some(key => key !== 'query')) throw new ClaimInputError('检索只接受可选的原文字词。');
        const query = args.query === undefined ? undefined : claimText(args.query, 120).trim();
        const packet = await options.retrieve(query, step);
        opened = true;
        for (const ref of packet.receipt.basis) if (ref.type === claimType) candidates.set(ref.id, ref);
        return packet.context;
      }

      if (Object.keys(args).some(key => !['action', 'text', 'scope', 'valid_until', 'quote_excerpt', 'supersedes', 'category'].includes(key)))
        throw new ClaimInputError('使用工具声明中的字段。');
      const {action, text, category, valid_until: expiry} = args;
      if (action !== 'remember' && action !== 'update' && action !== 'forget') throw new ClaimInputError('记忆操作无效。');
      const excerpt = claimText(args.quote_excerpt, 600);
      const start = answer.indexOf(excerpt);
      if (start < 0) throw new ClaimInputError('请逐字引用本轮学习者的实际消息。');
      if (action !== 'remember' && args.supersedes === undefined) throw new ClaimInputError('先用 retrieve_memory 确定一条旧记忆。');
      const target = args.supersedes === undefined ? undefined : candidates.get(claimId(args.supersedes));
      if (args.supersedes !== undefined && (!target || targets.has(target.id) || action === 'remember'))
        throw new ClaimInputError('使用本轮检索到且尚未变更的记忆。');
      if (args.scope !== undefined && !['general', 'current_object', 'unknown'].some(scope => scope === args.scope))
        throw new ClaimInputError('范围可为明确通用、当前对象或未知。');
      if (args.scope === 'current_object' && !currentObject)
        throw new ClaimInputError('本轮未绑定学习对象，不能使用当前对象范围。');
      const previous = target ? await db.snapshot({learner: studioLearner}, async tx => {
        await options.authorize(tx);
        const fact = await openClaimFact(tx, claimId(target.id));
        if (!fact) throw new ClaimInputError('目标记忆已变化。');
        return editableTurnClaim(fact.value);
      }) : undefined;
      const usePrevious = previous && (args.scope === undefined ||
        (args.scope === 'current_object' && previous.scope.kind === 'object' && previous.scope.object === currentObject?.root.id));
      const scopeInput = usePrevious ? previous.scope
        : args.scope === 'general' || args.scope === 'unknown' ? {kind: args.scope}
        : currentObject ? {kind: 'object', object: currentObject.root.id,
          basis: currentObject.basis.map(({id, rev, epoch}) => ({id, rev, accessEpoch: epoch}))} : {kind: 'unknown'};
      const valid_until = action === 'forget' ? null : expiry === undefined && previous ? previous.valid_until : claimExpiry(expiry);
      if (valid_until && valid_until <= new Date().toISOString()) throw new ClaimInputError('有效期须晚于当前时刻。');
      const entry = {id: factId(stableId('turn-memory-entry', turn, String(step))), data: structuredClaim({
        action: action === 'update' ? 'correct' : action, category: category ?? previous?.category ?? 'preference',
        origin: 'turn', text, scope: scopeInput, valid_until,
        evidence_refs: [{id: turn, ...source, excerpt, start}],
        supersedes: target ? {id: target.id, rev: target.rev, accessEpoch: target.epoch} : null,
      })};
      if (previous) requirePreservedObjectScope(previous.scope, entry.data.scope);
      pending.push(entry);
      if (target) targets.add(target.id);
      return JSON.stringify({ok: true, status: 'pending', action,
        message: '已记录本轮拟保存的操作。以本轮结束时的回执为准。'});
    } catch (error) {
      if (!(error instanceof ClaimInputError)) throw error;
      return JSON.stringify(learningToolError('invalid_memory',undefined,error.message));
    }
  }

  async function commit(): Promise<WorkspaceWriteReceipt[]> {
    if (!pending.length) return [];
    const handle = createCommandHandler(db, {modules: [await (companion ??= loadCompanion())],
      hooks: createStudioCommandHooks({async afterFactsChanged(tx) {
        await options.authorize(tx);
        if (!await areMemoryClaimsCurrent(tx, [...targets], turn)) throw new ClaimInputError('目标记忆已变化。');
        for (const {data} of pending) {
          const ref = data.evidence_refs[0]!;
          if (!await openClaimEvidence(tx, ref, ref.excerpt, ref.start)) throw new ClaimInputError('本轮原话不可用。');
          if (data.valid_until && data.valid_until <= new Date().toISOString()) throw new ClaimInputError('记忆已经过期。');
        }
      }}),
    });
    const receipt = await handle({learner: studioLearner, actor: 'companion', purpose,
      id: commandId(stableId('turn-memory-command', turn)), type: applyClaimCommand, input: {entries: pending}});
    return pending.flatMap(entry => {
      const written = receipt.wrote.find(ref => ref.id === entry.id);
      return written ? [memoryWriteReceipt(entry, written.rev, receipt.commandId)] : [];
    });
  }
  return {execute, commit, hasPending: () => pending.length > 0, used: () => pending.length > 0 || opened};
}

export function isMemoryConflict(error: unknown) {
  return error instanceof ClaimInputError || error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
}
