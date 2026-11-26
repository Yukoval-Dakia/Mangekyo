import { randomUUID } from 'node:crypto';
import { commandId, createAuthorizedFactReader, factId, isFactNotFound, readLatestCompletedEffect, stableId,
  type Db, type FactSnapshot, type Json, type ReadTransaction } from '../../kernel/src/index.ts';
import { recordCompletedEffect } from '../../kernel/src/work/index.ts';
import { EffectBudgetExceeded, EffectIdentityMismatch, runEffect, type EffectBudget } from '../../kernel/src/work/effects.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { extractMaintenanceInputFromFlow, buildMaintenanceContext, planMaintenanceActions, type MaintenanceConceptUse } from '../../modules/companion/maintenance-policy.ts';
import { buildAuthoredQuestionCommands } from '../../modules/content/question-authoring.ts';
import { buildQuestionMetaGardeningProposal, selectQuestionsForMetaGardening,
  type QuestionGardeningCandidate } from '../../modules/content/question-meta-gardening.ts';
import { parseAsset, questionPrompt, questionSolutionFields } from '../../modules/content/asset.ts';
import { parseQuestionMetaDraft, questionMetaDraftId, questionVerificationKey, questionVerificationType,
  readQuestionState } from '../../modules/content/question-state.ts';
import { readCurrentQuestionVerification } from './iqdb-verification.ts';
import { buildCompanionTextbookRevisionProposal } from '../../modules/content/textbook-authoring.ts';
import { textbookPageFrom, textbookPageType } from '../../modules/content/textbook-page.ts';
import { proposeKnowledgeMaintenanceWithAgent, isLocalZeroCostProvider } from '../../executors/teaching/background-llm.ts';
import { gardenQuestionMetadataWithModel } from '../../executors/teaching/question-meta-gardener.ts';
import { verifyAuthoredQuestionDraft } from '../../executors/teaching/question-verifier.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { MAX_MAINTENANCE_BUDGET_RATIO } from '../../modules/companion/living-mine-radar.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import { turnAllowsBackgroundUnderstanding } from '../../modules/activity/values.ts';
import { independentlyAuthoredPaper, workbookAttemptType, workbookPaper, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { studioHost } from './identity.ts';
import { authoringWitnesses, loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { confirmedEndpointCall, type EndpointFailure, resolveAuthorizedProvider } from './endpoint-kit.ts';
import { currentResearchSettings, independentScoutSource } from './research-sources.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';
type Deps = {
  content: LoadedModule; activity: LoadedModule; carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> };
  loadProvider?: () => Promise<ProviderSettings>; agent?: typeof proposeKnowledgeMaintenanceWithAgent;
  verifyQuestion?: typeof verifyAuthoredQuestionDraft;
  gardenMeta?: typeof gardenQuestionMetadataWithModel;
  retentionDays?: number;
  now?: () => Date; afterFactsChanged?: (() => Promise<void>) | undefined;
};
const LABEL = 'knowledge-maintenance-v1';
const CALL_LABEL = 'knowledge-maintenance-call-v1';
const skip = (reason: string) => ({
  ran: false as const, reason, proposedEdges: 0, prepNoteId: null, proposedTextbookUpdates: 0, authoredQuestions: 0,
  gardenedQuestionMeta: 0,
});
/** Non-force maintenance never sees tutored turns or assisted papers: the background gates are fail-closed. */
async function backgroundGate(tx: ReadTransaction, fact: FactSnapshot): Promise<boolean> {
  if (fact.type === 'activity.studyTurn') return turnAllowsBackgroundUnderstanding(fact);
  if (fact.type === workbookAttemptType) return independentScoutSource(tx, fact);
  if (fact.type === workbookPaperType) {
    try { return independentlyAuthoredPaper(workbookPaper(fact.value)); } catch { return false; }
  }
  return true;
}
export function openKnowledgeMaintenance(db: Db, deps: Deps) {
  const host = studioHost(db), now = deps.now ?? (() => new Date());
  const agent = deps.agent ?? proposeKnowledgeMaintenanceWithAgent;
  const verifyQuestion = deps.verifyQuestion ?? verifyAuthoredQuestionDraft;
  const gardenMeta = deps.gardenMeta ?? gardenQuestionMetadataWithModel;
  const handle = host.boundHandler([deps.content, deps.activity],
    createStudioCommandHooks(deps.afterFactsChanged ? { afterFactsChanged: deps.afterFactsChanged } : {}));
  async function run(options: { force?: boolean; now?: () => Date } = {}) {
    const force = options.force === true, nowMs = (options.now ?? now)().getTime(), readPurpose = force ? 'teaching' : researchPurpose,
      currentDate = new Intl.DateTimeFormat('en-CA',
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }).format(new Date(nowMs));
    const resolution = await resolveAuthorizedProvider({ background: !force, loadProvider: deps.loadProvider });
    if (!resolution) {
      if (force) throw new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型。', 'model_unavailable');
      const configured = deps.loadProvider ? false : await loadSettings().then(settings => settings.providers.some(profile =>
        profile.id === settings.activeProviderId && profile.baseUrl.trim())).catch(() => false);
      return skip(configured ? 'provider_not_authorized' : 'model_unavailable');
    }
    const provider = resolution.provider, maySend = resolution.maySend;
    const prepared = await host.snapshot(async tx => {
      if (await deps.carePause.paused(tx, nowMs)) return skip('care_paused');
      const settings = force ? null : await currentResearchSettings(tx);
      if (!force && !settings?.enabled) return skip('research_disabled');
      const budget = settings?.scoutBudget;
      const zeroCost = isLocalZeroCostProvider(provider);
      if (!force && !zeroCost && budget && (deps.retentionDays === undefined || deps.retentionDays > budget.maxRetentionDays))
        return skip('retention_not_authorized');
      // Paid background maintenance is hard-capped at 20% of the scout consent budget.
      const maintenanceLimit = !force && !zeroCost && budget && budget.maxPerCallMicros > 0 && budget.expiresAtMs > nowMs
        ? BigInt(budget.limitMicros) / BigInt(Math.round(1 / MAX_MAINTENANCE_BUDGET_RATIO)) : null;
      const paidBudget = maintenanceLimit !== null && budget && maintenanceLimit >= BigInt(budget.maxPerCallMicros)
        ? { route: budget.route, maxPerCallMicros: budget.maxPerCallMicros, limitMicros: budget.limitMicros,
          maintenanceLimitMicros: Number(maintenanceLimit), settingsRevision: settings!.revision }
        : null;
      const include = force ? undefined : (txInner: ReadTransaction, fact: FactSnapshot) => backgroundGate(txInner, fact);
      const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx,
        { purpose: readPurpose, maySend, ...(include ? { include } : {}) });
      const conceptUses = new Map<string, MaintenanceConceptUse>(), accessEpochs = new Map<string, string>(), teachingIds = new Set<string>();
      for (const [id, s] of snapshots) {
        conceptUses.set(id, { id, rev: s.ref.rev, accessEpoch: s.accessEpoch });
        accessEpochs.set(id, s.accessEpoch);
        if (s.purpose.includes('teaching') || s.purpose.includes('all')) teachingIds.add(id);
      }
      const last = await readLatestCompletedEffect(tx, LABEL), result = last?.result as { ranAtMs?: number } | undefined;
      const context = buildMaintenanceContext(extractMaintenanceInputFromFlow(snap, { currentDate, nowMs,
        lastRunAtMs: result?.ranAtMs ?? null, lastRunTick: last?.endedTick ?? null, accessEpochs }),
        force ? { minIntervalMs: 0, idleCooldownMs: 0, force: true } : {});
      if (!context) return skip('no_maintenance_needed');
      const gardenCandidates: QuestionGardeningCandidate[] = [];
      const teachingRead = createAuthorizedFactReader(tx, readPurpose, maySend);
      const readVerification = readCurrentQuestionVerification(tx);
      for (const question of snapshots.values()) {
        if (question.type !== 'content.asset' || (force ? !teachingIds.has(question.ref.id) : !question.purpose.includes(readPurpose))) continue;
        try {
          const asset = parseAsset(question.value);
          if (asset.kind !== 'question' || !questionPrompt(asset).trim()) continue;
          const { state } = await readQuestionState(teachingRead, question.ref.id);
          if (state.restrictions.length > 0 || state.arithmeticPractice) continue;
          const verificationKey = questionVerificationKey({ id: question.ref.id, rev: question.ref.rev, recheck: state.recheck });
          const verification = await readVerification(
            { learner: tx.learner, type: questionVerificationType, key: verificationKey }, { mode: 'following' })
            .catch(() => undefined);
          const outcome = verification?.outcome as { kind?: string; value?: { status?: string } } | undefined;
          if (outcome?.kind === 'value' && outcome.value?.status === 'needs-review') continue;
          const metadata = await teachingRead.fact(await questionMetaDraftId(question.ref), { mode: 'following' })
            .catch(error => { if (isFactNotFound(error)) return undefined; throw error; });
          const metaDraft = metadata ? parseQuestionMetaDraft(metadata.value) : undefined;
          const durations: number[] = [];
          for (const attempt of snapshots.values()) {
            if (attempt.type !== 'activity.workbookAttempt') continue;
            const data = attempt.value as Record<string, unknown>, paper = data.paper as Record<string, unknown> | undefined;
            const paperQuestions = Array.isArray(paper?.questions) ? paper.questions.filter(item => item && typeof item === 'object')
              .map(item => item as Record<string, unknown>) : [];
            const itemIds = paperQuestions.filter(item => item.sourceQuestionRef &&
              (item.sourceQuestionRef as Record<string, unknown>).id === question.ref.id)
              .map(item => item.id).filter((id): id is string => typeof id === 'string');
            const pacing = data.pacing as Record<string, unknown> | undefined;
            const items = Array.isArray(pacing?.items) ? pacing.items as Record<string, unknown>[] : [];
            for (const item of items) if (itemIds.includes(String(item.questionId)) && typeof item.effectiveDurationMs === 'number')
              durations.push(item.effectiveDurationMs);
            if (!items.length && itemIds.length && typeof data.effectiveDurationMs === 'number')
              durations.push(data.effectiveDurationMs / Math.max(1, paperQuestions.length));
          }
          const solution = questionSolutionFields(asset as Extract<ReturnType<typeof parseAsset>, { kind: 'question' }>);
          gardenCandidates.push({ id: question.ref.id, rev: question.ref.rev, accessEpoch: question.accessEpoch, purpose: question.purpose,
            title: asset.title, prompt: questionPrompt(asset), ...(metaDraft ? { metaDraft, metaRev: metadata!.ref.rev } : {}),
            ...(durations.length ? { attemptDurationsMs: durations } : {}), ...solution });
        } catch { /* 不可读或不可解析的题目安全跳过：看不见 sticky 绝不盲调模型 */ }
      }
      return { ran: true as const, context, conceptUses, paidBudget, teachingIds, snapshots, gardenCandidates };
    });
    if (prepared.ran === false) return prepared;
    const { context, conceptUses, paidBudget, teachingIds, snapshots, gardenCandidates } = prepared;
    const charge = !force && !isLocalZeroCostProvider(provider) ? paidBudget : null;
    if (!force && !isLocalZeroCostProvider(provider) && !charge) return skip('paid_budget_required');
    if (charge && charge.route !== provider.activeProviderId) return skip('budget_route_mismatch');
    const gardenUsage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    const runKey = `${currentDate}:${nowMs}:${randomUUID()}`;
    type PricedOutcome = { outcome: 'ok'; value: Json } | { outcome: 'refunded'; code: string; message: string }
      | { outcome: 'failed'; code: string; message: string };
    /** One priced effect row per external call: the reservation lands atomically in the learner lock before any transport. */
    async function pricedCall(step: string, input: Json,
      invokeModel: (providerEffectId: string) => Promise<Json>, slots = 1): Promise<PricedOutcome | undefined> {
      const identity = { ownerKind: 'session' as const, ownerId: `maintenance:${runKey}`, stepKey: step, label: CALL_LABEL, input };
      const reserve = charge ? charge.maxPerCallMicros * slots : 0;
      const budget: EffectBudget | undefined = charge ? {
        route: charge.route, limitUsdMicros: charge.limitMicros, reserveUsdMicros: reserve,
        actualUsdMicros: result => result && typeof result === 'object' && 'refund' in result ? 0 : reserve,
      } : undefined;
      const authorize = charge ? async (tx: ReadTransaction) => {
        if (await deps.carePause.paused(tx, nowMs)) throw new EffectBudgetExceeded('care_paused');
        const current = await currentResearchSettings(tx);
        if (!current?.enabled || current.revision !== charge.settingsRevision || !current.scoutBudget ||
            current.scoutBudget.route !== provider.activeProviderId ||
            current.scoutBudget.maxRetentionDays < (deps.retentionDays ?? Infinity) ||
            current.scoutBudget.expiresAtMs <= (options.now ?? now)().getTime())
          throw new EffectBudgetExceeded('research_authorization_changed');
        const { rows: [spent] } = await tx.query<{ settled: string; held: string }>(
          `SELECT COALESCE(sum(actual_usd_micros),0)::text AS settled,
             COALESCE(sum(reserved_usd_micros) FILTER (WHERE actual_usd_micros IS NULL),0)::text AS held
           FROM effects WHERE learner_id=$1 AND label IN ($2,$3) AND reserved_usd_micros IS NOT NULL`,
          [tx.learner, CALL_LABEL, LABEL]);
        if (BigInt(spent?.settled ?? 0) + BigInt(spent?.held ?? 0) + BigInt(reserve) > BigInt(charge.maintenanceLimitMicros))
          throw new EffectBudgetExceeded('maintenance_budget_exceeded');
      } : undefined;
      const dispatchAuthorize = charge ? async (tx: ReadTransaction) => {
        if (await deps.carePause.paused(tx, nowMs)) throw new EffectBudgetExceeded('care_paused');
        const current = await currentResearchSettings(tx);
        if (!current?.enabled || current.revision !== charge.settingsRevision || !current.scoutBudget ||
            current.scoutBudget.route !== provider.activeProviderId ||
            current.scoutBudget.maxRetentionDays < (deps.retentionDays ?? Infinity) ||
            current.scoutBudget.expiresAtMs <= (options.now ?? now)().getTime())
          throw new EffectBudgetExceeded('research_authorization_changed');
      } : undefined;
      const effect = await runEffect(db, { learner: host.learner, ...identity }, async (providerEffectId, checkDispatch) => {
        const failure: { current?: EndpointFailure } = {};
        let dispatchBlocked = false;
        const value = await confirmedEndpointCall(db, checkDispatch, snapshots.values(), maySend,
          () => invokeModel(providerEffectId), failure, host.learner, readPurpose, dispatchAuthorize).catch((error: unknown) => {
          if (error instanceof EffectBudgetExceeded) {
            dispatchBlocked = true;
            failure.current = { status: 409, message: error.message, code: error.message };
            return undefined;
          }
          const code = error instanceof RequestError && error.responseCode ? error.responseCode
            : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'model_failed';
          failure.current ??= { status: 502, message: error instanceof Error ? error.message : '后台模型调用失败。', code };
          return undefined;
        });
        if (value !== undefined) return { value } as unknown as Json;
        // 锁内拦截、配置错误、或单槽位不可达未送达时回退预占；多槽位验算/超时/其他失败均按满额结算，绝不白嫖。
        const hit = failure.current ?? { code: 'model_failed', message: '后台模型未给出确定回执。' };
        const refundable = dispatchBlocked || hit.code === 'provider_configuration' ||
          (slots === 1 && (hit.code === 'model_unavailable' || hit.code === 'provider_unavailable'));
        return (refundable ? { refund: hit } : { failure: hit }) as unknown as Json;
      }, authorize, undefined, budget).catch((error: unknown) => {
        if (error instanceof EffectIdentityMismatch) return undefined;
        if (error instanceof EffectBudgetExceeded) return undefined;
        throw error;
      });
      if (!effect || effect.kind !== 'done') return undefined;
      const result = effect.result as { value?: Json; refund?: { code: string; message: string }; failure?: { code: string; message: string } };
      if (result.refund) return { outcome: 'refunded', ...result.refund };
      if (result.failure) return { outcome: 'failed', ...result.failure };
      return { outcome: 'ok', value: result.value as Json };
    }
    const agentEffect = await pricedCall('agent', { trigger: context.trigger, force, currentDate },
      providerEffectId => agent(context, { provider, requestId: providerEffectId }) as Promise<Json>);
    if (!agentEffect) {
      if (charge) return skip('paid_budget_required');
      return skip('effect_outcome_unknown');
    }
    if (agentEffect.outcome !== 'ok') {
      if (!force) return skip(agentEffect.code);
      const unavail = agentEffect.outcome === 'refunded';
      throw new RequestError(unavail ? 503 : 502, agentEffect.message, unavail ? 'model_unavailable' : agentEffect.code);
    }
    const result = agentEffect.value as Awaited<ReturnType<typeof agent>>;
    const plan = planMaintenanceActions(result.proposal, context, { conceptUses, pageUses: conceptUses, purpose: force ? 'teaching' : 'storage' });
    let proposedEdges = 0, prepNoteId: string | null = null, proposedTextbookUpdates = 0, authoredQuestions = 0, gardenedQuestionMeta = 0;
    for (const edge of plan.edgeProposals) {
      const edgePurpose = force || (teachingIds.has(edge.fromId) && teachingIds.has(edge.toId) &&
        edge.payload.edge.sourceUses.every(u => teachingIds.has(u.id))) ? 'teaching' : 'storage';
      try {
        if ((await handle({ actor: 'companion', purpose: readPurpose, type: edge.commandType,
          id: commandId(stableId('knowledge-maintenance', edge.dedupKey)),
          input: { id: factId(stableId('knowledge-maintenance-edge', edge.dedupKey)), ...edge.payload, purpose: edgePurpose },
        })).state === 'proposed') proposedEdges += 1;
      } catch { /* 单条冲突/重复不中断整体 */ }
    }
    if (plan.prepNote) {
      const candidatePrepId = factId(stableId('knowledge-maintenance-prep', plan.prepNote.dedupKey));
      const prepPurpose = force || plan.prepNote.basis.every(u => teachingIds.has(u.id)) ? 'teaching' : 'storage';
      try {
        const saved = await handle({ actor: 'companion', purpose: readPurpose, type: 'activity.saveWorkspaceEntry',
          id: commandId(stableId('knowledge-maintenance-prep-cmd', plan.prepNote.dedupKey)),
          input: { id: candidatePrepId, purpose: prepPurpose, entry: { kind: 'page', title: plan.prepNote.title,
            body: `${plan.prepNote.summary}\n\n${plan.prepNote.actionSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`.trim(),
            tags: ['maintenance', 'prep-note'], links: [] },
            basis: plan.prepNote.basis.map(u => ({ id: u.id, rev: u.rev, epoch: u.accessEpoch })) } });
        if (saved.state === 'done') prepNoteId = candidatePrepId;
      } catch { /* 重复运行安全忽略 */ }
    }
    for (const update of plan.textbookUpdates) {
      const pageSnap = snapshots.get(update.pageId);
      if (pageSnap?.type !== textbookPageType) continue;
      try {
        const prop = await buildCompanionTextbookRevisionProposal(
          { id: pageSnap.ref.id, rev: pageSnap.ref.rev, ...textbookPageFrom(pageSnap) },
          { ...update, basis: authoringWitnesses(snapshots, update.basis.map(u => u.id).filter(id => id !== update.pageId)) },
        );
        const tbRes = await handle({ actor: 'companion', purpose: readPurpose, type: prop.type,
          id: commandId(stableId('knowledge-maintenance-tb', prop.key)), input: prop.input as Json });
        if (tbRes.state === 'proposed') proposedTextbookUpdates += 1;
      } catch { /* 教材提议冲突安全跳过 */ }
    }
    for (const draft of plan.questionDrafts) {
      const witnesses = authoringWitnesses(snapshots, [draft.conceptId]);
      const qPurpose = force ? 'teaching' : readPurpose;
      if (!witnesses.length) continue;
      // 盲解验算最多 2 次付费调用；预算在调用前于学习者锁内原子预留，绝不零成本白嫖付费模型。
      const verificationEffect = await pricedCall(`verify:${draft.dedupKey}`, { draft: draft.dedupKey, slots: 2 },
        providerEffectId => verifyQuestion({ title: draft.prompt.slice(0, 80), prompt: draft.prompt, answer: draft.answer },
          { provider, requestId: providerEffectId }) as Promise<Json>, 2);
      if (verificationEffect?.outcome !== 'ok') continue;
      const verification = verificationEffect.value as Awaited<ReturnType<typeof verifyQuestion>>;
      try {
        if (verification.status !== 'verified') continue;
        const { commands } = await buildAuthoredQuestionCommands({ requestId: draft.dedupKey, mode: 'concept_gap',
          purpose: force ? 'teaching' : 'storage',
          drafts: [{ ...draft, conceptIds: [draft.conceptId], variantRationale: draft.rationale, verification }],
          witnesses, conceptIds: [draft.conceptId] });
        for (const cmd of commands) {
          const res = await handle({ actor: 'companion', purpose: cmd.type === 'content.saveQuestion' ? readPurpose : qPurpose,
            id: commandId(stableId('knowledge-maintenance-q', draft.dedupKey, cmd.key)), type: cmd.type, input: cmd.input });
          if (cmd.type === 'content.saveQuestion' && res.state === 'done') authoredQuestions += 1;
        }
      } catch { /* 单题创作失败安全跳过 */ }
    }
    for (const selected of selectQuestionsForMetaGardening(gardenCandidates, { requireTeaching: force, limit: 2 })) {
      const candidate = selected.candidate;
      try {
        const sourceAsset = parseAsset(snapshots.get(candidate.id)!.value);
        if (sourceAsset.kind !== 'question') continue;
        const solution = questionSolutionFields(sourceAsset);
        const gardenKey = stableId('knowledge-maintenance-garden', candidate.id, String(candidate.rev), String(candidate.metaRev ?? 0));
        const gardenInput = { questionId: candidate.id, rev: candidate.rev, metaRev: candidate.metaRev ?? 0 };
        const gardenEffect = await pricedCall(`garden:${gardenKey}`, gardenInput,
          providerEffectId => gardenMeta({ questionId: candidate.id, title: candidate.title, prompt: candidate.prompt,
            ...(solution.answer ? { answer: solution.answer } : {}), ...(solution.rubric ? { explanation: solution.rubric } : {}),
            gaps: selected.gaps, lockedStickyFields: selected.lockedStickyFields,
            sourceRef: JSON.stringify({ v: 1, fact: { id: candidate.id, rev: candidate.rev, type: 'content.asset' },
              anchor: { kind: 'block', blockId: 'prompt' } }) },
            { provider, requestId: providerEffectId }) as Promise<Json>);
        if (gardenEffect?.outcome !== 'ok') continue;
        const suggestion = gardenEffect.value as Awaited<ReturnType<typeof gardenMeta>>;
        gardenUsage.inputTokens += suggestion.usage.inputTokens ?? 0;
        gardenUsage.outputTokens += suggestion.usage.outputTokens ?? 0;
        gardenUsage.durationMs += suggestion.usage.durationMs;
        const prop = buildQuestionMetaGardeningProposal(candidate, suggestion.draft,
          ...(candidate.metaRev === undefined ? [] : [{ expectedMetaRev: candidate.metaRev }]));
        if (!prop) continue;
        const gardenId = commandId(stableId(gardenKey, prop.key));
        const result = await handle({ actor: 'companion', purpose: readPurpose,
          type: 'content.proposeQuestionMeta', id: gardenId, input: prop.input });
        if (result.state === 'proposed') gardenedQuestionMeta += 1;
      } catch { /* 单题园艺失败安全跳过 */ }
    }
    const { model, reportedModel, inputTokens, outputTokens, durationMs } = result.usage;
    await host.tx(tx => tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, {
      ownerKind: 'session', ownerId: `maintenance:${runKey}`, stepKey: LABEL, label: LABEL, providerEffectId: `maintenance:${runKey}`,
      input: { trigger: context.trigger, force, currentDate },
      result: { model, ...(reportedModel && { reportedModel }),
        ...(gardenUsage.inputTokens ? { inputTokens: (inputTokens ?? 0) + gardenUsage.inputTokens }
          : inputTokens !== undefined ? { inputTokens } : {}),
        ...(gardenUsage.outputTokens ? { outputTokens: (outputTokens ?? 0) + gardenUsage.outputTokens }
          : outputTokens !== undefined ? { outputTokens } : {}),
        durationMs: durationMs + gardenUsage.durationMs, route: 'knowledge-maintenance', ranAtMs: nowMs,
        proposedEdges, prepNoteId, proposedTextbookUpdates, authoredQuestions, gardenedQuestionMeta, rationale: plan.rationale } as Json })));
    return { ran: true as const, reason: context.trigger, rationale: plan.rationale, proposedEdges, prepNoteId,
      proposedTextbookUpdates, authoredQuestions, gardenedQuestionMeta };
  }
  let inFlight = false;
  return { run: (options?: Parameters<typeof run>[0]) => inFlight ? Promise.resolve(skip('in_progress'))
    : (inFlight = true, run(options).finally(() => { inFlight = false; })) };
}
