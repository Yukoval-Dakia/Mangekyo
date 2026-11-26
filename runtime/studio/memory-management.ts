import { commandId, factId, isKernelErrorKind, mapKernelError, readFactCommandBirth, type Db } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyTurn, turnResearchAccess, turnResearchPurpose } from '../../modules/activity/values.ts';
import { setWorkspaceTeachingCommand } from '../../modules/activity/workspace-values.ts';
import { saveBeliefCommand, undoHypothesisCommand } from '../../modules/companion/belief.ts';
import { applyClaimCommand, claimId, ClaimInputError, claimRef, claimType, manageClaimCommand, structuredClaim, undoClaimCommand } from '../../modules/companion/claim.ts';
import { manageMemoryAssertionCommand, memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import { listManagedMemory } from '../../modules/companion/memory-overview.ts';
import { buildManageExtractedInput, isUndoToken, parseRevokeSourceInput } from '../../modules/companion/memory-slice.ts';
import { hypothesisIsHead, openObjectiveCitations } from './belief-evidence.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { openHypothesisObject } from './hypothesis-object.ts';
import { purpose, stableId, studioHost, studioLearner, ulidExact } from './identity.ts';
import { areMemoryClaimsCurrent, claimUndoToken, managedClaimEvidence, openClaimFact } from './memory-claims.ts';
import { notionReadScope } from './notion.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { clientRequest, readOwnStudyTurn, RequestError } from './sessions.ts';
import { completeTurnStream } from './stream.ts';
import { isMemoryConflict, memoryWriteReceipt } from './turn-memory.ts';

export function openMemoryManagement(db: Db, activity: LoadedModule, companion: LoadedModule) {
  const host = studioHost(db);
  const manageAssertion = host.boundHandler([companion], createStudioCommandHooks({ async afterFactsChanged(tx, _tick, changes) {
    for (const { ref, factType } of changes) if (factType === memoryAssertionType && !await hypothesisIsHead(tx, ref.id)) throw new ClaimInputError('已有后续核验。');
  } }));
  const revokeTurn = host.boundHandler([activity], createStudioCommandHooks({ async afterFactsChanged(tx, _tick, changes) {
    for (const change of changes) {
      if (change.factType !== 'activity.studyTurn') throw new ClaimInputError('目标不是同伴原话。');
      await completeTurnStream(tx, change.ref.id);
    }
  } }));
  const translate = <T>(run: () => Promise<T>) => run().catch(error => {
    if (isMemoryConflict(error) || isKernelErrorKind(error, 'revision_conflict')) throw new RequestError(409, '记忆或依据已变化，请刷新后再试。');
    throw error;
  });
  const claimHandler = (check: (tx: Parameters<typeof areMemoryClaimsCurrent>[0]) => Promise<void>) =>
    host.boundHandler([companion], createStudioCommandHooks({ afterFactsChanged: async tx => check(tx) }));

  return {
    async list(before: string | null) {
      if (before !== null) { try { claimId(before); } catch { throw new RequestError(400, '记忆分页位置无效。'); } }
      return notionReadScope(db, studioLearner, { readOnly: true }).read((tx, check) => listManagedMemory(tx, before, {
        openClaim: id => openClaimFact(tx, id, 'storage'), evidenceState: claim => managedClaimEvidence(tx, claim),
        openHypothesisObject: data => openHypothesisObject(tx, data, () => true, check),
        openObjectiveCitations: refs => openObjectiveCitations(tx, refs, purpose, () => true),
        openUnderstandingCitations: refs => openUnderstandingCitations(tx, refs, 'storage'),
      }));
    },
    async manage(id: string, input: Record<string, unknown>) {
      const request = clientRequest(input.requestId);
      let entry;
      try {
        const { rows: [extracted] } = await db.query<{ belief: boolean }>(`SELECT b.data ? 'belief' AS belief FROM facts f JOIN fact_revs b
          ON (b.learner_id,b.fact_id,b.rev)=(f.learner_id,f.id,1) WHERE f.learner_id=$1 AND f.id=$2 AND f.type=$3 AND b.data->>'version'='2'`,
          [studioLearner, claimId(id), memoryAssertionType]);
        if (extracted) {
          const { status, commandInput } = buildManageExtractedInput(id, input, extracted.belief);
          const receipt = await translate(() => manageAssertion({ purpose: 'storage', type: manageMemoryAssertionCommand,
            id: commandId(stableId('learner-understanding-command', id, request)), input: commandInput }));
          return { status, ref: receipt.wrote[0] };
        }
        if (input.action !== 'correct' && input.action !== 'forget') throw new ClaimInputError('记忆操作无效。');
        entry = { id: factId(stableId('learner-memory-entry', id, request)), data: structuredClaim({
          action: input.action, category: 'claim', origin: 'learner', text: input.text, scope: { kind: 'unknown' },
          evidence_refs: [], supersedes: claimRef({ id, rev: input.rev, accessEpoch: input.accessEpoch }),
        }) };
      } catch (error) { if (!(error instanceof ClaimInputError)) throw error; throw new RequestError(400, error.message); }
      const handle = claimHandler(async tx => { if (!await areMemoryClaimsCurrent(tx, [id], undefined, entry.id)) throw new ClaimInputError('已出现更新的记忆。'); });
      const receipt = await translate(() => handle({ purpose: 'storage',
        id: commandId(stableId('learner-memory-command', id, request)), type: manageClaimCommand, input: entry }));
      return memoryWriteReceipt(entry, receipt.wrote[0]!.rev, receipt.commandId);
    },
    async undo(id: string, input: Record<string, unknown>) {
      if (!isUndoToken(input.undo_token)) throw new RequestError(400, '撤回凭据无效。');
      const token = input.undo_token, undoCmdId = commandId(stableId('undo-memory-command', token));
      const { rows: [extracted] } = await db.query<{ belief: boolean }>(
        `SELECT data ? 'belief' AS belief FROM fact_revs
         WHERE learner_id=$1 AND fact_id=$2 AND rev=1 AND data->>'version'='2' AND data->>'undo_token'=$3`,
        [studioLearner, id, token]);
      if (extracted) {
        const receipt = await translate(() => manageAssertion({ purpose: 'storage',
          type: extracted.belief ? undoHypothesisCommand : manageMemoryAssertionCommand,
          id: undoCmdId, input: { id, ...(extracted.belief ? {} : { action: 'undo-extracted' }), token } }));
        return { status: 'withdrawn', ref: receipt.wrote[0] };
      }
      const born = ulidExact.test(id) ? await readFactCommandBirth(db, studioLearner, factId(id),
        { rev: 1, factType: claimType, commandTypes: [applyClaimCommand, manageClaimCommand, saveBeliefCommand] }) : undefined;
      if (!born || claimUndoToken(born.commandId, id) !== token) throw new RequestError(404, '找不到该条目对应的可撤回凭据。');
      const handle = claimHandler(async tx => { if (!await areMemoryClaimsCurrent(tx, [id], undefined, undefined, true)) throw new ClaimInputError('已有后续变更。'); });
      const receipt = await translate(() => handle({ purpose: 'storage', id: undoCmdId, type: undoClaimCommand, input: { id, rev: 1, accessEpoch: '0' } }));
      return { status: 'withdrawn', ref: receipt.wrote[0] };
    },
    async revokeSource(id: string, input: Record<string, unknown>) {
      const parsed = parseRevokeSourceInput(input, purpose, turnResearchPurpose);
      if (!parsed.ok) throw new RequestError(400, parsed.message);
      const { expectedRev, use } = parsed, read = () => translate(() => host.snapshot(tx => readOwnStudyTurn(tx, id))), turn = await read();
      if (studyTurn(turn.value).caseId !== 'companion' || turn.purpose.includes('all')) throw new RequestError(409, '此原话用途不可单独撤回。');
      if (turn.ref.rev === expectedRev && !turn.purpose.includes(use)) return { status: 'revoked', ref: turn.ref, backgroundUnderstanding: turnResearchAccess(turn) };
      const research = use === turnResearchPurpose;
      const receipt = await translate(() => revokeTurn({ purpose: use, type: setWorkspaceTeachingCommand,
        id: commandId(stableId(research ? 'revoke-memory-source-research' : 'revoke-memory-source', id, String(expectedRev))),
        input: { id, expectedRev, enabled: false, ...(research && { purpose: use }) } }));
      return { status: 'revoked', ref: receipt.wrote[0], backgroundUnderstanding: turnResearchAccess(await read()) };
    },
  };
}
