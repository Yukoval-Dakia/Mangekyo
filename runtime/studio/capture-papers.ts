import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, derivationId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import type { DerivationSnapshot, FactSnapshot, Json, Outcome, ReadContext, SlotRef } from '../../kernel/src/declarations/types.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { layeredExtractionDeriver, layeredExtractionSlot, type LayeredExtractionValue } from '../../modules/capture/extraction.ts';
import {
  bindPaperCommandRead, collectPaperInput, collectPaperWrites, defaultPaperRunId, paperIssuance, paperIssuanceId,
  paperIssuanceType, paperRun, paperRunType, projectIssuedPaper, type PaperExtractionReader,
} from '../../modules/capture/paper.ts';
import { questionVerificationKey, questionVerificationType, type QuestionVerification } from '../../modules/content/question-state.ts';
import { stableId, studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';

const purpose = 'storage';
const scope = { learner: studioLearner };
const conflict = '卷面、题目发放状态或回收依据已变化。';

async function openSlot<Value>(tx: ReadTransaction, slot: SlotRef, deriver: string, use: string, pinnedId?: string) {
  const { rows: [row] } = await tx.query<{ id: string; value: Outcome<Value>; manifest: unknown; gather_tick: string }>(
    `SELECT d.id,d.value,d.manifest,d.gather_tick::text
       FROM slot_state s JOIN derivations d USING (learner_id,slot_type,slot_key)
      WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND d.deriver=$4
        AND d.effective_tick>=d.gather_tick AND NOT d.is_shadow AND d.invalidated_tick IS NULL
        AND (($5::text IS NULL AND d.id=s.current_id AND d.lifecycle='effective'
              AND d.freshness='current' AND d.selection_ended_tick IS NULL)
          OR ($5 IS NOT NULL AND d.id=$5 AND d.lifecycle IN ('effective','superseded')))`,
    [slot.learner, slot.type, slot.key, deriver, pinnedId ?? null],
  );
  if (!row || row.value?.kind !== 'value') throw new RequestError(409, conflict);
  const manifest = parseManifest(row.manifest);
  if (manifest.gatherTick !== row.gather_tick) throw new RequestError(409, conflict);
  for (const requested of new Set([manifest.purpose, use])) {
    const verdict = await revalidateManifest(tx, manifest, requested);
    if (verdict.kind !== 'valid' || (!pinnedId && verdict.freshness !== 'current')) throw new RequestError(409, conflict);
  }
  return { manifest, deriver, snapshot: { id: derivationId(row.id), slot, outcome: row.value } };
}

function bindRead(tx: ReadTransaction, base: ReadContext, use: string) {
  const readExtraction: PaperExtractionReader = async ({ learner, source, extraction }, mode) => {
    if (learner !== tx.learner) throw new RequestError(409, conflict);
    const row = await openSlot<LayeredExtractionValue>(tx, { learner, type: layeredExtractionSlot, key: source.id },
      layeredExtractionDeriver, use, mode === 'pinned' ? extraction.derivationId : undefined);
    if (row.snapshot.id !== extraction.derivationId) throw new RequestError(409, conflict);
    return row;
  };
  const readQuestionSlot: ReadContext['slot'] = async <Value = Json>(
    slot: SlotRef, options: Parameters<ReadContext['slot']>[1],
  ) => {
    if (slot.learner !== tx.learner || slot.type !== questionVerificationType || options.mode !== 'following')
      throw new RequestError(409, conflict);
    const { manifest, snapshot } = await openSlot<QuestionVerification>(tx, slot, 'content/question-verification', use);
    const basis = snapshot.outcome.value?.basis;
    if (!basis || questionVerificationKey(basis) !== slot.key || !manifest.inputs.some(input =>
      input.kind === 'fact' && input.mode === 'following' && input.id === basis.id &&
      input.rev === basis.rev && input.accessEpoch === basis.accessEpoch)) throw new RequestError(409, conflict);
    return snapshot as DerivationSnapshot<Value>;
  };
  return bindPaperCommandRead(base, { readExtraction, readQuestionSlot });
}

async function readIssuedPaper(read: ReadContext, id: FactId, fact: FactSnapshot) {
  if (fact.type !== paperIssuanceType) throw new RequestError(404, '找不到已发行纸卷。');
  const issue = paperIssuance(fact.value);
  if (await paperIssuanceId(issue) !== id) throw new RequestError(409, conflict);
  return projectIssuedPaper(read, issue);
}

function input<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new RequestError(400, '纸面请求格式无效。'); }
}

async function paperRequest<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError)
      throw new RequestError(404, '找不到当前可读取的纸面依据。');
    if (error instanceof Error && error.constructor === Error) throw new RequestError(409, conflict);
    throw error;
  }
}

export function openCapturePapers(db: Db, capture: LoadedModule, hooks: CommandHooks) {
  async function write<T>(run: (read: ReadContext,
    command: (type: string, data: Json) => Promise<void>) => Promise<T>) {
    return paperRequest(() => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      const read = bindRead(tx, createCommandReadContext(tx, purpose), purpose);
      const handle = createCommandHandler({ ...db, query: tx.query, tx: async (inner, execute) => {
        if (inner.learner !== tx.learner) throw new RequestError(409, conflict);
        return execute(tx);
      } }, { modules: [capture], hooks, bindCommandRead: (inner, request, base) => bindRead(inner, base, request.purpose) });
      return run(read, async (type, data) => {
        const receipt = await handle({ learner: tx.learner, actor: 'learner', purpose, type,
          id: commandId(stableId(type, canonicalJsonString(data))), input: data });
        if (receipt.state !== 'done') throw new RequestError(409, conflict);
      });
    }));
  }

  return {
    async issue(body: Record<string, unknown>) {
      const issue = input(() => paperIssuance(body));
      const id = await paperIssuanceId(issue);
      return write(async (read, command) => {
        let existing: FactSnapshot | undefined;
        try { existing = await read.fact(id, { mode: 'following' }); }
        catch (error) { if (!(error instanceof FactNotFoundError)) throw error; }
        if (existing) return readIssuedPaper(read, id, existing);
        const current = await read.fact(issue.source.id, { mode: 'following' });
        if (current.ref.rev !== issue.source.rev || current.accessEpoch !== issue.epoch) throw new RequestError(409, conflict);
        await command('capture.issuePaper', issue);
        return readIssuedPaper(read, id, await read.fact(id, { mode: 'following' }));
      });
    },
    async collect(body: Record<string, unknown>) {
      const { page, original, ...target } = input(() => collectPaperInput(body));
      if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 ||
          typeof original !== 'number' || !Number.isSafeInteger(original) || original < 0)
        throw new RequestError(400, '回收页码或原图索引无效。');
      const data = { ...target, page, original };
      const runId = data.retryId ?? await defaultPaperRunId(data.issuanceId);
      return write(async (read, command) => {
        await command('capture.collectPaper', data);
        // The kernel can return a saved receipt without rerunning its read phase.
        if ((await collectPaperWrites(read, data)).length) throw new RequestError(409, conflict);
        const run = await read.fact(runId, { mode: 'following' });
        if (run.type !== paperRunType || paperRun(run.value).issuanceId !== data.issuanceId) throw new RequestError(409, conflict);
        return { issuanceId: data.issuanceId, runId, rev: run.ref.rev, page, independence: 'unknown' as const };
      });
    },
    async reprint(body: Record<string, unknown>) {
      const id = input(() => {
        if (Object.keys(body).length !== 1 || typeof body.issuanceId !== 'string') throw new Error();
        return factId(body.issuanceId);
      });
      return paperRequest(() => db.snapshot(scope, async tx => {
        const read = bindRead(tx, createCommandReadContext(tx, purpose), purpose);
        return readIssuedPaper(read, id, await read.fact(id, { mode: 'following' }));
      }));
    },
  };
}
