import { randomUUID } from 'node:crypto';
import { studioHost } from './fact-read-helpers.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandId, createCommandReadContext, createLearnerHost, factId, isFactNotFound, listActiveFactsByTypes, stableId,
  type CommandHooks, type CommandReceipt, type Db, type FactId, type FactReadOptions, type Json, type ReadTransaction,
  type Revision } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordCompletedEffect } from '../../kernel/src/work/index.ts';
import { buildManualOnboardingProposal, buildOnboardingCompanionMemo, parseOnboardingInput,
  parseOnboardingProposal, planRulePayloadsFromProposal, type OnboardingConcept,
  type OnboardingDiscipline } from '../../modules/plan/onboarding.ts';
import { setStudyGoal } from '../../modules/plan/goal-values.ts';
import { openKnowledgeName } from '../../modules/content/knowledge-entity.ts';
import { configureResearch, researchPurpose } from '../../modules/companion/research.ts';
import { readJsonConfig, writeJsonConfig } from '../../executors/teaching/local-config.ts';
import { autoAuthorizeActiveRoute, defaultStored as defaultWorkspaceAccess,
  normalizeStored as normalizeWorkspaceAccess } from '../../executors/teaching/workspace-provider-grants.ts';
import { OnboardingAgentError, proposeOnboardingWithAgent, type OnboardingAgentResult } from '../../executors/teaching/onboarding-agent.ts';
import { purpose, studioLearner } from './identity.ts';
import { memoryId } from './memory.ts';
import { settingsId as researchSettingsId } from './research-sources.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { loadSettings, type ProviderSettings } from './settings.ts';
type Options = { hooks?: CommandHooks; loadProvider?: () => Promise<ProviderSettings>; agent?: typeof proposeOnboardingWithAgent;
  now?: () => Date; authorizeModel?: () => Promise<void> };
type Modules = { plan: LoadedModule; content: LoadedModule; companion: LoadedModule };
type Use = { id: FactId; rev: Revision; accessEpoch: string };
type ApplyResult = { goalId: string; ruleCount: number; disciplineCount: number; conceptCount: number;
  skippedExistingConcepts: number; edgeCount: number; questionCount: number; memoryUpdated: boolean };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const day = (now: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
const id = (requestId: string, scope: string, key = '') => factId(stableId('onboarding', requestId, scope, key));
const use = (receipt: CommandReceipt, fallback: FactId): Use => ({ id: fallback,
  rev: receipt.wrote.find(ref => ref.id === fallback)?.rev ?? (1 as Revision), accessEpoch: '0' });
const parseInput = (raw: unknown, date: string, zoneName: string) => {
  try { return parseOnboardingInput(raw, date, zoneName); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '冷启动配置无效。'); }
};
const parseProposal = (raw: unknown) => {
  try { return parseOnboardingProposal(raw); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '冷启动配置无效。'); }
};
const readFact = (tx: ReadTransaction, fact: FactId, options: FactReadOptions, asPurpose = purpose) =>
  createCommandReadContext(tx, asPurpose).fact(fact, options);
const defaultAuthorizeModel = (loadProvider: () => Promise<ProviderSettings>) => async () => {
  const full = await loadProvider().catch(() => undefined);
  if (!full?.baseUrl) return;
  const accessPath = process.env.MANGEKYO_WORKSPACE_ACCESS_FILE || join(homedir(), '.config', 'mangekyo', 'workspace-access.json');
  const stored = await readJsonConfig(accessPath, defaultWorkspaceAccess, normalizeWorkspaceAccess);
  const next = autoAuthorizeActiveRoute(full, stored, randomUUID());
  if (next.changed) await writeJsonConfig(accessPath, next.stored);
};
export function openOnboarding(db: Db, modules: Modules, options: Options = {}) {
  const host = studioHost(db), hooks = options.hooks ?? createStudioCommandHooks(),
    send = host.boundHandler([modules.plan, modules.content, modules.companion], hooks);
  const loadProvider = options.loadProvider ?? (() => loadSettings()), agent = options.agent ?? proposeOnboardingWithAgent,
    now = options.now ?? (() => new Date()), authorizeModel = options.authorizeModel ?? defaultAuthorizeModel(loadProvider);
  const status = async () => {
    const counts = await host.snapshot(async tx => {
      const count = async (type: string, byPurpose = 'storage') =>
        (await listActiveFactsByTypes(tx, { types: [type], purpose: byPurpose, limit: 500 })).rows.length;
      const { rows } = await tx.query<{ kind: string; total: number }>(`SELECT r.data->>'kind' AS kind, count(*)::int AS total
        FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
        WHERE f.learner_id=$1 AND f.type='content.asset' AND f.retracted_rev IS NULL AND r.kind='value'
          AND f.purpose && ARRAY['storage','all']::text[] AND r.data->>'kind' = ANY($2::text[]) GROUP BY 1`, [tx.learner,
        ['discipline', 'concept', 'question']]);
      const found = Object.fromEntries(rows.map(({ kind, total }) => [kind, total]));
      const { rows: [goal] } = await tx.query<{ text: string | null; total: number }>(
        `SELECT (SELECT r.data->>'text' FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
          WHERE f.learner_id=$1 AND f.type='activity.studyGoal' AND f.retracted_rev IS NULL AND r.kind='value'
            AND f.purpose && ARRAY['storage','all']::text[] ORDER BY r.tick DESC, f.id DESC LIMIT 1) AS text,
          (SELECT count(*)::int FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
            WHERE f.learner_id=$1 AND f.type='plan.rule' AND f.retracted_rev IS NULL AND r.kind='value'
              AND f.purpose && ARRAY['storage','all']::text[] AND r.data->>'kind'='exam') AS total`, [tx.learner]);
      return { goals: await count('activity.studyGoal'), memories: await count('companion.memory', purpose), disciplines:
        found.discipline ?? 0, concepts: found.concept ?? 0, questions: found.question ?? 0,
        goalText: goal?.text ?? '', upcomingExamCount: Number(goal?.total ?? 0) };
    });
    const timeZone = zone(), provider = await loadProvider().catch(() => undefined);
    return { needsOnboarding: !counts.goals && !counts.disciplines && !counts.concepts, completed:
      counts.goals > 0 || counts.disciplines > 0 || counts.concepts > 0, hasGoal: counts.goals > 0,
      hasDisciplines: counts.disciplines > 0, hasConcepts: counts.concepts > 0, hasQuestions: counts.questions > 0,
      hasMemory: counts.memories > 0, hasModel: Boolean(provider?.baseUrl), currentDate: day(now(), timeZone), timeZone,
      goalText: counts.goalText, disciplineCount: counts.disciplines, conceptCount: counts.concepts,
      questionCount: counts.questions, upcomingExamCount: counts.upcomingExamCount, counts };
  };
  async function propose(rawBody: Record<string, unknown>) {
    const at = now(), timeZone = zone(), input = parseInput(rawBody, day(at, timeZone), timeZone);
    if (input.mode === 'offline_manual') return { proposal: buildManualOnboardingProposal(input), mode: 'offline_manual' };
    const provider = await loadProvider().catch(() => undefined);
    if (!provider?.baseUrl) throw new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型或使用离线手动配置。', 'model_unavailable');
    const requestId = rawBody.requestId === undefined ? `onboard-${randomUUID()}` : clientRequest(rawBody.requestId);
    const result = await agent(input, { provider, requestId }).catch(error => {
      if (!(error instanceof OnboardingAgentError)) throw error;
      throw new RequestError(error.code === 'model_unavailable' ? 503 : error.code === 'timeout' ? 504 : 502, error.message, error.code);
    }) as OnboardingAgentResult;
    const proposal = parseProposal(result.proposal), effect = { ownerKind: 'session' as const, ownerId: `onboarding:${requestId}`, stepKey: 'onboarding-setup',
      label: 'onboarding-setup', providerEffectId: `onboarding:${requestId}`, input: { requestId, currentDate: input.currentDate, timeZone: input.timeZone, mode: 'llm' },
      result: { model: result.usage.model, durationMs: result.usage.durationMs, route: 'onboarding-setup',
        ...(result.usage.reportedModel ? { reportedModel: result.usage.reportedModel } : {}),
        ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }) } };
    await host.tx(tx => tx.withLearnerWrite(tick => recordCompletedEffect(tx, tick, effect)));
    return { proposal };
  }
  const apply = (rawBody: Record<string, unknown>) => applyProposal(rawBody, send, run => host.snapshot(run), authorizeModel);
  return { status, propose, apply };
}
type Snapshot = <T>(run: (tx: ReadTransaction) => Promise<T>) => Promise<T>;
type Send = (command: { purpose: string; type: string; id: ReturnType<typeof commandId>; input: Json }) => Promise<CommandReceipt>;
async function applyProposal(rawBody: Record<string, unknown>, send: Send, snapshot: Snapshot, authorizeModel: () => Promise<void>):
  Promise<{ ok: true; applied: ApplyResult; links: Record<string, string> }> {
  const requestId = clientRequest(rawBody.requestId), proposal = parseProposal(rawBody.proposal), goalId = id(requestId, 'goal');
  const run = (type: string, key: string | number, input: Json, commandPurpose = purpose) => send({
    purpose: commandPurpose, type, id: commandId(stableId('onboarding-command', requestId, type, String(key))), input });
  const disciplines = new Map<string, Use>(), concepts = new Map<string, Use>(),
    applied: ApplyResult = { goalId, ruleCount: 0, disciplineCount: 0, conceptCount: 0,
      skippedExistingConcepts: 0, edgeCount: 0, questionCount: 0, memoryUpdated: true };
  await run(setStudyGoal, 'goal', { id: goalId, data: { text: proposal.studyPlan.goalText, status: 'active' } }, 'storage');
  for (const [index, rule] of planRulePayloadsFromProposal(proposal).entries()) {
    const receipt = await run('plan.saveRule', `rule:${index}`,
      { id: id(requestId, 'rule', String(index)), expectedRev: null, data: rule }, 'storage');
    if (receipt.wrote.length) applied.ruleCount += 1;
  }
  const discipline = async (input: OnboardingDiscipline, index: number) => {
    const fact = id(requestId, 'discipline', input.key || String(index)), receipt = await run('content.saveDisciplineContext',
      `discipline:${input.key || index}`, { id: fact, purpose: ['storage', 'teaching'], title: input.title,
        discipline_context: { learningScope: input.learningScope, mastery: input.mastery,
          assessment: input.assessment, boundaries: input.boundaries } });
    if (receipt.wrote.length) applied.disciplineCount += 1;
    const opened = use(receipt, fact);
    disciplines.set(input.title, opened); disciplines.set(input.key, opened);
    return opened;
  };
  for (const [index, item] of proposal.disciplines.entries()) await discipline(item, index);
  if (!disciplines.size && proposal.knowledgeGraph.concepts.some(item => item.selected !== false)) {
    await discipline({ key: 'general', title: '初始学习语境', learningScope: '冷启动初始化学习范围',
      mastery: '按当前目标持续校准', assessment: ['学习者确认与后续作答表现'],
      boundaries: ['冷启动阶段不推断未提供的考试或教材范围'] }, 0);
    applied.disciplineCount = Math.max(0, applied.disciplineCount - 1);
  }
  const sourceFor = (concept: OnboardingConcept) => disciplines.get(concept.subject) ?? disciplines.values().next().value!;
  for (const [index, concept] of proposal.knowledgeGraph.concepts.entries()) {
    if (concept.selected === false) continue;
    const entityId = id(requestId, 'concept', concept.key || String(index)), source = sourceFor(concept);
    try {
      const receipt = await run('content.createKnowledgeEntity', `concept:${concept.key || index}`, { id: entityId,
        purpose, entity: { kind: 'concept', canonicalName: concept.title, aliases: [], merged_into: null },
        resolution: { decision: 'no-match', reason: `冷启动：${concept.summary || concept.semesterTag || concept.subject}`,
          candidates: [], sourceUses: [source] } });
      if (receipt.wrote.length) applied.conceptCount += 1;
      concepts.set(concept.key, use(receipt, entityId));
    } catch (error) {
      const existing = await snapshot(tx => openKnowledgeName({ fact: (entityId, opts) =>
        readFact(tx, entityId, opts) }, 'concept', concept.title)).catch(() => undefined);
      if (!existing) throw error;
      applied.skippedExistingConcepts += 1;
      concepts.set(concept.key, { id: existing.snapshot.ref.id, rev: existing.snapshot.ref.rev, accessEpoch: existing.snapshot.accessEpoch });
    }
  }
  for (const [index, edge] of proposal.knowledgeGraph.edges.entries()) {
    const from = concepts.get(edge.fromKey), to = concepts.get(edge.toKey);
    if (!from || !to) continue;
    const receipt = await run('content.createKnowledgeEdge', `edge:${index}`, { id: id(requestId, 'edge',
      `${edge.fromKey}:${edge.toKey}:${edge.kind}`), purpose, edge: { kind: edge.kind,
      scope: edge.rationale || '冷启动知识关系', from: { kind: 'concept', sourceUse: from },
      to: { kind: 'concept', sourceUse: to }, sourceUses: [from, to] } });
    if (receipt.wrote.length) applied.edgeCount += 1;
  }
  for (const [index, question] of proposal.starterQuestions.entries()) {
    if (question.selected === false) continue;
    const questionId = id(requestId, 'question', question.key || String(index));
    const receipt = await run('content.saveQuestion', `question:${question.key || index}`, { id: questionId, purpose,
      asset: { kind: 'question', title: question.title, promptBlockId: 'prompt',
        blocks: [{ id: 'prompt', parentId: null, body: { kind: 'text', text: question.prompt } },
          { id: 'answer', parentId: null, body: { kind: 'text', text: `参考答案：${question.answer}\n评分要点：${question.rubric}` } }] } });
    if (!receipt.wrote.length) continue;
    applied.questionCount += 1;
    const questionUse = use(receipt, questionId);
    for (const [key, concept] of question.conceptKeys.map(key => [key, concepts.get(key)] as const)
      .filter((entry): entry is readonly [string, Use] => Boolean(entry[1]))) {
      await run('content.createKnowledgeEdge', `targets:${question.key}:${key}`, { id: id(requestId, 'targets',
        `${question.key}:${key}`), purpose, edge: { kind: 'targets_concept', scope: `冷启动摸底：${question.difficulty}`,
        from: { kind: 'question', sourceUse: questionUse }, to: { kind: 'concept', sourceUse: concept },
        sourceUses: [questionUse, concept] } });
    }
  }
  const memo = buildOnboardingCompanionMemo(proposal);
  const currentMem = await snapshot(tx => readFact(tx, memoryId, { mode: 'following' })
    .then(fact => ({ rev: fact.ref.rev, text: typeof (fact.value as { text?: unknown })?.text === 'string' ? (fact.value as { text: string }).text : '' }))
    .catch(error => { if (isFactNotFound(error)) return { rev: 0, text: '' }; throw error; }));
  if (currentMem.text !== memo) {
    await run('companion.saveMemory', `memory:${currentMem.rev}`, { id: memoryId, revision: currentMem.rev, data: {
      text: memo, endpoint: 'onboarding', providerId: 'onboarding', protocol: 'openai' } });
  }
  const researchRev = await snapshot(tx => readFact(tx, researchSettingsId, { mode: 'following' }, researchPurpose).then(f => f.ref.rev)
    .catch(error => { if (isFactNotFound(error)) return 0; throw error; }));
  if (researchRev === 0) await run(configureResearch, 'research', { id: researchSettingsId, revision: 0, enabled: true }, researchPurpose).catch(() => {});
  await authorizeModel().catch(() => {});
  return { ok: true, applied,
    links: { today: '/today', graph: '/materials?tab=graph', bank: '/materials?tab=bank', companion: '/companion', me: '/me' } };
}
