import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { studyTurn, turnResearchPurpose } from '../../modules/activity/values.ts';
import { setWorkspaceTeachingCommand } from '../../modules/activity/workspace-values.ts';
import {
  applyClaimCommand, claimId, claimRef, claimText, claimType, ClaimInputError, manageClaimCommand, structuredClaim, undoClaimCommand,
} from '../../modules/companion/claim.ts';
import { manageMemoryAssertionCommand, memoryAssertionType } from '../../modules/companion/memory-assertion.ts';
import { citationExcerpt, extractedUnderstanding, reviewUnderstanding, understandingPresentation } from '../../modules/companion/understanding.ts';
import { openUnderstandingCitations } from './research-understanding.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { areMemoryClaimsCurrent, claimUndoToken, claimWitness, currentMemoryClaims, managedClaimEvidence, openClaimFact, readClaimValue } from './memory-claims.ts';
import { clientRequest, readOwnStudyTurn, RequestError, turnResearchAccess } from './sessions.ts';
import { completeTurnStream } from './stream.ts';
import { isMemoryConflict, memoryWriteReceipt } from './turn-memory.ts';

export function openMemoryManagement(db: Db, activity: LoadedModule, companion: LoadedModule) {
  const learner = studioLearner;
  const scope = {learner};
  const manageAssertion = createCommandHandler(db, {modules: [companion], hooks: createStudioCommandHooks()});
  const revokeTurn = createCommandHandler(db, {modules: [activity], hooks: createStudioCommandHooks({
    async afterFactsChanged(tx, _tick, changes) {
      for (const change of changes) {
        if (change.factType !== 'activity.studyTurn') throw new ClaimInputError('目标不是同伴原话。');
        await completeTurnStream(tx, change.ref.id);
      }
    },
  })});
  async function translate<T>(run: () => Promise<T>) {
    try { return await run(); } catch (error) {
      if (isMemoryConflict(error) || error instanceof Error && error.message.startsWith('Fact revision conflict:'))
        throw new RequestError(409, '记忆或依据已变化，请刷新后再试。');
      throw error;
    }
  }

  return {
    async list(before: string | null) {
      if (before !== null) {
        try { claimId(before); } catch { throw new RequestError(400, '记忆分页位置无效。'); }
      }
      return db.snapshot(scope, async tx => {
        const rows = await currentMemoryClaims(tx, {learner: true, ...(before ? {before} : {})});
        const items = [];
        for (const {id, tick} of rows.slice(0, 50)) {
          const fact = await openClaimFact(tx, id, 'storage');
          if (!fact) continue;
          const claim = readClaimValue(fact.value);
          const ref = claimWitness(fact);
          const evidenceState = await managedClaimEvidence(tx, claim);
          items.push({ref, recordedTick: tick, state: claim?.version === 1 && claim.action === 'forget' ? 'forgotten' : 'current',
            claim: evidenceState === 'unavailable' ? null : claim ?? null, evidenceState});
        }
        const {rows: extracted} = await tx.query<{id: string}>(`SELECT f.id FROM facts f JOIN fact_revs r
          ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
          WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'version'='2'
          ORDER BY f.changed_tick DESC,f.id LIMIT 50`, [learner, memoryAssertionType]);
        const understandings = [];
        for (const {id} of extracted) {
          const fact = await openClaimFact(tx, factId(id), 'storage');
          if (!fact) continue;
          const data = extractedUnderstanding(fact.value);
          const sources = await openUnderstandingCitations(tx, data.evidence_refs, 'storage');
          const evidenceState = sources.length === data.evidence_refs.length ? 'current' : 'unavailable';
          understandings.push({ref: claimWitness(fact), evidenceState,
            ...(data.evidence_refs.some(ref => ref.span) ? {status: data.sticky ? 'learner-corrected' : 'tentative'} : {}),
            understanding: evidenceState === 'current'
              ? {...data, kind: understandingPresentation(data, sources), review: reviewUnderstanding(fact.ref.id, data, sources),
                evidence_refs: data.evidence_refs.map((ref, index) => ({...ref, excerpt: citationExcerpt(sources[index]!, ref)}))}
              : {...data, text: null, scope: null, evidence_refs: []}});
        }
        return {items, understandings, next: rows.length > 50 ? rows[49]!.id : null};
      });
    },

    async manage(id: string, input: Record<string, unknown>) {
      const request = clientRequest(input.requestId);
      let entry;
      try {
        const {rowCount: extracted} = await db.query(`SELECT 1 FROM facts f JOIN fact_revs b
          ON (b.learner_id,b.fact_id,b.rev)=(f.learner_id,f.id,1)
          WHERE f.learner_id=$1 AND f.id=$2 AND f.type=$3 AND b.data->>'version'='2'`, [learner, claimId(id), memoryAssertionType]);
        if (extracted) {
          if (input.action !== 'correct' && input.action !== 'forget') throw new ClaimInputError('记忆操作无效。');
          const {rev, accessEpoch} = claimRef({id, rev: input.rev, accessEpoch: input.accessEpoch});
          const receipt = await translate(() => manageAssertion({learner, actor: 'learner', purpose: 'storage',
            type: manageMemoryAssertionCommand, id: commandId(stableId('learner-understanding-command', id, request)),
            input: input.action === 'forget' ? {id, action: 'forget-extracted', rev, accessEpoch}
              : {id, action: 'correct-extracted', rev, accessEpoch, text: claimText(input.text, 600)}}));
          return {status: input.action === 'forget' ? 'withdrawn' : 'corrected', ref: receipt.wrote[0]};
        }
        if (input.action !== 'correct' && input.action !== 'forget') throw new ClaimInputError('记忆操作无效。');
        const {rev, accessEpoch} = input;
        const supersedes = claimRef({id, rev, accessEpoch});
        entry = {id: factId(stableId('learner-memory-entry', id, request)), data: structuredClaim({
          action: input.action, category: 'claim', origin: 'learner', text: input.text, scope: {kind: 'unknown'},
          evidence_refs: [], supersedes,
        })};
      } catch (error) {
        if (!(error instanceof ClaimInputError)) throw error;
        throw new RequestError(400, error.message);
      }
      const handle = createCommandHandler(db, {modules: [companion], hooks: createStudioCommandHooks({
        async afterFactsChanged(tx) {
          if (!await areMemoryClaimsCurrent(tx, [id], undefined, entry.id)) throw new ClaimInputError('已出现更新的记忆。');
        },
      })});
      const receipt = await translate(() => handle({learner, actor: 'learner', purpose: 'storage',
        id: commandId(stableId('learner-memory-command', id, request)), type: manageClaimCommand, input: entry}));
      return memoryWriteReceipt(entry, receipt.wrote[0]!.rev, receipt.commandId);
    },

    async undo(id: string, input: Record<string, unknown>) {
      if (typeof input.undo_token !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.undo_token))
        throw new RequestError(400, '撤回凭据无效。');
      const {rows: [extracted]} = await db.query(
        `SELECT 1 FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1
          AND data->>'version'='2' AND data->>'undo_token'=$3`, [learner, id, input.undo_token]);
      if (extracted) {
        const receipt = await translate(() => manageAssertion({learner, actor: 'learner', purpose: 'storage',
          type: manageMemoryAssertionCommand, id: commandId(stableId('undo-memory-command', input.undo_token as string)),
          input: {id, action: 'undo-extracted', token: input.undo_token as string}}));
        return {status: 'withdrawn', ref: receipt.wrote[0]};
      }
      const {rows: [born]} = await db.query<{command_id: string}>(`
        SELECT r.command_id FROM facts f JOIN fact_revs r ON (f.learner_id,f.id)=(r.learner_id,r.fact_id)
        JOIN commands c ON (c.learner_id,c.id)=(r.learner_id,r.command_id)
        WHERE f.learner_id=$1 AND f.id=$2 AND f.type=$3 AND r.rev=1
          AND c.state='done' AND c.type=ANY($4::text[])`, [learner, id, claimType, [applyClaimCommand, manageClaimCommand]]);
      if (!born || claimUndoToken(born.command_id, id) !== input.undo_token)
        throw new RequestError(404, '找不到该条目对应的可撤回凭据。');
      const handle = createCommandHandler(db, {modules: [companion], hooks: createStudioCommandHooks({
        async afterFactsChanged(tx) {
          if (!await areMemoryClaimsCurrent(tx, [id], undefined, undefined, true))
            throw new ClaimInputError('已有后续变更。');
        },
      })});
      const receipt = await translate(() => handle({learner, actor: 'learner', purpose: 'storage',
        id: commandId(stableId('undo-memory-command', input.undo_token as string)), type: undoClaimCommand, input: {id, rev: 1, accessEpoch: '0'}}));
      return {status: 'withdrawn', ref: receipt.wrote[0]};
    },

    async revokeSource(id: string, input: Record<string, unknown>) {
      const {expectedRev} = input;
      if (typeof expectedRev !== 'number' || !Number.isSafeInteger(expectedRev) || expectedRev < 1 || expectedRev > 2_147_483_647)
        throw new RequestError(400, '原话版本无效。');
      const use = input.purpose === undefined ? purpose : input.purpose;
      if (use !== purpose && use !== turnResearchPurpose) throw new RequestError(400, '原话用途无效。');
      const read = () => translate(() => db.snapshot(scope, tx => readOwnStudyTurn(tx, id)));
      const turn = await read();
      if (studyTurn(turn.value).caseId !== 'companion' || turn.purpose.includes('all'))
        throw new RequestError(409, '此原话用途不可单独撤回。');
      if (turn.ref.rev === expectedRev && !turn.purpose.includes(use))
        return {status: 'revoked', ref: turn.ref, backgroundUnderstanding: turnResearchAccess(turn)};
      const research = use === turnResearchPurpose;
      const receipt = await translate(() => revokeTurn({learner, actor:'learner', purpose: use, type: setWorkspaceTeachingCommand,
        id: commandId(stableId(research ? 'revoke-memory-source-research' : 'revoke-memory-source', id, String(expectedRev))),
        input: {id, expectedRev, enabled: false, ...(research ? {purpose: use} : {})}}));
      return {status: 'revoked', ref: receipt.wrote[0], backgroundUnderstanding: turnResearchAccess(await read())};
    },
  };
}
