import { FactNotFoundError, factId, type FactId, type ReadContext, type Tick } from '@mangekyo/kernel';
import { assetType } from '@mangekyo/module-content/facts/asset-contract';
import { graphProposalCommands, type KnowledgeGraphProposal } from '@mangekyo/module-content/facts/knowledge-graph-overview';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import { readAuthorizedForegroundDigests } from './foreground-digest.ts';
import { inspectBankQuestion } from './iqdb-selection.ts';
import { studyTurn } from './values.ts';

export type AiRunningKind = 'teaching' | 'research' | 'retention' | 'intake' | 'assessment' | 'verification' | 'other';
export type AiRunningState = 'queued' | 'running' | 'waiting' | 'blocked';

export type AiRunningTask = {
  readonly id: string;
  readonly kind: AiRunningKind;
  readonly slotType: string;
  readonly slotKey: string;
  readonly deriver: string;
  readonly state: AiRunningState;
  readonly title: string;
  readonly requestedTick: Tick;
  readonly generation: number;
  readonly workerProfile: string | null;
  readonly chainId: string | null;
  readonly hopCount: number | null;
};

export type AiHandoffChannel = 'night_chain' | 'research' | 'retention' | 'notion';

export type AiHandoffItem = {
  readonly id: string;
  readonly channel: AiHandoffChannel;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly tick: Tick;
  readonly basisCount: number;
  readonly href: string | null;
};

export type AiRecentToolTurn = {
  readonly turnId: FactId;
  readonly sessionId: FactId;
  readonly caseId: string;
  readonly tick: Tick;
  readonly model: string;
  readonly tools: readonly string[];
  readonly toolCount: number;
  readonly basisCount: number;
  readonly writeCount: number;
  readonly href: string;
};

export type AiUsageCall = {
  readonly id: string;
  readonly ownerKind: 'derivation' | 'session';
  readonly ownerId: string;
  readonly stepKey: string;
  readonly label: string;
  readonly state: 'started' | 'done' | 'unknown';
  readonly model: string | null;
  readonly route: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly reservedMicros: number | null;
  readonly actualMicros: number | null;
  readonly startedTick: Tick;
  readonly endedTick: Tick | null;
};

export type AiUsageSummary = {
  readonly currency: 'USD_MICROS';
  readonly spentMicros: number;
  readonly settledMicros: number;
  readonly heldMicros: number;
  readonly limitMicros: number | null;
  readonly recentCalls: readonly AiUsageCall[];
};

export type AiPendingProposalKind = 'knowledge_edge' | 'graph_evolution' | 'knowledge_entity' | 'textbook_patch' | 'question_draft' | 'question_meta' | 'other';

export type AiProposalAction = {
  readonly method: 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
};

export type AiPendingProposal = {
  readonly id: string;
  readonly kind: AiPendingProposalKind;
  readonly commandType: string;
  readonly status: 'pending';
  readonly title: string;
  readonly summary: string;
  readonly targetId: FactId | null;
  readonly createdTick: Tick;
  readonly actions: {
    readonly accept?: AiProposalAction;
    readonly reject?: AiProposalAction;
    readonly inspect?: { readonly method: 'GET'; readonly path: string };
  };
};

export type AiActivityResponse = {
  readonly asOf: string;
  readonly running: readonly AiRunningTask[];
  readonly handoffs: readonly AiHandoffItem[];
  readonly recentTools: readonly AiRecentToolTurn[];
  readonly usage: AiUsageSummary;
  readonly pendingProposals: readonly AiPendingProposal[];
};

export type AuthorizedTurnToolView = Omit<AiRecentToolTurn, 'tick'>;

export type AiActivityPorts = {
  readonly feedbackSlotType: string;
  readonly readStorage: Pick<ReadContext, 'fact'>;
  readonly readTeaching: Pick<ReadContext, 'fact'>;
  readonly readBankQuestion: ReadContext;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly authorizeTodo: (spec: unknown) => Promise<{ readonly goal: string; readonly workerProfile: string } | undefined>;
  readonly validateTurnManifest: (rawManifest: unknown) => Promise<readonly string[] | undefined>;
  readonly projectTrace: (entry: string) => string;
  readonly openResearchWorksheet: (id: FactId) => Promise<{ readonly title: string; readonly summary: string; readonly basisCount: number; readonly href: string | null } | undefined>;
  readonly readRetentionHandoffs: () => Promise<readonly AiHandoffItem[]>;
  readonly openNotionSelection: (selectionId: string) => Promise<{ readonly title: string; readonly summary: string; readonly sourceCount: number } | undefined>;
  readonly readBudgetUsage: () => Promise<{ readonly settled: bigint; readonly held: bigint }>;
  readonly readBudgetLimit: () => Promise<number | null>;
  readonly readGraphProposals: () => Promise<readonly KnowledgeGraphProposal[]>;
  readonly openTextbookProposal: (proposalId: string, input: unknown) => Promise<{
    readonly pageId: FactId;
    readonly title: string;
    readonly blockCount: number;
  } | undefined>;
};

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const reviseTextbookCommand = 'content.reviseTextbookPage';
const proposeQuestionMetaCommand = 'content.proposeQuestionMeta';
const questionMetaDraftType = 'content.questionMetaDraft';
const researchWorksheetType = 'companion.researchWorksheet';
const notionSelectionType = 'capture.notionSelection';

function classifySlot(slotType: string): { kind: AiRunningKind; label: string } {
  if (slotType === 'activity.studyFeedback') return { kind: 'teaching', label: '同伴回合回复' };
  if (slotType === 'working.todo' || slotType === 'companion.researchWake') return { kind: 'research', label: '后台教研工作单' };
  if (slotType.startsWith('predict.') || slotType.startsWith('retention.')) return { kind: 'retention', label: '保持预测与对账' };
  if (slotType === 'capture.cloudIntake') return { kind: 'intake', label: '云端文档提取' };
  if (slotType === 'activity.workbookRubricAssessment' || slotType === 'activity.artifactFormalAssessment') {
    return { kind: 'assessment', label: '自动评阅任务' };
  }
  if (slotType === 'content.questionVerification') return { kind: 'verification', label: '题库独立验收' };
  return { kind: 'other', label: slotType };
}

function compareTickDesc(left: Tick, right: Tick) {
  const diff = BigInt(right) - BigInt(left);
  return diff === 0n ? 0 : diff > 0n ? 1 : -1;
}

function graphProposalKind(commandType: string): AiPendingProposalKind {
  if (commandType === 'content.createKnowledgeEdge') return 'knowledge_edge';
  if (commandType === 'content.evolveGraph') return 'graph_evolution';
  return 'knowledge_entity';
}

function scopeFactIds(scopeKeys: unknown): FactId[] {
  if (!scopeKeys || typeof scopeKeys !== 'object' || Array.isArray(scopeKeys)) return [];
  const ids: FactId[] = [];
  const record = scopeKeys as Record<string, unknown>;
  for (const key of ['paperId', 'attemptId', 'questionId', 'sourceId']) {
    const value = record[key];
    if (typeof value === 'string' && ulidPattern.test(value)) ids.push(factId(value));
  }
  return ids;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseEffectResult(raw: unknown): Record<string, unknown> | undefined {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function effectModel(result: Record<string, unknown> | undefined): string | null {
  if (!result) return null;
  const served = result.servedModel ?? result.reportedModel ?? result.model;
  return typeof served === 'string' && served ? served : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function effectTokens(result: Record<string, unknown> | undefined): {
  promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
} {
  const usage = result && isObject(result.usage) ? result.usage : undefined;
  const promptTokens = tokenCount(usage?.promptTokens) ?? tokenCount(usage?.prompt_tokens) ??
    tokenCount(usage?.input_tokens) ?? tokenCount(result?.promptTokens);
  const completionTokens = tokenCount(usage?.completionTokens) ?? tokenCount(usage?.completion_tokens) ??
    tokenCount(usage?.output_tokens) ?? tokenCount(result?.completionTokens);
  const totalTokens = tokenCount(usage?.totalTokens) ?? tokenCount(usage?.total_tokens) ??
    tokenCount(result?.totalTokens) ??
    (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  return { promptTokens, completionTokens, totalTokens };
}

export async function readAiActivity(
  tx: ActivityEvidenceReadScope,
  asOf: string,
  ports: AiActivityPorts,
): Promise<AiActivityResponse> {
  const unavailable = (error: unknown) => error instanceof FactNotFoundError || ports.isUnavailable(error);
  const factVisible = async (read: Pick<ReadContext, 'fact'>, id: FactId) => {
    try { return Boolean(await read.fact(id, { mode: 'following' })); }
    catch (error) { if (unavailable(error)) return false; throw error; }
  };
  const openFact = async (read: Pick<ReadContext, 'fact'>, id: FactId) => {
    try { return await read.fact(id, { mode: 'following' }); }
    catch (error) { if (unavailable(error)) return undefined; throw error; }
  };

  const workRows = await tx.query<{
    id: string; family: string; slot_type: string; slot_key: string; deriver: string; state: string;
    requested_tick: Tick; generation: number; pending: string | null; scope_keys: unknown;
    spec: unknown; chain_id: string | null; hop_count: number | null;
  }>(`
    SELECT w.id, w.family, w.slot_type, w.slot_key, w.deriver, w.state,
           w.requested_tick::text, w.generation::int, s.pending, s.scope_keys,
           w.spec, w.chain_id, w.hop_count
    FROM work w
    LEFT JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key)
    WHERE w.learner_id=$1 AND w.state IN ('pending','ready','waiting','blocked')
    ORDER BY w.requested_tick DESC, w.id LIMIT 48`, [tx.learner]);
  const completedTodoRows = await tx.query<{
    id: string; spec: unknown; state: string; chain_id: string | null; hop_count: number | null; registered_tick: Tick;
  }>(`
    SELECT id, spec, state, chain_id, hop_count, COALESCE(registered_tick, requested_tick)::text AS registered_tick
    FROM work
    WHERE learner_id=$1 AND family IN ('todo','routed_todo') AND state IN ('satisfied','unavailable')
    ORDER BY COALESCE(registered_tick, requested_tick) DESC, id LIMIT 24`, [tx.learner]);
  const feedbackRows = await tx.query<{ slot_key: string; effective_tick: Tick; manifest: unknown; value: unknown }>(`
    SELECT d.slot_key, d.effective_tick::text, d.manifest, d.value
    FROM slot_state s
    JOIN derivations d ON (d.learner_id,d.id)=(s.learner_id,s.current_id)
    JOIN facts f ON (f.learner_id,f.id)=(s.learner_id,s.slot_key)
    WHERE s.learner_id=$1 AND s.slot_type=$2
      AND d.lifecycle='effective' AND d.selection_ended_tick IS NULL AND d.invalidated_tick IS NULL
      AND NOT d.is_shadow AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY d.effective_tick DESC, d.id DESC LIMIT 24`, [tx.learner, ports.feedbackSlotType]);
  const effectRows = await tx.query<{
    owner_kind: 'derivation' | 'session'; owner_id: string; step_key: string; label: string;
    state: 'started' | 'done' | 'unknown'; budget_route: string | null;
    reserved_usd_micros: string | null; actual_usd_micros: string | null;
    started_tick: Tick; ended_tick: Tick | null; result: unknown;
    fact_retracted: boolean | null; fact_erased: boolean;
  }>(`
    SELECT e.owner_kind, e.owner_id, e.step_key, e.label, e.state, e.budget_route,
           e.reserved_usd_micros::text, e.actual_usd_micros::text,
           e.started_tick::text, e.ended_tick::text, e.result,
           (f.retracted_rev IS NOT NULL) AS fact_retracted,
           EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=e.learner_id AND t.kind='fact' AND t.id=e.owner_id) AS fact_erased
    FROM effects e
    LEFT JOIN facts f ON e.owner_kind='session' AND f.learner_id=e.learner_id AND f.id=e.owner_id
    WHERE e.learner_id=$1 AND e.label NOT LIKE 'local:%'
      AND (e.reserved_usd_micros IS NOT NULL OR e.provider_effect_id IS NOT NULL OR e.label='teaching-model')
    ORDER BY e.started_tick DESC, e.owner_id, e.step_key LIMIT 24`, [tx.learner]);
  const proposalRows = await tx.query<{ id: string; type: string; input: unknown; created_tick: Tick }>(`
    SELECT p.command_id AS id, c.type, p.input, p.created_tick::text
    FROM proposals p
    JOIN commands c ON (c.learner_id,c.id)=(p.learner_id,p.command_id)
    WHERE p.learner_id=$1 AND p.state='pending'
    ORDER BY p.created_tick DESC, p.command_id LIMIT 128`, [tx.learner]);
  const questionRows = await tx.query<{ id: string; created_tick: Tick }>(`
    SELECT f.id, f.created_tick::text FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='question'
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.changed_tick DESC, f.id LIMIT 64`, [tx.learner, assetType]);
  const metaDraftRows = await tx.query<{ id: string; created_tick: Tick; question_id: string | null }>(`
    SELECT f.id, f.created_tick::text, r.data->>'id' AS question_id FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND COALESCE((r.data->>'sticky')::boolean, false)=false
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.changed_tick DESC, f.id LIMIT 32`, [tx.learner, questionMetaDraftType]);
  const worksheetRows = await tx.query<{ id: string; tick: Tick }>(`
    SELECT f.id, f.changed_tick::text AS tick FROM facts f
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.changed_tick DESC, f.id LIMIT 12`, [tx.learner, researchWorksheetType]);
  const notionRows = await tx.query<{ id: string; selection_id: string | null; tick: Tick }>(`
    SELECT f.id, r.data->>'id' AS selection_id, f.changed_tick::text AS tick FROM facts f
    JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
    ORDER BY f.changed_tick DESC, f.id LIMIT 16`, [tx.learner, notionSelectionType]);
  const digestResult = await readAuthorizedForegroundDigests(tx, ports.feedbackSlotType, '0', {
    read: ports.readTeaching, maySend: () => true, authorize: async () => {},
    isManifestValid: async raw => Boolean(await ports.validateTurnManifest(raw)),
    isUnavailable: ports.isUnavailable,
  });
  const retentionHandoffs = await ports.readRetentionHandoffs();
  const budgetUsage = await ports.readBudgetUsage();
  const limitMicros = await ports.readBudgetLimit();
  const graphProposals = await ports.readGraphProposals();

  const running: AiRunningTask[] = [];
  for (const row of workRows.rows) {
    const { kind, label } = classifySlot(row.slot_type);
    let title = label;
    let workerProfile: string | null = null;
    if (row.slot_type === ports.feedbackSlotType) {
      if (!ulidPattern.test(row.slot_key)) continue;
      const id = factId(row.slot_key);
      if (!await factVisible(ports.readTeaching, id) && !await factVisible(ports.readStorage, id)) continue;
    } else if (row.slot_type === 'working.todo') {
      const authorized = await ports.authorizeTodo(row.spec);
      if (!authorized) continue;
      title = authorized.goal;
      workerProfile = authorized.workerProfile;
    } else if (row.slot_type === 'capture.cloudIntake') {
      if (!ulidPattern.test(row.slot_key) || !await factVisible(ports.readStorage, factId(row.slot_key))) continue;
    } else {
      const refs = scopeFactIds(row.scope_keys);
      let ok = true;
      for (const ref of refs) {
        if (!await factVisible(ports.readStorage, ref) && !await factVisible(ports.readTeaching, ref)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    const state: AiRunningState = row.state === 'blocked' ? 'blocked'
      : row.state === 'waiting' || row.pending === 'waiting' ? 'waiting'
      : row.pending === 'running' ? 'running' : 'queued';
    running.push({
      id: row.id, kind, slotType: row.slot_type, slotKey: row.slot_key, deriver: row.deriver,
      state, title, requestedTick: row.requested_tick, generation: row.generation,
      workerProfile, chainId: row.chain_id, hopCount: row.hop_count,
    });
  }

  const todoHandoffs: AiHandoffItem[] = [];
  for (const row of completedTodoRows.rows) {
    const authorized = await ports.authorizeTodo(row.spec);
    if (!authorized) continue;
    const channel: AiHandoffChannel = authorized.workerProfile === 'deep_analyst' ? 'research' : 'night_chain';
    todoHandoffs.push({
      id: row.id, channel, status: row.state === 'satisfied' ? 'completed' : 'failed',
      title: channel === 'research' ? '教研任务交班' : '夜链任务交班',
      summary: authorized.goal, tick: row.registered_tick, basisCount: 1, href: null,
    });
  }

  const researchHandoffs: AiHandoffItem[] = [];
  for (const row of worksheetRows.rows) {
    if (!ulidPattern.test(row.id)) continue;
    const opened = await ports.openResearchWorksheet(factId(row.id));
    if (!opened) continue;
    researchHandoffs.push({
      id: row.id, channel: 'research', status: 'ready',
      title: opened.title, summary: opened.summary, tick: row.tick,
      basisCount: opened.basisCount, href: opened.href,
    });
  }

  const notionHandoffs: AiHandoffItem[] = [];
  for (const row of notionRows.rows) {
    if (!row.selection_id) continue;
    const opened = await ports.openNotionSelection(row.selection_id);
    if (!opened) continue;
    notionHandoffs.push({
      id: row.id, channel: 'notion', status: 'synced',
      title: opened.title, summary: opened.summary, tick: row.tick,
      basisCount: opened.sourceCount, href: '/materials',
    });
  }

  const foregroundHandoffs: AiHandoffItem[] = [];
  for (const item of digestResult.digests) {
    let href = '/companion';
    if (ulidPattern.test(item.id)) {
      const turnFact = await openFact(ports.readTeaching, factId(item.id));
      if (turnFact?.type === 'activity.studyTurn') {
        try {
          const turn = studyTurn(turnFact.value);
          if (turn.classroom) href = `/classroom/${turn.sessionId}`;
        } catch { /* keep the default companion link */ }
      }
    }
    foregroundHandoffs.push({
      id: item.id, channel: 'night_chain', status: 'completed', title: '前台学习交班',
      summary: item.summary, tick: item.tick, basisCount: item.sourceRefs.length, href,
    });
  }

  const handoffs = [
    ...foregroundHandoffs,
    ...researchHandoffs,
    ...retentionHandoffs,
    ...notionHandoffs,
    ...todoHandoffs,
  ].sort((left, right) => compareTickDesc(left.tick, right.tick) || right.id.localeCompare(left.id)).slice(0, 24);

  const recentTools: AiRecentToolTurn[] = [];
  for (const row of feedbackRows.rows) {
    if (!ulidPattern.test(row.slot_key)) continue;
    const turnId = factId(row.slot_key);
    const manifestFactIds = await ports.validateTurnManifest(row.manifest);
    if (!manifestFactIds) continue;
    const turnFact = await openFact(ports.readTeaching, turnId);
    if (!turnFact || turnFact.type !== 'activity.studyTurn') continue;
    let parsed;
    try { parsed = studyTurn(turnFact.value); } catch { continue; }
    const view = projectTurnToolSummary({
      turnId, sessionId: factId(parsed.sessionId), caseId: parsed.caseId,
      ...(parsed.classroom ? { classroom: true } : {}),
      value: row.value, manifestFactIds, projectTrace: ports.projectTrace,
    });
    if (view) recentTools.push({ ...view, tick: row.effective_tick });
  }

  const recentCalls: AiUsageCall[] = [];
  for (const row of effectRows.rows) {
    if (row.fact_erased || row.fact_retracted) continue;
    const result = parseEffectResult(row.result);
    recentCalls.push({
      id: `${row.owner_kind}:${row.owner_id}:${row.step_key}:${row.label}`,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      stepKey: row.step_key,
      label: row.label,
      state: row.state,
      model: effectModel(result),
      route: row.budget_route,
      ...effectTokens(result),
      reservedMicros: row.reserved_usd_micros === null ? null : Number(row.reserved_usd_micros),
      actualMicros: row.actual_usd_micros === null ? null : Number(row.actual_usd_micros),
      startedTick: row.started_tick,
      endedTick: row.ended_tick,
    });
  }

  const settledMicros = Number(budgetUsage.settled);
  const heldMicros = Number(budgetUsage.held);
  const usage: AiUsageSummary = {
    currency: 'USD_MICROS',
    spentMicros: settledMicros + heldMicros,
    settledMicros,
    heldMicros,
    limitMicros,
    recentCalls: recentCalls.slice(0, 20),
  };

  const pendingProposals: AiPendingProposal[] = [];
  const graphCommandSet = new Set<string>(graphProposalCommands);

  for (const proposal of graphProposals) {
    pendingProposals.push({
      id: proposal.proposalId,
      kind: graphProposalKind(proposal.commandType),
      commandType: proposal.commandType,
      status: 'pending',
      title: proposal.commandType === 'content.createKnowledgeEdge' ? '图谱边提议' : '知识图谱演化提议',
      summary: proposal.summary,
      targetId: proposal.targetId ?? proposal.toId ?? null,
      createdTick: proposal.createdTick,
      actions: {
        ...(proposal.actions?.accept ? { accept: proposal.actions.accept } : {}),
        ...(proposal.actions?.reject ? { reject: proposal.actions.reject } : {}),
        ...(proposal.commandType === 'content.createKnowledgeEdge'
          ? { inspect: { method: 'GET', path: `/api/workspace/relations/proposals/${proposal.proposalId}` } } : {}),
      },
    });
  }

  for (const row of proposalRows.rows) {
    if (graphCommandSet.has(row.type)) continue;
    if (row.type === reviseTextbookCommand) {
      const opened = await ports.openTextbookProposal(row.id, row.input);
      if (!opened) continue;
      pendingProposals.push({
        id: row.id,
        kind: 'textbook_patch',
        commandType: row.type,
        status: 'pending',
        title: `教材修订提议 · ${opened.title}`,
        summary: `涉及 ${opened.blockCount} 处教材块修订`,
        targetId: opened.pageId,
        createdTick: row.created_tick,
        actions: {
          inspect: { method: 'GET', path: `/api/textbooks/${opened.pageId}/proposals/${row.id}` },
          accept: { method: 'POST', path: `/api/textbooks/${opened.pageId}/proposals/${row.id}` },
          reject: { method: 'POST', path: `/api/textbooks/${opened.pageId}/proposals/${row.id}`, body: { blockIds: [] } },
        },
      });
      continue;
    }
    if (row.type === proposeQuestionMetaCommand) {
      const targetRaw = isObject(row.input) ? row.input.id : undefined;
      if (typeof targetRaw !== 'string' || !ulidPattern.test(targetRaw)) continue;
      const target = await openFact(ports.readStorage, factId(targetRaw));
      if (!target) continue;
      const title = isObject(target.value) && typeof target.value.title === 'string' ? target.value.title : target.ref.id;
      pendingProposals.push({
        id: row.id,
        kind: 'question_meta',
        commandType: row.type,
        status: 'pending',
        title: `题目元数据提议 · ${title}`,
        summary: '待确认题目附加标签、解析或提示阶梯',
        targetId: target.ref.id,
        createdTick: row.created_tick,
        actions: {},
      });
      continue;
    }
    const rawTarget = isObject(row.input) && typeof row.input.id === 'string' && ulidPattern.test(row.input.id)
      ? factId(row.input.id) : null;
    if (rawTarget && !await factVisible(ports.readStorage, rawTarget) && !await factVisible(ports.readTeaching, rawTarget)) continue;
    pendingProposals.push({
      id: row.id,
      kind: 'other',
      commandType: row.type,
      status: 'pending',
      title: `待裁决提议 · ${row.type}`,
      summary: '等待学习者确认或拒绝',
      targetId: rawTarget,
      createdTick: row.created_tick,
      actions: {},
    });
  }

  for (const row of questionRows.rows) {
    const id = factId(row.id);
    try {
      const inspected = await inspectBankQuestion(ports.readBankQuestion, id);
      if (!inspected) continue;
      if (inspected.public.status !== 'draft' && inspected.public.status !== 'needs_verification') continue;
      pendingProposals.push({
        id: inspected.public.id,
        kind: 'question_draft',
        commandType: 'content.questionDraft',
        status: 'pending',
        title: `题库草稿 · ${inspected.public.title}`,
        summary: inspected.public.status === 'draft' ? '题目尚未补齐作答与评阅契约' : '题目待独立验收后方可入卷',
        targetId: inspected.public.id,
        createdTick: row.created_tick,
        actions: { inspect: { method: 'GET', path: '/api/iqdb/questions' } },
      });
    } catch (error) {
      if (!unavailable(error) && !(error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。')) throw error;
    }
  }

  for (const row of metaDraftRows.rows) {
    if (!row.question_id || !ulidPattern.test(row.question_id)) continue;
    const draft = await openFact(ports.readStorage, factId(row.id));
    const question = draft ? await openFact(ports.readStorage, factId(row.question_id)) : undefined;
    if (!draft || !question) continue;
    const title = isObject(question.value) && typeof question.value.title === 'string' ? question.value.title : question.ref.id;
    pendingProposals.push({
      id: draft.ref.id,
      kind: 'question_meta',
      commandType: questionMetaDraftType,
      status: 'pending',
      title: `题目草稿元数据 · ${title}`,
      summary: '待学习者确认题目元数据草稿',
      targetId: question.ref.id,
      createdTick: row.created_tick,
      actions: {},
    });
  }

  pendingProposals.sort((left, right) => compareTickDesc(left.createdTick, right.createdTick) || right.id.localeCompare(left.id));
  return { asOf, running, handoffs, recentTools, usage, pendingProposals };
}

export function projectTurnToolSummary(input: {
  readonly turnId: FactId;
  readonly sessionId: FactId;
  readonly caseId: string;
  readonly classroom?: boolean;
  readonly value: unknown;
  readonly manifestFactIds: readonly string[];
  readonly projectTrace: (entry: string) => string;
}): AuthorizedTurnToolView | undefined {
  if (!isObject(input.value)) return undefined;
  const { action, model, reportedModel, trace, evidenceIds, reads, writes, workspaceBasis } = input.value;
  if (action === 'reply_unavailable') return undefined;
  const tools = Array.isArray(trace)
    ? trace.filter((item): item is string => typeof item === 'string').map(input.projectTrace)
    : [];
  const basisSet = new Set<string>(input.manifestFactIds);
  if (Array.isArray(evidenceIds)) for (const id of evidenceIds) if (typeof id === 'string') basisSet.add(id);
  if (Array.isArray(reads)) for (const item of reads) if (isObject(item) && typeof item.id === 'string') basisSet.add(item.id);
  if (Array.isArray(workspaceBasis)) for (const item of workspaceBasis) if (isObject(item) && typeof item.id === 'string') basisSet.add(item.id);
  const writeCount = Array.isArray(writes) ? writes.length : 0;
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    caseId: input.caseId,
    model: typeof reportedModel === 'string' && reportedModel ? reportedModel : typeof model === 'string' ? model : 'unknown',
    tools,
    toolCount: tools.length,
    basisCount: basisSet.size,
    writeCount,
    href: input.classroom ? `/classroom/${input.sessionId}` : `/companion?session=${input.sessionId}`,
  };
}

export function projectRetentionHandoff(item: {
  readonly id: string;
  readonly kind: 'forecast' | 'reconciliation';
  readonly status?: string;
  readonly itemId: string;
  readonly effectiveTick: Tick;
  readonly evidence: readonly unknown[];
  readonly href: string;
}): AiHandoffItem {
  const isReconciliation = item.kind === 'reconciliation';
  return {
    id: item.id,
    channel: 'retention',
    status: isReconciliation ? item.status ?? 'observed' : 'ready',
    title: isReconciliation ? `保持对账 · ${item.itemId}` : `保持预测 · ${item.itemId}`,
    summary: isReconciliation ? `对账状态：${item.status ?? 'observed'}` : '已冻结保持预测等待后测验证',
    tick: item.effectiveTick,
    basisCount: item.evidence.length,
    href: item.href,
  };
}
