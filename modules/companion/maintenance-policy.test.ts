import { describe, expect, it } from 'vitest';
import { indexRecordFlowSnapshot } from '@mangekyo/module-learner/facts/record-flow';
import {
  buildMaintenanceContext,
  extractMaintenanceInputFromFlow,
  planMaintenanceActions,
  type MaintenanceBuildInput,
  type MaintenanceConceptInput,
} from './maintenance-policy.ts';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const mkConcept = (id: string, overrides: Partial<MaintenanceConceptInput> = {}): MaintenanceConceptInput => ({
  id,
  title: `概念-${id}`,
  summary: '已有摘要',
  masteryLevel: 'developing',
  attemptCount: 0,
  errorStages: [],
  ...overrides,
});

const baseInput = (overrides: Partial<MaintenanceBuildInput> = {}): MaintenanceBuildInput => ({
  currentDate: '2026-11-24',
  nowMs: NOW,
  lastRunAtMs: NOW - 40 * 60_000,
  lastRunTick: '10',
  latestSignalTick: '10',
  concepts: [
    mkConcept('c-solid', { masteryLevel: 'solid', attemptCount: 3 }),
    mkConcept('c-nosum', { summary: '' }),
    mkConcept('c-iso', { masteryLevel: 'unknown' }),
    mkConcept('c-weak', { masteryLevel: 'fragile', attemptCount: 1 }),
    mkConcept('c-err', { masteryLevel: 'fragile', attemptCount: 2, errorStages: ['modeling'] }),
  ],
  edges: [
    { fromId: 'c-solid', toId: 'c-weak', kind: 'prereq_of' },
    { fromId: 'c-nosum', toId: 'c-err', kind: 'related_to' },
  ],
  recentSignals: [
    { id: 's-1', kind: 'attempt', title: '力学卷', excerpt: '有 1 道错题', tick: '10' },
  ],
  ...overrides,
});

describe('modules/companion/maintenance-policy (Track AO-2A)', () => {
  it('gates triggers strictly on carePaused, empty concepts, cooldowns, new signals, and idle backlog', () => {
    expect(buildMaintenanceContext(baseInput({ carePaused: true }))).toBeNull();
    expect(buildMaintenanceContext(baseInput({ concepts: [] }))).toBeNull();

    // No new signal + within 30m idle cooldown -> null (zero burn).
    expect(buildMaintenanceContext(baseInput({ lastRunAtMs: NOW - 10 * 60_000 }))).toBeNull();

    // New signal within 5m min cooldown -> still null; after 6m -> triggers new_signal.
    expect(buildMaintenanceContext(baseInput({
      lastRunAtMs: NOW - 2 * 60_000,
      latestSignalTick: '15',
      recentSignals: [{ id: 's-new', kind: 'misconception', title: '新错因', excerpt: '受力漏画', tick: '15' }],
    }))).toBeNull();
    const onSignal = buildMaintenanceContext(baseInput({
      lastRunAtMs: NOW - 6 * 60_000,
      latestSignalTick: '15',
      recentSignals: [{ id: 's-new', kind: 'misconception', title: '新错因', excerpt: '受力漏画', tick: '15' }],
    }));
    expect(onSignal?.trigger).toBe('new_signal');
    // Priority ordering: errorStages > fragile > isolated > missing summary > solid.
    expect(onSignal?.concepts.map((c) => c.id)).toEqual(['c-err', 'c-weak', 'c-iso', 'c-nosum', 'c-solid']);

    // Idle cruise after 30m with backlog -> triggers idle_cruise; clean solid connected graph (even missing summary) -> null.
    expect(buildMaintenanceContext(baseInput())?.trigger).toBe('idle_cruise');
    expect(buildMaintenanceContext(baseInput({
      concepts: [mkConcept('c1', { masteryLevel: 'solid', summary: '' }), mkConcept('c2', { masteryLevel: 'solid' })],
      edges: [{ fromId: 'c1', toId: 'c2', kind: 'prereq_of' }],
    }))).toBeNull();
  });

  it('enforces anti-hallucination, dedup, self-loop removal, <=3 edge cap, and traceable idempotent prepNote', () => {
    const context = buildMaintenanceContext(baseInput())!;
    const conceptUses = new Map([
      ['c-err', { id: 'c-err', rev: 2, accessEpoch: '5' }],
      ['c-weak', { id: 'c-weak', rev: 3, accessEpoch: '6' }],
      ['c-iso', { id: 'c-iso', rev: 1, accessEpoch: '1' }],
      ['c-nosum', { id: 'c-nosum', rev: 1, accessEpoch: '2' }],
      ['c-solid', { id: 'c-solid', rev: 4, accessEpoch: '7' }],
    ]);

    const noop = planMaintenanceActions(
      { shouldAct: false, rationale: '无需维护', suggestedEdges: [{ fromId: 'c-iso', toId: 'c-err', kind: 'prereq_of', rationale: 'ignored' }] },
      context,
    );
    expect(noop.shouldAct).toBe(false);
    expect(noop.edgeProposals).toEqual([]);

    const plan = planMaintenanceActions(
      {
        shouldAct: true,
        rationale: '补齐孤立概念关系并生成薄弱复盘备课单',
        suggestedEdges: [
          { fromId: 'ghost', toId: 'c-err', kind: 'prereq_of', rationale: '幻觉端点应丢弃' },
          { fromId: 'c-err', toId: 'c-err', kind: 'related_to', rationale: '自环应丢弃' },
          { fromId: 'c-solid', toId: 'c-weak', kind: 'prereq_of', rationale: '已有边应去重' },
          { fromId: 'c-iso', toId: 'c-err', kind: 'prereq_of', rationale: '前置关系 1' },
          { fromId: 'c-iso', toId: 'c-weak', kind: 'related_to', rationale: '相关关系 2' },
          { fromId: 'c-weak', toId: 'c-err', kind: 'prereq_of', rationale: '前置关系 3' },
          { fromId: 'c-nosum', toId: 'c-iso', kind: 'related_to', rationale: '超出 3 条上限应裁掉' },
        ],
        suggestedPrepNote: {
          title: '力学错因专项备课',
          focusConceptIds: ['c-weak', 'ghost', 'c-err', 'c-err'],
          summary: '聚焦建模阶段受力分析漏项',
          actionSteps: ['先画隔离体受力图', '复核正交分解方程'],
        },
      },
      context,
      { conceptUses },
    );

    expect(plan.shouldAct).toBe(true);
    expect(plan.edgeProposals).toHaveLength(3);
    expect(plan.edgeProposals[0]).toMatchObject({
      commandType: 'content.createKnowledgeEdge',
      fromId: 'c-iso',
      toId: 'c-err',
      kind: 'prereq_of',
      payload: {
        purpose: 'teaching',
        edge: {
          kind: 'prereq_of',
          from: { kind: 'concept', sourceUse: { id: 'c-iso', rev: 1, accessEpoch: '1' } },
          to: { kind: 'concept', sourceUse: { id: 'c-err', rev: 2, accessEpoch: '5' } },
        },
      },
    });
    expect(plan.prepNote).toEqual({
      dedupKey: 'maintenance-prep:2026-11-24:c-err,c-weak',
      title: '力学错因专项备课',
      focusConceptIds: ['c-err', 'c-weak'],
      basis: [
        { id: 'c-err', rev: 2, accessEpoch: '5' },
        { id: 'c-weak', rev: 3, accessEpoch: '6' },
      ],
      summary: '聚焦建模阶段受力分析漏项',
      actionSteps: ['先画隔离体受力图', '复核正交分解方程'],
    });
    expect(plan.rejectedCount).toBe(5);
  });

  it('extracts maintenance context directly from FlowGraphSnapshot with zero glue', () => {
    const c1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const c2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const snap = indexRecordFlowSnapshot([
      { id: c1, type: 'content.asset', rev: 1, author: 'companion', createdTick: '20', data: { kind: 'concept', title: '动量守恒' } },
      { id: c2, type: 'content.asset', rev: 1, author: 'companion', createdTick: '21', data: { kind: 'concept', title: '冲量定理' } },
    ], []);
    const input = extractMaintenanceInputFromFlow(snap, { currentDate: '2026-11-24', nowMs: NOW, lastRunAtMs: null });
    const ctx = buildMaintenanceContext(input);
    expect(ctx?.trigger).toBe('new_signal');
    expect(ctx?.concepts.map((c) => c.id).sort()).toEqual([c1, c2]);
    expect(ctx?.recentSignals).toHaveLength(2);
  });

  it('excludes D10 carePause crisis turns from maintenance recentSignals and latestSignalTick', () => {
    const c1 = '01ARZ3NDEKTSV4RRFFQ69G5FE1', c2 = '01ARZ3NDEKTSV4RRFFQ69G5FE2', tCrisis = '01ARZ3NDEKTSV4RRFFQ69G5FE3';
    const snap = indexRecordFlowSnapshot([
      { id: c1, type: 'content.asset', rev: 1, author: 'companion', createdTick: '10', data: { kind: 'concept', title: 'A', summary: 'ok' } },
      { id: c2, type: 'content.asset', rev: 1, author: 'companion', createdTick: '10', data: { kind: 'concept', title: 'B', summary: 'ok' } },
      { id: '01ARZ3NDEKTSV4RRFFQ69G5FE4', type: 'content.knowledgeEdge', rev: 1, author: 'companion', createdTick: '10', data: { kind: 'prereq_of', from: { kind: 'concept', sourceUse: { id: c1 } }, to: { kind: 'concept', sourceUse: { id: c2 } } } },
      { id: tCrisis, type: 'activity.studyTurn', rev: 1, author: 'learner', createdTick: '99', data: { sessionId: tCrisis, answer: '绝不送给后台LLM的危机原话' } },
    ], [{ id: 'd-c', slotType: 'activity.teachingFeedback', slotKey: tCrisis, value: { message: '危机支持', carePause: { active: true } } }]);
    const input = extractMaintenanceInputFromFlow(snap, { currentDate: '2026-11-24', nowMs: NOW, lastRunAtMs: NOW - 10 * 60_000, lastRunTick: '10' });
    expect(input.recentSignals.some((s) => s.id === tCrisis || s.excerpt.includes('危机原话'))).toBe(false);
    expect({ tick: input.latestSignalTick, ctx: buildMaintenanceContext(input) }).toEqual({ tick: '10', ctx: null });
  });
});
