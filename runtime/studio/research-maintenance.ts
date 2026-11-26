import { commandId, factId, isFactNotFound, readLatestCompletedEffect, stableId,
  type Db, type Json, type ReadTransaction } from '../../kernel/src/index.ts';
import { recordCompletedEffect } from '../../kernel/src/work/index.ts';
import { effectBudgetUsage } from '../../kernel/src/work/effects.ts';
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
import { TeachingError } from '../../executors/teaching/provider.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { researchPurpose } from '../../modules/companion/research.ts';
import { studioHost } from './identity.ts';
import { authoringWitnesses, loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { currentResearchSettings } from './research-sources.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';
type Deps = {
  content: LoadedModule; activity: LoadedModule; carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> };
  loadProvider?: () => Promise<ProviderSettings>; agent?: typeof proposeKnowledgeMaintenanceWithAgent;
  verifyQuestion?: typeof verifyAuthoredQuestionDraft;
  gardenMeta?: typeof gardenQuestionMetadataWithModel;
  now?: () => Date; afterFactsChanged?: (() => Promise<void>) | undefined;
};
const LABEL = 'knowledge-maintenance-v1';
const skip = (reason: string) => ({
  ran: false as const, reason, proposedEdges: 0, prepNoteId: null, proposedTextbookUpdates: 0, authoredQuestions: 0,
  gardenedQuestionMeta: 0,
});
export function openKnowledgeMaintenance(db: Db, deps: Deps) {
  const host = studioHost(db), now = deps.now ?? (() => new Date()), loadProvider = deps.loadProvider ?? (() => loadSettings());
  const agent = deps.agent ?? proposeKnowledgeMaintenanceWithAgent;
  const verifyQuestion = deps.verifyQuestion ?? verifyAuthoredQuestionDraft;
  const gardenMeta = deps.gardenMeta ?? gardenQuestionMetadataWithModel;
  const handle = host.boundHandler([deps.content, deps.activity],
    createStudioCommandHooks(deps.afterFactsChanged ? { afterFactsChanged: deps.afterFactsChanged } : {}));
  async function run(options: { force?: boolean; now?: () => Date } = {}) {
    const force = options.force === true, nowMs = (options.now ?? now)().getTime(), readPurpose = force ? 'teaching' : researchPurpose,
      currentDate = new Intl.DateTimeFormat('en-CA',
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }).format(new Date(nowMs));
    const prepared = await host.snapshot(async tx => {
      if (await deps.carePause.paused(tx, nowMs)) return skip('care_paused');
      const settings = force ? null : await currentResearchSettings(tx);
      if (!force && !settings?.enabled) return skip('research_disabled');
      const budget = settings?.scoutBudget;
      const spent = !force && budget && budget.limitMicros > 0 && budget.maxPerCallMicros > 0 && budget.expiresAtMs > nowMs
        ? await effectBudgetUsage(tx) : null;
      const paidBudget = spent && budget && spent.settled + spent.held + BigInt(budget.maxPerCallMicros) <= BigInt(budget.limitMicros)
        ? { route: budget.route, maxPerCallMicros: budget.maxPerCallMicros,
          extraCalls: Number((BigInt(budget.limitMicros) - spent.settled - spent.held) / BigInt(budget.maxPerCallMicros)) - 1 }
        : null;
      const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: readPurpose });
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
      const teachingRead = studioHost(db).read(tx, 'teaching');
      const readVerification = readCurrentQuestionVerification(tx);
      for (const question of snapshots.values()) {
        if (question.type !== 'content.asset' || !teachingIds.has(question.ref.id)) continue;
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
    const provider = await loadProvider().catch(() => undefined);
    if (!provider?.baseUrl) {
      if (force) throw new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型。', 'model_unavailable');
      return skip('model_unavailable');
    }
    const charge = !force && !isLocalZeroCostProvider(provider) ? paidBudget : null;
    if (!force && !isLocalZeroCostProvider(provider) && !charge) return skip('paid_budget_required');
    let extraCalls = charge ? charge.extraCalls : Number.MAX_SAFE_INTEGER;
    let gardenCalls = 0;
    const gardenUsage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    const runKey = `${currentDate}:${nowMs}`;
    const recordEffect = (effectResult: Json) => host.tx(tx => tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, {
      ownerKind: 'session', ownerId: `maintenance:${runKey}`, stepKey: LABEL, label: LABEL, providerEffectId: `maintenance:${runKey}`,
      input: { trigger: context.trigger, force, currentDate }, result: effectResult,
      ...(charge && { budgetRoute: charge.route, reservedUsdMicros: charge.maxPerCallMicros * (1 + gardenCalls), actualUsdMicros: null }) })));
    let result: Awaited<ReturnType<typeof agent>>;
    try { result = await agent(context, { provider, requestId: `maint-${runKey}` }); } catch (err) {
      if (!(err instanceof TeachingError)) throw err;
      if (!force) {
        if (charge && err.code !== 'provider_unavailable' && err.code !== 'provider_configuration')
          await recordEffect({ error: err.code, route: 'knowledge-maintenance', ranAtMs: nowMs });
        return skip(err.code);
      }
      const unavail = ['provider_unavailable', 'provider_configuration'].includes(err.code);
      throw new RequestError(unavail ? 503 : 502, err.message, unavail ? 'model_unavailable' : err.code);
    }
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
      const qPurpose = force || teachingIds.has(draft.conceptId) ? 'teaching' : 'storage';
      if (!witnesses.length) continue;
      try {
        const verification = await verifyQuestion({ title: draft.prompt.slice(0, 80), prompt: draft.prompt, answer: draft.answer },
          { provider, requestId: `maint-q-${draft.dedupKey}` });
        if (verification.status !== 'verified') continue;
        const { commands } = await buildAuthoredQuestionCommands({ requestId: draft.dedupKey, mode: 'concept_gap', purpose: qPurpose,
          drafts: [{ ...draft, conceptIds: [draft.conceptId], variantRationale: draft.rationale, verification }],
          witnesses, conceptIds: [draft.conceptId] });
        for (const cmd of commands) {
          const res = await handle({ actor: 'companion', purpose: cmd.type === 'content.saveQuestion' ? readPurpose : qPurpose,
            id: commandId(stableId('knowledge-maintenance-q', draft.dedupKey, cmd.key)), type: cmd.type, input: cmd.input });
          if (cmd.type === 'content.saveQuestion' && res.state === 'done') authoredQuestions += 1;
        }
      } catch { /* 单题创作失败安全跳过 */ }
    }
    for (const selected of selectQuestionsForMetaGardening(gardenCandidates, { requireTeaching: true, limit: 2 })) {
      const candidate = selected.candidate;
      if (charge && extraCalls <= 0) break;
      try {
        const sourceAsset = parseAsset(snapshots.get(candidate.id)!.value);
        if (sourceAsset.kind !== 'question') continue;
        const solution = questionSolutionFields(sourceAsset);
        const gardenKey = stableId('knowledge-maintenance-garden', candidate.id, String(candidate.rev), String(candidate.metaRev ?? 0));
        if (charge) { extraCalls -= 1; gardenCalls += 1; }
        const suggestion = await gardenMeta({ questionId: candidate.id, title: candidate.title, prompt: candidate.prompt,
          ...(solution.answer ? { answer: solution.answer } : {}), ...(solution.rubric ? { explanation: solution.rubric } : {}),
          gaps: selected.gaps, lockedStickyFields: selected.lockedStickyFields,
          sourceRef: JSON.stringify({ v: 1, fact: { id: candidate.id, rev: candidate.rev, type: 'content.asset' },
            anchor: { kind: 'block', blockId: 'prompt' } }) },
          { provider, requestId: gardenKey }).catch(error => Promise.reject(
            charge && error instanceof TeachingError && (error.code === 'provider_unavailable' || error.code === 'provider_configuration')
              ? (gardenCalls -= 1, extraCalls += 1, error) : error));
        gardenUsage.inputTokens += suggestion.usage.inputTokens ?? 0;
        gardenUsage.outputTokens += suggestion.usage.outputTokens ?? 0;
        gardenUsage.durationMs += suggestion.usage.durationMs;
        const prop = buildQuestionMetaGardeningProposal(candidate, suggestion.draft,
          ...(candidate.metaRev === undefined ? [] : [{ expectedMetaRev: candidate.metaRev }]));
        if (!prop) continue;
        const gardenId = commandId(stableId(gardenKey, prop.key));
        const result = await handle({ actor: 'companion', purpose: 'teaching',
          type: 'content.proposeQuestionMeta', id: gardenId, input: prop.input });
        if (result.state === 'proposed') gardenedQuestionMeta += 1;
      } catch { /* 单题园艺失败安全跳过 */ }
    }
    const { model, reportedModel, inputTokens, outputTokens, durationMs } = result.usage;
    await recordEffect({ model, ...(reportedModel && { reportedModel }),
      ...(gardenUsage.inputTokens ? { inputTokens: (inputTokens ?? 0) + gardenUsage.inputTokens }
        : inputTokens !== undefined ? { inputTokens } : {}),
      ...(gardenUsage.outputTokens ? { outputTokens: (outputTokens ?? 0) + gardenUsage.outputTokens }
        : outputTokens !== undefined ? { outputTokens } : {}),
      durationMs: durationMs + gardenUsage.durationMs, route: 'knowledge-maintenance', ranAtMs: nowMs,
      proposedEdges, prepNoteId, proposedTextbookUpdates, authoredQuestions, gardenedQuestionMeta, rationale: plan.rationale });
    return { ran: true as const, reason: context.trigger, rationale: plan.rationale, proposedEdges, prepNoteId,
      proposedTextbookUpdates, authoredQuestions, gardenedQuestionMeta };
  }
  let inFlight = false;
  return { run: (options?: Parameters<typeof run>[0]) => inFlight ? Promise.resolve(skip('in_progress'))
    : (inFlight = true, run(options).finally(() => { inFlight = false; })) };
}
