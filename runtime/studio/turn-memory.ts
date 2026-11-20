import { openHypothesisObject } from './hypothesis-object.ts';
import type {DeliveredToolRange} from '../../executors/teaching/learning-tools.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { fileURLToPath } from 'node:url';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import type { WorkspaceWriteReceipt } from '../../executors/teaching/workspace-tools.ts';
import {
  applyClaimCommand, claimEvidence, claimId, claimType, ClaimInputError, editableTurnClaim, editableTurnDirective,
  claimRef, structuredClaim,
} from '../../modules/companion/claim.ts';
import { beliefInput, beliefReceiptAction, memoryReceipt, beliefToolFailure, checkedHypothesis, hypothesisRequest, quoteFromTurn, saveBeliefCommand, turnClaimData, turnHypothesisData, validateDirectiveScope, turnMemoryAction, memoryRetrieveQuery, directiveTarget, pendingMemoryReply } from '../../modules/companion/belief.ts';
import { memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import type { ActivityCitation } from '../../modules/companion/understanding.ts';
import { hypothesisIsHead, openObjectiveCitations } from './belief-evidence.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import type { OpenedCurrentLearningObject } from './current-learning-object.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { areMemoryClaimsCurrent, claimUndoToken, openClaimEvidence, openClaimFact, turnMemoryKey } from './memory-claims.ts';
import { readMemoryGateway } from './memory-gateway.ts';

type Packet = NonNullable<Awaited<ReturnType<typeof readMemoryGateway>>>;
type Entry = {id: string; data: ReturnType<typeof structuredClaim>};
type AssertionEntry = ReturnType<typeof beliefInput>['assertions'][number];
const targetRef = (target: Packet['receipt']['basis'][number] | undefined) =>
  target ? claimRef({id: target.id, rev: target.rev, accessEpoch: target.epoch}) : null;
const loadCompanion = () => loadModuleDirectory(fileURLToPath(new URL('../../modules/companion', import.meta.url)));
let companion: ReturnType<typeof loadCompanion> | undefined;

export const memoryWriteReceipt = (entry: {id: string; data: Pick<Entry['data'], 'action'>}, rev: number, command: string): WorkspaceWriteReceipt =>
  memoryReceipt(entry.id, rev, entry.data.action, claimUndoToken(command, entry.id));

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
  function rememberRetrieved(packet: Packet) {
    opened = true;
    for (const ref of packet.receipt.sent) {
      if (ref.type === claimType || ref.type === memoryAssertionType) candidates.set(ref.id, ref);
    }
  }
  const managementReads = new Map<number, {packet: Packet; ranges: [number, number][]}>();
  function offerManagement(step: number, packet: Packet) {
    opened = true;
    managementReads.set(step, {packet, ranges: []});
  }
  function onDelivered({step, output, start, end}: DeliveredToolRange) {
    const read = managementReads.get(step);
    const claims = read?.packet.bundle.data.claims;
    if (!read || !claims?.length) return;
    // Claims are the sole region in a management response. Locate its serialized array
    // inside the executor envelope; offsets use the same string units as handle paging.
    const key = '"claims":';
    const offset = output.indexOf(key + JSON.stringify(claims));
    if (offset < 0) return;
    read.ranges.push([start,end]);
    read.ranges.sort((a,b) => a[0] - b[0]);
    const covered: [number, number][] = [];
    for (const range of read.ranges) {
      const last = covered.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1],range[1]);
      else covered.push(range);
    }
    read.ranges = covered;
    let position = offset + key.length + 1;
    for (const item of claims) {
      const limit = position + JSON.stringify(item).length;
      if (item && typeof item === 'object' && 'id' in item && 'rev' in item &&
          covered.some(([from,to]) => from <= position && limit <= to)) {
        const ref = read.packet.receipt.sent.find(ref => (ref.type === claimType || ref.type === memoryAssertionType) &&
          ref.id === item.id && ref.rev === item.rev);
        if (ref) candidates.set(ref.id,ref);
      }
      position = limit + 1;
    }
  }
  async function stageHypothesis(args: Record<string, unknown>, step: number) {
    const {action, text, supersedes, quote_excerpt} = args;
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
      const data = checkedHypothesis(fact.value, text);
      if (data.scope.kind === 'object') {
        const basis = await openHypothesisObject(tx, data, belief.maySend);
        if (!basis) throw new ClaimInputError('对象假设依据已变化。');
        return {...data, belief:{...data.belief!, objectBasis:basis}};
      }
      return data;
    });
    const id = claimId(stableId('turn-memory-entry', turn, String(step)));
    const data = turnHypothesisData(args, {turn, refs, ...(currentObject && {object: {id:currentObject.root.id, basis:currentObject.basis}}),
      ...(previous && {previous}), supersedes: targetRef(target),
      undoToken: claimUndoToken(turnMemoryKey(turn, true), id)});
    assertions.push({id, data, quote});
    if (target) hypothesisTargets.add(target.id);
  }
  async function execute(name: string, args: Record<string, unknown>, step: number) {
    try {
      if (name === 'retrieve_memory') {
        const packet = await options.retrieve(memoryRetrieveQuery(args), step);
        rememberRetrieved(packet);
        return packet.context;
      }
      const explicit = !!options.belief;
      const {action, hypothesis} = turnMemoryAction(name, args, explicit, pending.length + assertions.length);
      if (hypothesis) {
        await stageHypothesis(args, step);
        return pendingMemoryReply(action);
      }
      const {excerpt, start} = quoteFromTurn(answer, args.quote_excerpt);
      const target = directiveTarget(args, candidates, targets);
      validateDirectiveScope(args.scope, !!currentObject);
      const previous = target ? await db.snapshot({learner: studioLearner}, async tx => {
        await options.authorize(tx);
        const fact = await openClaimFact(tx, claimId(target.id));
        if (!fact || fact.ref.rev !== target.rev || fact.accessEpoch !== target.epoch)
          throw new ClaimInputError('目标记忆已变化。');
        return explicit ? editableTurnDirective(fact.value, args.kind) : editableTurnClaim(fact.value);
      }) : undefined;
      const data = turnClaimData(args, {explicit, now: new Date().toISOString(),
        ...(currentObject && {object: {id: currentObject.root.id, basis: currentObject.basis}}),
        ...(previous && {previous}), quote: {id: turn, ...source, excerpt, start}, supersedes: targetRef(target)});
      const entry = {id: factId(stableId('turn-memory-entry', turn, String(step))), data};
      pending.push(entry);
      if (target) targets.add(target.id);
      return pendingMemoryReply(action);
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
          if (data.belief.supersedes && !await hypothesisIsHead(tx, data.belief.supersedes.id, undefined, id))
            throw new ClaimInputError('目标假设已变化。');
          if (!await openHypothesisObject(tx, data, options.belief!.maySend)) throw new ClaimInputError('对象假设依据已变化。');
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
      ? {id: commandId(turnMemoryKey(turn, true)), type: saveBeliefCommand,
        input: {turn, directives: pending, hypotheses: assertions}}
      : {id: commandId(turnMemoryKey(turn, false)), type: applyClaimCommand, input: {entries: pending}};
    const receipt = await handle({learner: studioLearner, actor: 'companion', purpose, ...operation});
    const entries = [...pending, ...assertions.map(({id, data}) => ({id, data: {action: beliefReceiptAction(data)}}))];
    return entries.flatMap(entry => {
      const written = receipt.wrote.find(ref => ref.id === entry.id);
      return written ? [memoryWriteReceipt(entry, written.rev, receipt.commandId)] : [];
    });
  }
  const hasPending = () => pending.length > 0 || assertions.length > 0;
  return {execute, commit, hasPending, offerManagement, onDelivered, used: () => hasPending() || opened};
}

export function isMemoryConflict(error: unknown) {
  return error instanceof ClaimInputError || error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
}
