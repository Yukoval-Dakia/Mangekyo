import { commandId, factId, stableId, type Db, type ReadTransaction } from '../../kernel/src/index.ts';
import { recordCompletedEffect } from '../../kernel/src/work/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { extractMaintenanceInputFromFlow, buildMaintenanceContext, planMaintenanceActions, type MaintenanceConceptUse } from '../../modules/companion/maintenance-policy.ts';
import { proposeKnowledgeMaintenanceWithAgent } from '../../executors/teaching/background-llm.ts';
import type { ProviderSettings } from '../../executors/teaching/provider-settings.ts';
import { studioHost } from './fact-read-helpers.ts';
import { loadAuthorizedRecordFlowSnapshot } from './record-flow.ts';
import { currentResearchSettings } from './research-sources.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { RequestError } from './sessions.ts';
import { loadSettings } from './settings.ts';
type Deps = { content: LoadedModule; activity: LoadedModule;
  carePause: { paused: (tx: ReadTransaction, now?: number) => Promise<boolean> };
  loadProvider?: () => Promise<ProviderSettings>; agent?: typeof proposeKnowledgeMaintenanceWithAgent;
  now?: () => Date; afterFactsChanged?: (() => Promise<void>) | undefined };
const LABEL = 'knowledge-maintenance-v1';
const skip = (reason: string) => ({ ran: false as const, reason, proposedEdges: 0, prepNoteId: null });
export function openKnowledgeMaintenance(db: Db, deps: Deps) {
  const host = studioHost(db), now = deps.now ?? (() => new Date()),
    loadProvider = deps.loadProvider ?? (() => loadSettings()), agent = deps.agent ?? proposeKnowledgeMaintenanceWithAgent,
    handle = host.boundHandler([deps.content, deps.activity], createStudioCommandHooks(deps.afterFactsChanged ? { afterFactsChanged: deps.afterFactsChanged } : {}));
  async function run(options: { force?: boolean; now?: () => Date } = {}) {
    const force = options.force === true, nowMs = (options.now ?? now)().getTime(),
      currentDate = new Intl.DateTimeFormat('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' }).format(new Date(nowMs));
    const prepared = await host.snapshot(async tx => {
      if (await deps.carePause.paused(tx, nowMs)) return skip('care_paused');
      if (!force && !(await currentResearchSettings(tx))?.enabled) return skip('research_disabled');
      const { snap, snapshots } = await loadAuthorizedRecordFlowSnapshot(tx, { purpose: 'teaching' });
      const conceptUses = new Map<string, MaintenanceConceptUse>(), accessEpochs = new Map<string, string>();
      for (const [id, s] of snapshots) { conceptUses.set(id, { id, rev: s.ref.rev, accessEpoch: s.accessEpoch }); accessEpochs.set(id, s.accessEpoch); }
      const last = (await tx.query<{ ended_tick: string; ranAtMs: string | null }>(`SELECT ended_tick::text, (result->>'ranAtMs')::bigint AS "ranAtMs" FROM effects
        WHERE learner_id=$1 AND label=$2 AND state='done' ORDER BY ended_tick DESC LIMIT 1`, [tx.learner, LABEL])).rows[0];
      const context = buildMaintenanceContext(extractMaintenanceInputFromFlow(snap, { currentDate, nowMs, lastRunAtMs: last?.ranAtMs ? Number(last.ranAtMs) : null,
        lastRunTick: last?.ended_tick ?? null, accessEpochs }), force ? { minIntervalMs: 0, idleCooldownMs: 0 } : {});
      return context ? { ran: true as const, context, conceptUses } : skip('no_maintenance_needed');
    });
    if (prepared.ran === false) return prepared;
    const { context, conceptUses } = prepared, provider = await loadProvider().catch(() => undefined);
    if (!provider?.baseUrl) {
      if (force) throw new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型。', 'model_unavailable');
      return skip('model_unavailable');
    }
    const runKey = `${currentDate}:${nowMs}`, result = await agent(context, { provider, requestId: `maint-${runKey}` }),
      plan = planMaintenanceActions(result.proposal, context, { conceptUses, purpose: 'teaching' });
    let proposedEdges = 0;
    for (const edge of plan.edgeProposals) {
      try {
        if ((await handle({ actor: 'companion', purpose: 'teaching', type: edge.commandType, id: commandId(stableId('knowledge-maintenance', edge.dedupKey)),
          input: { id: factId(stableId('knowledge-maintenance-edge', edge.dedupKey)), ...edge.payload } })).state === 'proposed') proposedEdges += 1;
      } catch { /* 单条冲突/重复不中断整体 */ }
    }
    let prepNoteId: string | null = null;
    if (plan.prepNote) {
      prepNoteId = factId(stableId('knowledge-maintenance-prep', plan.prepNote.dedupKey));
      try {
        await handle({ actor: 'companion', purpose: 'teaching', type: 'activity.saveWorkspaceEntry', id: commandId(stableId('knowledge-maintenance-prep-cmd', plan.prepNote.dedupKey)),
          input: { id: prepNoteId, entry: { kind: 'page', title: plan.prepNote.title,
            body: `${plan.prepNote.summary}\n\n${plan.prepNote.actionSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`.trim(),
            tags: ['maintenance', 'prep-note'], links: [] },
            basis: plan.prepNote.basis.map(u => ({ id: u.id, rev: u.rev, epoch: u.accessEpoch })) } });
      } catch { /* 重复运行安全忽略 */ }
    }
    await host.tx(tx => tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, {
      ownerKind: 'session', ownerId: `maintenance:${runKey}`, stepKey: LABEL, label: LABEL, providerEffectId: `maintenance:${runKey}`,
      input: { trigger: context.trigger, force, currentDate },
      result: { model: result.usage.model, ...(result.usage.reportedModel ? { reportedModel: result.usage.reportedModel } : {}),
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
        durationMs: result.usage.durationMs, route: 'knowledge-maintenance', ranAtMs: nowMs, proposedEdges, prepNoteId, rationale: plan.rationale } })));
    return { ran: true as const, reason: context.trigger, rationale: plan.rationale, proposedEdges, prepNoteId };
  }
  return { run };
}
