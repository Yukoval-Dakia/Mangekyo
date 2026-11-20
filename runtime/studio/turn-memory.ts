import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import type { WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import {
  applyClaimCommand, claimEvidence, claimExpiry, claimId, claimType, ClaimInputError, claimText, editableTurnClaim,
  requirePreservedObjectScope, structuredClaim,
} from '../../modules/companion/claim.ts';
import { beliefFields, beliefInput, beliefToolFailure, directiveDetails, hypothesisRequest, quoteFromTurn, saveBeliefCommand } from '../../modules/companion/belief.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import { extractedUnderstanding, type ActivityCitation } from '../../modules/companion/understanding.ts';
import { hypothesisIsHead, openObjectiveCitations } from './belief-evidence.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { OpenedCurrentLearningObject } from './current-learning-object.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { areMemoryClaimsCurrent, claimUndoToken, openClaimEvidence, openClaimFact } from './memory-claims.ts';
import { readMemoryGateway } from './memory-gateway.ts';

type Packet = NonNullable<Awaited<ReturnType<typeof readMemoryGateway>>>;
type Entry = {id: string; data: ReturnType<typeof structuredClaim>};
type AssertionEntry = ReturnType<typeof beliefInput>['assertions'][number];
const loadCompanion = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
let companion: ReturnType<typeof loadCompanion> | undefined;

export const memoryWriteReceipt = (entry: {id: string; data: Pick<Entry['data'], 'action'>}, rev: number, command: string): WorkspaceWriteReceipt => ({
  id: entry.id, rev, title: entry.data.action === 'forget' ? '已忘掉记忆' :
    entry.data.action === 'correct' ? '已更新记忆' : '已记住',
  memory: {status: 'saved', action: entry.data.action, undo_token: claimUndoToken(command, entry.id)},
});

export function openTurnMemory(options: {
  db: Db; answer: string; turn: string; source: {rev: number; accessEpoch: string}; currentObject?: OpenedCurrentLearningObject;
  retrieve: (query: string | undefined, step: number) => Promise<Packet>;
  belief?: {opened: (citation: ActivityCitation) => boolean; maySend: WorkspaceSourceRecipient};
  authorize: (tx: ReadTransaction) => Promise<void>;
}) {
  const {db, answer, turn, source, currentObject} = options;
  const candidates = new Map<string, Packet['receipt']['basis'][number]>();
  const pending: Entry[] = [];
  const assertions: AssertionEntry[] = [];
  const hypothesisTargets = new Set<string>();
  const targets = new Set<string>();
  let opened = false;
  async function stageHypothesis(args: Record<string, unknown>, step: number) {
    const {action, text, supersedes, scope, quote_excerpt} = args;
    const belief = options.belief!;
    const refs = hypothesisRequest(args, currentObject?.root.id, belief.opened);
    const target = action === 'remember' ? undefined : candidates.get(claimId(supersedes));
    if (action !== 'remember' && (target?.type !== memoryAssertionType || hypothesisTargets.has(target.id)))
      throw new ClaimInputError('先检索本轮可变更的实证假设。');
    const quote = action === 'forget' ? claimEvidence({id: turn, ...source, ...quoteFromTurn(answer, quote_excerpt)}) : null;
    const previous = await db.snapshot({learner: studioLearner}, async tx => {
      await options.authorize(tx);
      if ((await openObjectiveCitations(tx, refs, purpose, belief.maySend)).length !== refs.length)
        throw new ClaimInputError('原始作答或权限已变更。');
      if (!target) return;
      const fact = await openClaimFact(tx, claimId(target.id));
      if (fact?.type !== memoryAssertionType || fact.ref.rev !== target.rev || fact.accessEpoch !== target.epoch ||
          !await hypothesisIsHead(tx, target.id, turn))
        throw new ClaimInputError('假设版本已变更。');
      const value = extractedUnderstanding(fact.value);
      if (!value.belief || value.belief.forgotten || value.sticky || (text !== undefined && text !== value.text))
        throw new ClaimInputError('核验只能追加证据，原假设文字保持不变。');
      return value;
    });
    const id = claimId(stableId('turn-memory-entry', turn, String(step)));
    const data = extractedUnderstanding({version: 2, kind: 'observation', ttl: null, sticky: false,
      text: previous?.text ?? text,
      scope: previous?.scope ?? (scope === 'general' ? {kind: 'general'} : {kind: 'object', object: currentObject!.root.id}),
      evidence_refs: [...(previous?.evidence_refs ?? []), ...refs],
      undo_token: claimUndoToken(stableId('turn-belief-command', turn), id),
      belief: {turn, forgotten: !!quote, supersedes: target ? {id: target.id, rev: target.rev, accessEpoch: target.epoch} : null},
    });
    assertions.push({id, data: {...data, belief: data.belief!}, quote});
    if (target) hypothesisTargets.add(target.id);
  }
  const pendingReply = (action: string) => JSON.stringify({ok: true, status: 'pending', action, message: '已记录本轮拟保存的操作。以本轮结束时的回执为准。'});
  async function execute(name: string, args: Record<string, unknown>, step: number) {
    try {
      if (name === 'retrieve_memory') {
        if (Object.keys(args).some(key => key !== 'query')) throw new ClaimInputError('检索只接受可选的原文字词。');
        const query = args.query === undefined ? undefined : claimText(args.query, 120).trim();
        const packet = await options.retrieve(query, step);
        opened = true;
        for (const ref of packet.receipt.basis) if (ref.type === claimType || ref.type === memoryAssertionType) candidates.set(ref.id, ref);
        return packet.context;
      }

      const explicit = name === 'save_belief';
      if (explicit !== Boolean(options.belief) || (!explicit && name !== 'save_memory'))
        throw new ClaimInputError('本轮未开放该保存工具。');
      const {action, category, valid_until: expiry} = args;
      if (action !== 'remember' && action !== 'update' && action !== 'forget') throw new ClaimInputError('记忆操作无效。');
      if (explicit && category !== 'directive' && category !== 'hypothesis')
        throw new ClaimInputError('category 须为 directive 或 hypothesis。');
      if (pending.length + assertions.length >= 12) throw new ClaimInputError('每轮最多保存 12 项 Belief。');
      if (explicit && category === 'hypothesis') {
        await stageHypothesis(args, step);
        return pendingReply(action);
      }
      beliefFields(args, ['text', 'scope', 'valid_until', 'quote_excerpt', 'supersedes',
        ...(explicit ? ['kind', 'goal', 'intent_key', 'reopen_condition'] : [])]);
      const {excerpt, start} = quoteFromTurn(answer, args.quote_excerpt);
      if (action !== 'remember' && args.supersedes === undefined) throw new ClaimInputError('先用 retrieve_memory 确定一条旧记忆。');
      const target = args.supersedes === undefined ? undefined : candidates.get(claimId(args.supersedes));
      if (args.supersedes !== undefined && (!target || target.type !== claimType || targets.has(target.id) || action === 'remember'))
        throw new ClaimInputError('使用本轮检索到且尚未变更的记忆。');
      if (args.scope !== undefined && !['general', 'current_object', 'unknown'].some(scope => scope === args.scope))
        throw new ClaimInputError('范围可为明确通用、当前对象或未知。');
      if (args.scope === 'current_object' && !currentObject)
        throw new ClaimInputError('本轮未绑定学习对象，不能使用当前对象范围。');
      const previous = target ? await db.snapshot({learner: studioLearner}, async tx => {
        await options.authorize(tx);
        const fact = await openClaimFact(tx, claimId(target.id));
        if (!fact || fact.ref.rev !== target.rev || fact.accessEpoch !== target.epoch)
          throw new ClaimInputError('目标记忆已变化。');
        if (!explicit) return editableTurnClaim(fact.value);
        const value = structuredClaim(fact.value);
        if (value.authority !== 'directive' || value.action === 'forget' || (args.kind !== undefined && args.kind !== value.category))
          throw new ClaimInputError('请选择同类、仍生效的主权规则。');
        return value;
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
        action: action === 'update' ? 'correct' : action, ...directiveDetails(args, explicit, excerpt, previous),
        origin: 'turn', scope: scopeInput, valid_until,
        evidence_refs: [{id: turn, ...source, excerpt, start}],
        supersedes: target ? {id: target.id, rev: target.rev, accessEpoch: target.epoch} : null,
      })};
      if (previous) requirePreservedObjectScope(previous.scope, entry.data.scope);
      pending.push(entry);
      if (target) targets.add(target.id);
      return pendingReply(action);
    } catch (error) {
      if (!(error instanceof ClaimInputError)) throw error;
      return JSON.stringify(options.belief ? beliefToolFailure(name, error.message) : learningToolError('invalid_memory',undefined,error.message));
    }
  }
  async function commit(): Promise<WorkspaceWriteReceipt[]> {
    if (!pending.length && !assertions.length) return [];
    const handle = createCommandHandler(db, {modules: [await (companion ??= loadCompanion())],
      hooks: createStudioCommandHooks({async afterFactsChanged(tx) {
        await options.authorize(tx);
        if (!await areMemoryClaimsCurrent(tx, [...targets], turn)) throw new ClaimInputError('目标记忆已变化。');
        for (const {id, data, quote} of assertions) {
          if (data.belief.supersedes && !await hypothesisIsHead(tx, data.belief.supersedes.id, undefined,
            id))
            throw new ClaimInputError('目标假设已变化。');
          if (quote && !await openClaimEvidence(tx, quote, quote.excerpt, quote.start))
            throw new ClaimInputError('撤回原话不可用。');
          if ((await openObjectiveCitations(tx, data.evidence_refs, purpose, options.belief!.maySend)).length !== data.evidence_refs.length)
            throw new ClaimInputError('假设证据当前不可用。');
        }
        for (const {data} of pending) {
          const ref = data.evidence_refs[0]!;
          if (!await openClaimEvidence(tx, ref, ref.excerpt, ref.start)) throw new ClaimInputError('本轮原话不可用。');
          if (data.valid_until && data.valid_until <= new Date().toISOString()) throw new ClaimInputError('记忆已经过期。');
        }
      }}),
    });
    const operation = options.belief
      ? {id: commandId(stableId('turn-belief-command', turn)), type: saveBeliefCommand,
        input: {turn, directives: pending, hypotheses: assertions}}
      : {id: commandId(stableId('turn-memory-command', turn)), type: applyClaimCommand, input: {entries: pending}};
    const receipt = await handle({learner: studioLearner, actor: 'companion', purpose, ...operation});
    const entries = [...pending, ...assertions.map(({id, data}) => ({id,
      data: {action: data.belief.forgotten ? 'forget' as const : data.belief.supersedes ? 'correct' as const : 'remember' as const}}))];
    return entries.flatMap(entry => {
      const written = receipt.wrote.find(ref => ref.id === entry.id);
      return written ? [memoryWriteReceipt(entry, written.rev, receipt.commandId)] : [];
    });
  }
  const hasPending = () => pending.length > 0 || assertions.length > 0;
  return {execute, commit, hasPending, used: () => hasPending() || opened};
}

export function isMemoryConflict(error: unknown) {
  return error instanceof ClaimInputError || error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
}
