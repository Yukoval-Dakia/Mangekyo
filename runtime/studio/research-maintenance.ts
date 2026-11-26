import { commandId, factId, readLatestCompletedEffect, stableId, type Db, type Json, type ReadTransaction } from '../../kernel/src/index.ts';
import { recordCompletedEffect } from '../../kernel/src/work/index.ts';
import { effectBudgetUsage } from '../../kernel/src/work/effects.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { extractMaintenanceInputFromFlow, buildMaintenanceContext, planMaintenanceActions, type MaintenanceConceptUse } from '../../modules/companion/maintenance-policy.ts';
import { buildAuthoredQuestionCommands } from '../../modules/content/question-authoring.ts';
import { buildCompanionTextbookRevisionProposal } from '../../modules/content/textbook-authoring.ts';
import { textbookPageFrom, textbookPageType } from '../../modules/content/textbook-page.ts';
import { proposeKnowledgeMaintenanceWithAgent, isLocalZeroCostProvider } from '../../executors/teaching/background-llm.ts';
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
  now?: () => Date; afterFactsChanged?: (() => Promise<void>) | undefined;
};
const LABEL = 'knowledge-maintenance-v1';
const skip = (reason: string) => ({
  ran: false as const, reason, proposedEdges: 0, prepNoteId: null, proposedTextbookUpdates: 0, authoredQuestions: 0,
});
export function openKnowledgeMaintenance(db: Db, deps: Deps) {
  const host = studioHost(db), now = deps.now ?? (() => new Date()), loadProvider = deps.loadProvider ?? (() => loadSettings());
  const agent = deps.agent ?? proposeKnowledgeMaintenanceWithAgent;
  const verifyQuestion = deps.verifyQuestion ?? verifyAuthoredQuestionDraft;
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
        ? { route: budget.route, maxPerCallMicros: budget.maxPerCallMicros } : null;
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
        force ? { minIntervalMs: 0, idleCooldownMs: 0 } : {});
      return context ? { ran: true as const, context, conceptUses, paidBudget, teachingIds, snapshots } : skip('no_maintenance_needed');
    });
    if (prepared.ran === false) return prepared;
    const { context, conceptUses, paidBudget, teachingIds, snapshots } = prepared, provider = await loadProvider().catch(() => undefined);
    if (!provider?.baseUrl) {
      if (force) throw new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型。', 'model_unavailable');
      return skip('model_unavailable');
    }
    const charge = !force && !isLocalZeroCostProvider(provider) ? paidBudget : null;
    if (!force && !isLocalZeroCostProvider(provider) && !charge) return skip('paid_budget_required');
    const runKey = `${currentDate}:${nowMs}`;
    const recordEffect = (effectResult: Json) => host.tx(tx => tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, {
      ownerKind: 'session', ownerId: `maintenance:${runKey}`, stepKey: LABEL, label: LABEL, providerEffectId: `maintenance:${runKey}`,
      input: { trigger: context.trigger, force, currentDate }, result: effectResult,
      ...(charge && { budgetRoute: charge.route, reservedUsdMicros: charge.maxPerCallMicros, actualUsdMicros: null }) })));
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
    let proposedEdges = 0, prepNoteId: string | null = null, proposedTextbookUpdates = 0, authoredQuestions = 0;
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
    const { model, reportedModel, inputTokens, outputTokens, durationMs } = result.usage;
    await recordEffect({ model, ...(reportedModel && { reportedModel }), ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }), durationMs, route: 'knowledge-maintenance', ranAtMs: nowMs,
      proposedEdges, prepNoteId, proposedTextbookUpdates, authoredQuestions, rationale: plan.rationale });
    return { ran: true as const, reason: context.trigger, rationale: plan.rationale, proposedEdges, prepNoteId,
      proposedTextbookUpdates, authoredQuestions };
  }
  let inFlight = false;
  return { run: (options?: Parameters<typeof run>[0]) => inFlight ? Promise.resolve(skip('in_progress'))
    : (inFlight = true, run(options).finally(() => { inFlight = false; })) };
}
