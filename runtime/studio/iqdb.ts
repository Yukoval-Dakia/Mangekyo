import { commandId, createCommandReadContext, factId, isFactNotFound, isFactReadDenied, listCompletedEffects,
  type CommandHooks, type Db, type DbTransaction, type EvidenceEventV1, type FactId, type ReadTransaction,
  type Json, type Revision } from '../../kernel/src/index.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { AuthoringError } from '../../executors/teaching/background-llm.ts';
import type { PythonDeriverHost } from '../../executors/python-deriver/host.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { authorQuestionsWithModel, type PythonCheckVerifier } from '../../executors/teaching/question-author.ts';
import { bankProposalView, inspectTeachingBankQuestion, parsePaper, parseProposal, questionSourceMaterialIds,
  recordedReferences, selectBankQuestions, storedIqdbQuestionView, type QuestionRef } from '../../modules/activity/iqdb-selection.ts';
import { readConceptAttemptEvidence, type ConceptEvidenceRow } from '../../modules/activity/concept-evidence.ts';
import { setWorkspaceTeachingCommand } from '../../modules/activity/workspace-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { applyAssetQuestionSolutions, assetType, parseAsset, questionPrompt, questionSolutionFields } from '../../modules/content/asset.ts';
import { materialType } from '../../modules/content/intake-question-bank.ts';
import { knowledgeEdgeType, parseKnowledgeEdge } from '../../modules/content/knowledge-edge.ts';
import { buildAuthoredQuestionCommands, QuestionAuthoringError } from '../../modules/content/question-authoring.ts';
import { classifySetQuestionTeachingError, parseQuestionMetaDraft, parseSetQuestionTeachingInput,
  questionMetaDraftId } from '../../modules/content/question-state.ts';
import { buildSelectionEvidenceSlice, buildUnifiedExposureLocks, finalizeQuestionSelection, recallSelectionCandidates,
  type QuestionSelectionPlan, type SelectionQuestionMeta } from '../../modules/learner/question-selection.ts';
import { findUnexposedVariantInPool, type VariantPoolEdge } from '../../modules/content/variant-pool.ts';
import { buildConceptAuthoringContext } from '../../modules/learner/authoring-context.ts';
import { parseRequest, purpose, stableId, storageRead, studioHost } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { enqueueQuestionVerification, readCurrentQuestionVerification } from './iqdb-verification.ts';
import { authoringWitnesses, loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { clientRequest, RequestError } from './sessions.ts';
import {
  confirmedEndpointCall, endpointEffectIdentity, type EndpointFailure, finishEndpointResult, rethrowEndpointError,
  resolveAuthorizedProvider, runEndpointEffect,
} from './endpoint-kit.ts';
export type IssueBank = (tx: DbTransaction, input: { requestId: string; questionRefs: readonly QuestionRef[]; deletionWatermark: string }) => Promise<{ id: FactId }>;
export type IqdbAuthoringDeps = { savePaper?: (input: Record<string, unknown>) => Promise<{ id: string }>;
  loadProvider?: () => Promise<ProviderSettings>; authorQuestions?: typeof authorQuestionsWithModel;
  pythonVerifier?: PythonCheckVerifier; pythonHost?: PythonDeriverHost };
const proposalLabel = 'iqdb-proposal';
const nonBasisSources = new Set([
  'activity.workbookAttempt', 'activity.workbookPaper', 'activity.retentionPosttestSubmission', 'activity.recallSubmission',
]);
const validated = <Result>(parse: () => Result) => parseRequest(parse, '题库请求无效。');
const inspectQuestion = (tx: ReadTransaction, id: FactId, pinned?: QuestionRef['rev']) =>
  inspectTeachingBankQuestion({ ...createCommandReadContext(tx, purpose), slot: readCurrentQuestionVerification(tx) },
    storageRead(tx), id, pinned).catch(e => { if (isFactNotFound(e) || isFactReadDenied(e)) return undefined; throw e; });
/** Map vetted controlled-attempt evidence to canonical events; unwitnessed independence becomes an omission. */
export function selectionEvidenceRows(attempts: readonly ConceptEvidenceRow[]) {
  const groups = new Map<string, ConceptEvidenceRow[]>();
  for (const row of attempts) {
    const key = `${row.submission.id}:${row.questionId}`, held = groups.get(key);
    if (held) held.push(row); else groups.set(key, [row]);
  }
  const events: EvidenceEventV1[] = [];
  const omissions = new Map<string, { readonly ref: { readonly id: string; readonly rev: number }; readonly reason: string }>();
  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (first.helpLevel === 'unknown') {
      omissions.set(`${first.submission.id}:${first.submission.rev}`,
        { ref: { id: first.submission.id, rev: first.submission.rev }, reason: 'unwitnessed-independence' });
      continue;
    }
    events.push({ ref: first.questionId, rev: first.submission.rev, occurred_at: first.occurredAt,
      concept_ids: [...new Set(rows.map(row => row.conceptId))].sort(), item_novelty: 'same',
      help_level: first.helpLevel, outcome: first.outcome, claim_ids: [] });
  }
  events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.ref.localeCompare(right.ref));
  return { events, omissions: [...omissions.values()] };
}
function conceptLinksFromSnap(snap: { factsById: ReadonlyMap<string, { id: string; rev: number; type: string; data: unknown }> }) {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const links = [];
  for (const fact of snap.factsById.values()) {
    if (fact.type !== 'content.knowledgeEdge') continue;
    const data = record(fact.data);
    if (data.kind !== 'targets_concept') continue;
    const fromUse = record(record(data.from).sourceUse), toUse = record(record(data.to).sourceUse);
    const questionId = String(fromUse.id ?? ''), questionRev = Number(fromUse.rev), conceptId = String(toUse.id ?? '');
    if (!ulid.test(questionId) || !ulid.test(conceptId) || !Number.isSafeInteger(questionRev) || questionRev < 1) continue;
    links.push({ questionId: factId(questionId), questionRev: questionRev as Revision, conceptId: factId(conceptId),
      edgeRef: { id: factId(fact.id), rev: fact.rev as Revision, type: 'content.knowledgeEdge' } });
  }
  return links;
}
export async function loadExposedQuestionIds(tx: ReadTransaction): Promise<ReadonlySet<string>> {
  const item = `COALESCE(e.help->'mount'->'item'->>'itemId',e.help->'target'->'item'->>'itemId',e.help->'answer'->'target'->'item'->>'itemId')`;
  const act = `COALESCE(e.help->'mount'->>'activityId',e.help->'target'->>'activityId',e.help->'answer'->'target'->>'activityId')`;
  const revJoin = 'FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev) '
    + 'WHERE f.learner_id=$1 AND f.retracted_rev IS NULL';
  const paperQuestions = `SELECT q->'sourceQuestionRef'->>'id' AS id FROM facts f
     JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev),
     jsonb_array_elements(COALESCE(r.data->'questions','[]'::jsonb)) q
     WHERE f.learner_id=$1 AND f.type='activity.workbookPaper' AND f.retracted_rev IS NULL`;
  const presentationQuestions = `SELECT q->'sourceQuestionRef'->>'id' AS id FROM facts f
     JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     JOIN facts paper ON paper.learner_id=f.learner_id AND paper.id=r.data->'paper'->>'id' AND paper.retracted_rev IS NULL
     JOIN fact_revs pr ON (pr.learner_id,pr.fact_id,pr.rev)=(paper.learner_id,paper.id,(r.data->'paper'->>'rev')::int),
     jsonb_array_elements(COALESCE(pr.data->'questions','[]'::jsonb)) q
     WHERE f.learner_id=$1 AND f.type='activity.workbookPresentation' AND f.retracted_rev IS NULL
       AND r.data->>'kind'='question'`;
  const { rows } = await tx.query<{ id: string }>(
    `WITH e AS (SELECT COALESCE(r.data->'paper'->'questions','[]'::jsonb) qs, NULL::jsonb help ${revJoin}
       AND f.type IN ('activity.workbookAttempt','activity.retentionPosttestSubmission')
       UNION ALL SELECT '[]'::jsonb, r.data ${revJoin} AND f.type IN ('activity.helpExposure','activity.recallSubmission'))
     SELECT DISTINCT id FROM (SELECT q->'sourceQuestionRef'->>'id' id FROM e, jsonb_array_elements(qs) q
       UNION ALL SELECT help->>'itemId' FROM e WHERE help ? 'itemId'
       UNION ALL SELECT help->'content'->>'id' FROM e WHERE help ? 'content' UNION ALL SELECT ${item} FROM e
       UNION ALL SELECT q->'sourceQuestionRef'->>'id' FROM e JOIN facts p ON p.learner_id=$1 AND p.retracted_rev IS NULL
         AND p.type='activity.workbookPaper' AND p.id=${act} JOIN fact_revs pr ON (pr.learner_id,pr.fact_id,pr.rev)=(p.learner_id,p.id,p.current_rev),
         jsonb_array_elements(COALESCE(pr.data->'questions','[]'::jsonb)) q WHERE q->>'id'=${item}
       UNION ALL ${paperQuestions} UNION ALL ${presentationQuestions}) s WHERE id IS NOT NULL`, [tx.learner]);
  return new Set(rows.map(r => r.id));
}
async function listQuestions(tx: ReadTransaction, { teachingOnly = false }: { teachingOnly?: boolean } = {}) {
  const { rows } = await tx.query<{ id: FactId; purpose: readonly string[] }>(
    `SELECT f.id, f.purpose FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='question'
       AND f.purpose && ARRAY['storage',$3,'all']::text[] ORDER BY f.id`, [tx.learner, assetType, purpose]);
  const questions = [];
  for (const { id, purpose: purposes } of rows) {
    const strict = (purposes.includes('teaching') || purposes.includes('all')) ? await inspectQuestion(tx, id) : undefined;
    const opened = strict ? { view: strict, teachingAuthorized: true } : await storedIqdbQuestionView(tx, { id, purposes, teachingOnly, teachingPurpose: purpose });
    if (opened) questions.push({ ...opened.view.public, teachingAuthorized: opened.teachingAuthorized });
  }
  return questions;
}
export function openIqdb(db: Db, verificationConfigured: boolean, issueBank: IssueBank,
  content?: LoadedModule, hooks?: CommandHooks, activity?: LoadedModule, capture?: LoadedModule, authoring?: IqdbAuthoringDeps) {
  const host = studioHost(db), modules = [content, activity, capture].filter((m): m is LoadedModule => Boolean(m));
  const exec = modules.length && hooks ? host.boundHandler(modules, hooks, undefined,
    activity ? { crossModuleWrites: { [setWorkspaceTeachingCommand]: { set_purpose: [materialType, intakeFactType] } } } : undefined) : undefined;
  return {
    questions: () => host.snapshot(async tx => ({ questions: await listQuestions(tx) })),
    async proposals({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parseProposal(raw)), proposalId = stableId(proposalLabel, input.requestId);
      let selectionPlan: ReturnType<typeof finalizeQuestionSelection> | undefined;
      let selectedRefs = input.questionRefs;
      if (!input.questionRefs.length) {
        const prepared = await host.snapshot(async tx => {
          await assertDeletionWatermark(tx, watermark);
          const { snap } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose });
          const questions = await listQuestions(tx, { teachingOnly: true });
          const metas = new Map<string, SelectionQuestionMeta>();
          const read = createCommandReadContext(tx, purpose);
          for (const question of questions) {
            const metadata = await read.fact(
              await questionMetaDraftId({ learner: tx.learner, id: question.id, rev: question.rev }), { mode: 'following' })
              .catch(error => isFactNotFound(error) || isFactReadDenied(error) ? undefined : Promise.reject(error));
            if (metadata) {
              const draft = parseQuestionMetaDraft(metadata.value);
              if (draft.id === question.id && draft.expectedRev === question.rev) metas.set(question.id, draft.append_metadata ?? {});
            }
          }
          const candidates = recallSelectionCandidates(input, { snap, questions, questionMetas: metas });
          const exposureLocks = buildUnifiedExposureLocks({ snap, exposedQuestionIds: await loadExposedQuestionIds(tx) });
          const attemptRows = await readConceptAttemptEvidence(tx, storageRead(tx), conceptLinksFromSnap(snap), isFactNotFound);
          const evidenceRows = selectionEvidenceRows(attemptRows.attempts);
          const slice = buildSelectionEvidenceSlice({ clockWatermark: watermark, asOfAt: new Date().toISOString(), exposureLocks,
            events: evidenceRows.events, omissions: evidenceRows.omissions, candidates, snap, budgetMin: input.durationMinutes });
          return { snap, candidates, exposureLocks, slice: slice.slice, keywordRefs: selectBankQuestions(input, questions), questions };
        });
        const hasReceipt = await host.snapshot(tx => listCompletedEffects(tx, { ownerKind: 'session', ownerId: proposalId, label: proposalLabel }))
          .then(({ rows }) => rows.length > 0);
        let infoGain: Parameters<typeof finalizeQuestionSelection>[0]['infoGain'] = { kind: 'unavailable', reason: '未配置推导器。' };
        if (!hasReceipt && authoring?.pythonHost) {
          const derived = await authoring.pythonHost.derive('plan/information-gain@1', prepared.slice);
          infoGain = derived.kind === 'failed' ? { kind: 'unavailable', reason: derived.reason }
            : derived.outcome.kind === 'unknown' ? { kind: 'unavailable', reason: derived.outcome.reason }
            : derived.outcome.value as Parameters<typeof finalizeQuestionSelection>[0]['infoGain'];
        }
        const livePlan = finalizeQuestionSelection({ request: input, candidates: prepared.candidates,
          exposureLocks: prepared.exposureLocks, infoGain, snap: prepared.snap });
        const mapped = new Set(prepared.candidates.filter(candidate => candidate.conceptIds.length).map(candidate => candidate.id)),
          exposed = new Set(prepared.exposureLocks.lockIds), engineIds = new Set(livePlan.selected.map(item => item.id));
        const keywordSupplement = prepared.keywordRefs
          .filter(ref => !exposed.has(ref.id) && !mapped.has(ref.id) && !engineIds.has(ref.id)).slice(0, 5);
        selectionPlan = livePlan;
        selectedRefs = [...livePlan.selected.map(selected => ({ id: factId(selected.id), rev: selected.rev as QuestionRef['rev'] })),
          ...keywordSupplement].slice(0, 20);
      }
      const saved = await recordLocalRead(db, { ...host.scope, ownerKind: 'session', ownerId: proposalId, stepKey: 'plan', label: proposalLabel, input },
        async _tx => JSON.stringify({ ...input, questionRefs: selectedRefs, ...(selectionPlan ? { selectionPlan } : {}) }),
        tx => assertDeletionWatermark(tx, watermark))
        .catch(e => Promise.reject(e instanceof Error && e.message === 'Workspace read receipt does not match the request'
          ? new RequestError(409, '这个请求标识已经用于另一份提案。') : e));
      const persisted = JSON.parse(saved) as { selectionPlan?: QuestionSelectionPlan };
      return host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        const requested = recordedReferences(saved), selected: NonNullable<Awaited<ReturnType<typeof inspectQuestion>>>[] = [];
        for (const ref of requested) {
          const opened = await inspectQuestion(tx, ref.id, ref.rev);
          if (!opened) continue;
          if (verificationConfigured && opened.public.status === 'needs_verification' && !opened.reviewed) await enqueueQuestionVerification(tx, opened.version);
          selected.push(opened);
        }
        const view = bankProposalView(input, proposalId, requested, selected);
        const plan = persisted.selectionPlan;
        return plan ? { ...view, selectionPlan: plan, estimatedMinutes: plan.estimatedMinutes, selected: plan.selected,
          eliminated: plan.eliminated, coverageReport: plan.coverageReport, deriverStatus: plan.deriverStatus,
          exposureLockCount: plan.exposureLockCount } : view;
      });
    },
    async papers({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parsePaper(raw));
      return host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        const refs = input.sourceRef ? [input.sourceRef]
          : await listCompletedEffects(tx, { ownerKind: 'session', ownerId: input.proposalId!, label: proposalLabel })
            .then(({ rows: [saved] }) => {
              if (!saved) throw new RequestError(404, '找不到这份题库提案。');
              return recordedReferences(saved.result as string);
            });
        if (!refs.length) throw new RequestError(409, '请重新选择当前获准且已独立验收的固定题版。');
        return issueBank(tx, { requestId: input.requestId, questionRefs: refs, deletionWatermark: watermark });
      });
    },
    async setTeaching(id: string, raw: Record<string, unknown>) {
      if (!exec) throw new RequestError(503, '当前服务不支持题库教学授权。');
      const { questionId, requestId, expectedRev, allowed, includeSourceMaterial } = validated(() => parseSetQuestionTeachingInput(id, raw));
      try {
        const sources = await host.snapshot(async tx => {
          const read = host.read(tx, 'storage'), question = await read.fact(questionId, { mode: 'following' });
          if (question.type !== assetType || question.ref.rev !== expectedRev) throw new RequestError(409, '题目基版已变化，请刷新后再试。');
          const metadata = await read.fact(await questionMetaDraftId(question.ref), { mode: 'following' });
          return Promise.all([...questionSourceMaterialIds(question, metadata)].map(async materialId => {
            const material = await read.fact(materialId, { mode: 'following' });
            const intakeId = await host.readOrNull(tx, 'storage', intakeIdFor(materialId), { mode: 'following' }).then(f => f?.ref.id);
            return { id: materialId, rev: material.ref.rev, ...(intakeId && { intakeId }),
              teaching: material.purpose.includes('teaching') || material.purpose.includes('all') };
          }));
        });
        const pending = allowed && includeSourceMaterial ? sources.filter(s => !s.teaching) : [];
        if (pending.length && (!activity || !capture)) throw new RequestError(409, '题目来源未授权教学用途，请先开放对应来源材料的教学权限。');
        if (pending.length) await host.snapshot(async tx => {
          for (const s of pending) {
            const current = await host.read(tx, 'storage').fact(s.id, { mode: 'following' });
            if (current.ref.rev !== s.rev) throw new RequestError(409, '题目来源版本已变化，请刷新后再试。');
          }
        });
        for (const s of pending) await exec({ purpose: 'storage', type: setWorkspaceTeachingCommand,
          id: commandId(stableId('iqdb-question-source-teaching', questionId, s.id, requestId)),
          input: { id: s.id, expectedRev: s.rev, enabled: true, ...(s.intakeId && { intakeId: s.intakeId }) } });
        const receipt = await exec({ purpose: 'storage', type: 'content.setQuestionTeaching',
          id: commandId(stableId('iqdb-question-teaching', questionId, requestId)), input: { id: questionId, expectedRev, allowed } });
        const sourceMaterialAuthorized = await host.snapshot(async tx => {
          for (const s of sources) {
            const material = await host.read(tx, 'storage').fact(s.id, { mode: 'following' });
            if (!material.purpose.includes('teaching') && !material.purpose.includes('all')) return false;
          }
          return true;
        });
        return { id: questionId, rev: receipt.wrote.find(w => w.id === questionId)?.rev ?? expectedRev,
          teachingAuthorized: allowed, changed: receipt.wrote.length > 0, sourceMaterialAuthorized };
      } catch (error) {
        const mapped = classifySetQuestionTeachingError(error, { notFound: isFactNotFound(error),
          deniedReason: isFactReadDenied(error) ? error.reason : undefined });
        if (mapped) throw new RequestError(mapped.status, mapped.message);
        throw error;
      }
    },
    async author(raw: Record<string, unknown>, signal?: AbortSignal) {
      if (!exec) throw new RequestError(503, '当前服务不支持题库自主命题。');
      const requestId = clientRequest(raw.requestId), mode = raw.mode;
      if (mode !== 'concept_gap' && mode !== 'mistake_variant') throw new RequestError(400, '出题模式无效。');
      const optId = (v: unknown, msg: string) => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') throw new RequestError(400, msg);
        try { return factId(v); } catch { throw new RequestError(400, msg); }
      };
      const conceptId = optId(raw.conceptId, '知识点标识无效。'), sourceQuestionId = optId(raw.sourceQuestionId, '原题标识无效。');
      const attemptId = optId(raw.attemptId, '作答标识无效。'), count = raw.count;
      if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 3))
        throw new RequestError(400, '出题数量须为 1 到 3。');
      const issuePaper = raw.issuePaper === true, forceGenerate = raw.forceGenerate === true;
      const format = raw.format;
      const badFormat = format !== 'text' && format !== 'interactive' && format !== 'auto';
      if (format !== undefined && badFormat) throw new RequestError(400, '题型格式无效。');
      type QAsset = Extract<ReturnType<typeof parseAsset>, { kind: 'question' }>;
      const issueAuthorPaper = async (title: string, items: { id: FactId; rev: number; asset: QAsset }[]) => {
        if (!issuePaper || !authoring?.savePaper || !items.length) return {};
        const sol = new Map(items.map(i => [i.id, questionSolutionFields(i.asset)]));
        const draft = applyAssetQuestionSolutions({ title: title.slice(0, 120) || '针对性巩固练习', questions: items.map(i => ({
          kind: 'rubric', prompt: questionPrompt(i.asset), rubric: '请独立完成并核对解析。', sourceQuestionRef: { id: i.id, rev: i.rev },
        })) }, sol);
        const paper = await authoring.savePaper({ requestId: stableId('iqdb-author-paper', requestId), materialId: null, ...draft });
        return { paperId: paper.id, paperHref: `/papers/${encodeURIComponent(paper.id)}` };
      };
      const resolution = (await resolveAuthorizedProvider({ loadProvider: authoring?.loadProvider }))!;
      const prepared = await host.snapshot(async tx => {
        const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose, maySend: resolution.maySend });
        const context = buildConceptAuthoringContext({ mode, ...(conceptId ? { conceptId } : {}),
          ...(sourceQuestionId ? { sourceQuestionId } : {}), ...(attemptId ? { attemptId } : {}) }, snap);
        if (mode === 'mistake_variant' && !forceGenerate && context.sourceQuestion?.id) {
          const edges: VariantPoolEdge[] = [];
          for (const s of snapshots.values()) if (s.type === knowledgeEdgeType)
            try { edges.push({ id: s.ref.id, edge: parseKnowledgeEdge(s.value) }); } catch {}
          const exposed = await loadExposedQuestionIds(tx);
          const sourceQ = factId(context.sourceQuestion.id);
          const poolQuestion = async (id: string) => {
            const snap = snapshots.get(id);
            if (snap?.type !== assetType) return false;
            const inspection = await inspectQuestion(tx, id as FactId);
            if (!inspection || inspection.public.status !== 'release_ready') return false;
            try { const asset = parseAsset(snap.value);
              return asset.kind === 'question' && Boolean(questionPrompt(asset).trim()); } catch { return false; }
          };
          const hit = await findUnexposedVariantInPool({ sourceQuestionId: sourceQ, edges, isExposed: id => exposed.has(id) || !poolQuestion(id) });
          const cand = hit ? snapshots.get(hit.questionId) : undefined;
          const asset = cand?.type === assetType ? parseAsset(cand.value) : undefined;
          const interactive = asset?.kind === 'question' && asset.blocks.some(block => block.body.kind === 'interaction');
          const formatHit = format === 'text' ? !interactive : format !== 'interactive' || interactive;
          if (cand && asset?.kind === 'question' && questionPrompt(asset).trim() && formatHit)
            return { kind: 'pool' as const, id: cand.ref.id, rev: cand.ref.rev, asset, topic: context.topic, interactive };
        }
        if (!context.hasSufficientBasis) throw new RequestError(404, '当前还没有足够的学习资料或原题记录作为出题依据。', 'no_sufficient_basis');
        const witnesses = authoringWitnesses(snapshots, [...context.witnessFactIds, ...(context.concept ? [context.concept.id] : []),
          ...(context.sourceQuestion ? [context.sourceQuestion.id] : []), ...context.sourceSnippets.map(s => s.id),
          ...context.mistakes.map(m => m.attemptId)]);
        return { kind: 'ai' as const, context, witnesses, snapshots };
      });
      if (prepared.kind === 'pool') {
        const prompt = questionPrompt(prepared.asset), paper = await issueAuthorPaper(`${prepared.topic || '错题'}同族变式巩固`, [prepared]);
        const href = `/materials/records/${encodeURIComponent(prepared.id)}`;
        return { source: 'variant_pool' as const,
          questions: [{ id: prepared.id, prompt, href, format: prepared.interactive ? 'interactive' : 'text' }], ...paper };
      }
      const effectInput = { mode, ...(conceptId ? { conceptId } : {}), ...(sourceQuestionId ? { sourceQuestionId } : {}),
        ...(attemptId ? { attemptId } : {}), ...(count ? { count } : {}), ...(format ? { format } : {}), ...(issuePaper ? { issuePaper } : {}),
        provider: resolution.provider.model };
      const result = await runEndpointEffect(db, endpointEffectIdentity('iqdb-author', requestId, effectInput as Json),
        async (providerEffectId, checkDispatch) => {
          const failure: { current?: EndpointFailure } = {};
          const authorFn = authoring?.authorQuestions ?? authorQuestionsWithModel;
          const authored = await confirmedEndpointCall(db, checkDispatch, prepared.snapshots.values(), resolution.maySend,
            () => authorFn(prepared.context, {
              mode, ...(count !== undefined ? { count } : {}), ...(format === undefined ? {} : { format }),
              provider: resolution.provider, requestId: providerEffectId, verify: true,
              ...(signal ? { signal } : {}), ...(authoring?.pythonVerifier ? { pythonVerifier: authoring.pythonVerifier } : {}),
            }), failure);
          if (!authored) {
            if (failure.current) return { failed: failure.current } as unknown as Json;
            throw new Error('出题模型未给出确定回执。');
          }
          const drafts = authored.questions.map(q => ({ ...q, sourceIds: q.sourceIds.filter(id => {
            const t = prepared.snapshots.get(id)?.type; return Boolean(t && !nonBasisSources.has(t));
          }) }));
          const conceptIds = [...new Set([
            ...(prepared.context.concept ? [prepared.context.concept.id] : []), ...(prepared.context.sourceQuestion?.conceptIds ?? []),
          ])];
          const mistakeWitnessId = prepared.context.sourceQuestion?.attemptId ?? prepared.context.mistakes[0]?.attemptId;
          const built = await buildAuthoredQuestionCommands({ requestId, mode, drafts, witnesses: prepared.witnesses, conceptIds,
            ...(prepared.context.sourceQuestion ? { sourceQuestionId: prepared.context.sourceQuestion.id } : {}),
            ...(mistakeWitnessId ? { mistakeWitnessId } : {}), existingQuestionPrompts: prepared.context.existingQuestionPrompts, purpose })
            .catch(rethrowEndpointError);
          const verifiedIds = new Set(built.questions
            .filter((q, i) => {
              const draft = authored.questions.find(d => d.prompt.trim() === q.prompt) ?? authored.questions[i];
              return draft?.verification?.status === 'verified';
            })
            .map(q => q.id));
          const savedAssets: { id: FactId; rev: number; asset: QAsset }[] = [];
          for (const cmd of built.commands) {
            const receipt = await exec({ actor: 'companion', purpose, type: cmd.type,
              id: commandId(stableId('iqdb-author', requestId, cmd.key)), input: cmd.input });
            if (cmd.type === 'content.saveQuestion' && verifiedIds.has(factId(String(cmd.input.id)))) {
              const qId = factId(String(cmd.input.id)), rev = receipt.wrote.find(w => w.id === qId)?.rev ?? 1;
              savedAssets.push({ id: qId, rev, asset: parseAsset(cmd.input.asset) as QAsset });
            }
          }
          const paper = await issueAuthorPaper(prepared.context.topic ? `${prepared.context.topic}巩固练习` : '针对性巩固练习', savedAssets);
          return { source: 'ai_authored' as const, questions: built.questions.map((q, i) => {
            const matched = authored.questions.find(d => d.prompt.trim() === q.prompt) ?? authored.questions[i];
            const verification = matched?.verification;
            return { ...q, href: `/materials/records/${encodeURIComponent(q.id)}`, ...(matched?.format ? { format: matched.format } : {}),
              ...(verification ? { verification } : {}) };
          }), ...paper } as unknown as Json;
        });
      return finishEndpointResult<Record<string, unknown>>(result);
    },
  };
}
