import type { Json } from '@mangekyo/kernel';
import type { TriageSkillId, TriageTier, TriageTodoTemplate } from './research-triage-response.ts';

export type { TriageTier, TriageTodoTemplate } from './research-triage-response.ts';

export type TriageSkillCard = {
  readonly id: TriageSkillId;
  readonly when: readonly string[];
  readonly whenNot: readonly string[];
  readonly mustCheck: readonly string[];
  readonly todoTemplate: TriageTodoTemplate;
  readonly examples: {
    readonly positive: readonly [string, string];
    readonly negative: string;
  };
};

function template(
  id: TriageSkillCard['id'],
  trigger: TriageTodoTemplate['trigger'],
  workerProfile: TriageTodoTemplate['workerProfile'],
  autonomyTier: TriageTier,
  templateFields: Omit<TriageTodoTemplate, 'dedupKey' | 'trigger' | 'workerProfile' | 'autonomyTier'>,
): TriageTodoTemplate {
  return {
    dedupKey: `triage:${id}`,
    trigger,
    workerProfile,
    autonomyTier,
    ...templateFields,
  };
}

export const remediateMisconception: TriageSkillCard = {
  id: 'remediate_misconception',
  when: [
    '同一稳定错因或同一知识点出现至少两次当前有效作答证据。',
    '当前库存、在途 Todo 或待审提议中没有覆盖该错因的可用材料。',
    '触发信号来自作答提交、整卷提交或完工回执，而不是用户撤回。',
  ],
  whenNot: [
    '只有一次孤立错误，或错误已被本人更正/撤回。',
    '已有 matching inventory/material 或相同 dedup_key 的未完 Todo。',
    '需要跨多份原卷、跨学科或高影响教学判断时，改用 deep_analyst。',
  ],
  mustCheck: [
    'source_fact_rev、access_epoch、purpose、retracted_rev 与 freshness。',
    'learner_overview 的错因/掌握度摘要、库存看板和在途 Todo。',
    '是否已有同错因库存或未完 Todo，确认没有现成库存后才 emit_todo。',
  ],
  todoTemplate: template(
    'remediate_misconception',
    { kind: 'immediate' },
    'heavy_tutor_prep',
    2,
    {
      goal: '备一份针对该错因的最小补救材料或变式练习。',
      refs: ['misconception_id', 'knowledge_point_ids', 'latest_attempt_refs'],
      sourceFactRev: 'latest_valid_attempt_fact_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '同一分段行程错因连续两次出现在有效作答中，库存为空。',
      'emit_todo(remediate_misconception, immediate, heavy_tutor_prep, tier=2)。',
    ],
    negative: '只错了一次，且 learner_overview 已有可用补救库存；应 noop 或 search_workspace。',
  },
};

export const preemptiveForgettingPrep: TriageSkillCard = {
  id: 'preemptive_forgetting_prep',
  when: [
    '自研遗忘/保持预测显示知识点将在未来 24–48 小时内跌破保持阈值。',
    '快照含具体保持预测队列、目标窗口和可用库存水位。',
    '没有同知识点的 pending scheduled Todo 或同等复习库存。',
  ],
  whenNot: [
    '预测只是泛化风险，没有具体知识点、时间窗或阈值依据。',
    '已有 scheduled Todo、今日安排锁定项或现成复习材料。',
    '用户刚表达疲劳、撤回或要求推迟；先处理 defer/cancel。',
  ],
  mustCheck: [
    'forecast slot 的 prediction_id、knowledge_point_id、predicted_crossing_at、confidence。',
    'schedule/goal 中的锁定与 DDL，确认提前 6–12h 的窗口可用。',
    '库存与在途 Todo；无现成库存时才允许发 scheduled Todo。',
  ],
  todoTemplate: template(
    'preemptive_forgetting_prep',
    { kind: 'scheduled', ref: 'snapshot.forecast.predicted_crossing_at_minus_6_to_12h' },
    'deterministic_compute',
    1,
    {
      goal: '到点前备一份低负担复测或保持检查，不自动改正式学习承诺。',
      refs: ['forecast_id', 'knowledge_point_id', 'inventory_refs'],
      sourceFactRev: 'forecast_fact_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '椭圆参数方程保持预测 30 小时后跌破阈值，且没有同点复习 Todo。',
      'emit_todo(preemptive_forgetting_prep, scheduled, deterministic_compute, tier=1)。',
    ],
    negative: '预测窗口为空，或已有同知识点 scheduled Todo；应 noop 或 update 现有 Todo。',
  },
};

export const deferOrCancelOnFatigueOrUndo: TriageSkillCard = {
  id: 'defer_or_cancel_on_fatigue_or_undo',
  when: [
    '用户在前台对话或近期信号中明确表达疲劳、焦虑、没兴趣或要求暂停。',
    '用户撤回、拒绝、删除或更正了同类待办、教材、提议或库存产物。',
    '目标被提前掌握、考试改期或本人锁定/状态使旧待办明显过时。',
  ],
  whenNot: [
    '撤回对象只是旧修订历史，当前有效版本仍可用。',
    '疲劳信号没有作用范围或绝对失效时刻，且不影响当前 Todo。',
    '需要新建补救或重排计划；本卡只做撤回、推迟、取消与简短说明。',
  ],
  mustCheck: [
    'user_signal 的 scope、expires_at、撤回/拒绝命令回执。',
    '在途 Todo 的 dedup_key、trigger、source_fact_rev、autonomy_tier。',
    '相关事实 current_rev、retracted_rev、access_epoch 与 inventory 可用性。',
  ],
  todoTemplate: template(
    'defer_or_cancel_on_fatigue_or_undo',
    { kind: 'event', ref: 'user_signal_or_undo_receipt' },
    'deep_analyst',
    3,
    {
      goal: '撤回或推迟受影响 Todo，并把需要本人确认的边界交给 escalate_to_user。',
      refs: ['signal_id', 'todo_ids', 'fact_refs', 'receipt_refs'],
      sourceFactRev: 'latest_signal_or_receipt_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '用户说今天太累，并撤回了刚生成的同类讲义提议；在途 Todo 仍指向该产物。',
      'update_or_cancel_todo(cancel/defer matched todos) 或 escalate_to_user(tier=3)。',
    ],
    negative: '撤回的是历史旧版本，当前修订仍有效且无在途依赖；不应取消。',
  },
};

export const examOrGoalShiftReplan: TriageSkillCard = {
  id: 'exam_or_goal_shift_replan',
  when: [
    '前台对话出现考试改期、新目标、范围变化、DDL 变化或本人明确锁定改变。',
    '快照中目标/时间/锁定与现有 Todo、库存或今日安排明显不一致。',
    '变化来自本人声明或已确认命令回执，而不是模型猜测。',
  ],
  whenNot: [
    '只是一次普通作答错误，没有目标、时间或范围变化。',
    '目标变化还停留在提议或未确认状态，不能当作已生效事实。',
    '只需要撤回单个过时 Todo；优先用 defer/cancel 卡。',
  ],
  mustCheck: [
    'goal/target fact 的 current_rev、locked、valid_from、expires_at。',
    '所有 active Todo、库存、今日安排与待审提议的引用。',
    '是否有冲突需要本人确认；战略路线或超出授权必须 escalate_to_user。',
  ],
  todoTemplate: template(
    'exam_or_goal_shift_replan',
    { kind: 'immediate' },
    'deep_analyst',
    4,
    {
      goal: '按新目标/时间/范围重排计划，清理过时 Todo，并列出需要本人确认的冲突。',
      refs: ['goal_fact_ids', 'active_todo_ids', 'inventory_refs', 'proposal_ids'],
      sourceFactRev: 'latest_goal_or_schedule_fact_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '本人确认考试从 12 月改到 1 月，且旧复习 Todo 与库存仍按 12 月排。',
      'emit_todo(exam_or_goal_shift_replan, immediate, deep_analyst, tier=4)。',
    ],
    negative: '只是在问一道错题，没有目标或时间事实变化；不应触发重排。',
  },
};

export const chainPostWorkFollowup: TriageSkillCard = {
  id: 'chain_post_work_followup',
  when: [
    '强力 Agent、专项执行者或确定性任务已完工并写回事实与 1 句 Digest。',
    'Digest 显示结果可用、部分可用或需要下一跳验证/接力。',
    '同一 chain_id 的 hop_count 未达到硬顶，且周期预算未耗尽。',
  ],
  whenNot: [
    '完工结果只是重复旧回执，没有新的事实、库存或学习者可见变化。',
    '结果需要本人确认、隐私外发、费用上限或不可逆操作；先 escalate。',
    'hop_count 已达上限或 budget_cap 不足；应 noop 并保留 Digest。',
  ],
  mustCheck: [
    'work_completed event 的 work_id、slot_type、slot_key、digest、settled effects。',
    'source_fact_rev、chain_id、hop_count、budget_cap 与库存水位。',
    '是否存在更合适的下一跳卡；没有明确下一步就 noop。',
  ],
  todoTemplate: template(
    'chain_post_work_followup',
    { kind: 'event', ref: 'work_completed' },
    'deterministic_compute',
    2,
    {
      goal: '评估是否挂下一跳 event/scheduled 验收 Todo；没有明确下一步则 noop。',
      refs: ['completed_work_ref', 'digest_fact_refs', 'next_candidate_refs'],
      sourceFactRev: 'completion_receipt_fact_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '补救备课 Todo 完工，Digest 显示新材料已入库，下一步是安排一次低负担验证。',
      'emit_todo(chain_post_work_followup, event=on_work_completed, deterministic_compute, tier=2)。',
    ],
    negative: '完工只是重复回执，hop_count 已到上限；应 noop，不再链式拉起。',
  },
};

export const escalateAmbiguousDeepCase: TriageSkillCard = {
  id: 'escalate_ambiguous_deep_case',
  when: [
    '需要翻阅多份原卷、跨学科材料、长链证据或高影响教学权衡。',
    '快照不足以稳定判断，且浅层窥视已达到单次唤醒上限。',
    '问题不属于单一 Skill 的明确触发，或 Tier 4 需要本人确认。',
  ],
  whenNot: [
    '能用当前快照和一张 Skill 卡直接完成 emit/update/cancel/noop。',
    '只是缺一个 ID；先 inspect_event/search_workspace/read_recent_experience。',
    '前哨可以凭经验猜答案；不确定时必须派 deep_analyst 或 escalate_to_user。',
  ],
  mustCheck: [
    '当前快照缺口：缺哪个 event_id、material、attempt、goal 或 inventory。',
    '是否已用完两次浅层窥视；深翻多份材料必须派 Todo。',
    '是否涉及 Tier 4：战略路线、隐私外发、费用上限或不可逆操作。',
  ],
  todoTemplate: template(
    'escalate_ambiguous_deep_case',
    { kind: 'immediate' },
    'deep_analyst',
    4,
    {
      goal: '只收集证据并给出分诊建议；不在前哨内完成深度教学推理。',
      refs: ['ambiguous_event_refs', 'material_refs', 'attempt_refs', 'question_refs'],
      sourceFactRev: 'latest_relevant_fact_rev',
      budgetCap: 'snapshot.budget.remaining',
      chainId: 'snapshot.chain.current_or_new',
      hopCount: 'snapshot.chain.hop_count_plus_one',
    },
  ),
  examples: {
    positive: [
      '用户同时提到两个学科的冲突目标，需要比较三份原卷和历史帮助曝光。',
      'emit_todo(escalate_ambiguous_deep_case, immediate, deep_analyst, tier=4)。',
    ],
    negative: '快照已明确显示同一错因重复且无库存；应直接用 remediate 卡，不派 deep_analyst。',
  },
};

export const triageSkillCards: readonly TriageSkillCard[] = [
  remediateMisconception,
  preemptiveForgettingPrep,
  deferOrCancelOnFatigueOrUndo,
  examOrGoalShiftReplan,
  chainPostWorkFollowup,
  escalateAmbiguousDeepCase,
];

export const triageSkillById = new Map(triageSkillCards.map((card) => [card.id, card]));

export function selectTriageCards(wakeSource: string): readonly TriageSkillCard[] {
  const source = wakeSource.trim();
  const selected = new Set<TriageSkillCard['id']>(['defer_or_cancel_on_fatigue_or_undo']);
  if (/attempt|submit|submission|work_completed|completed|digest|grading|grade/i.test(source)) {
    selected.add('remediate_misconception');
    selected.add('chain_post_work_followup');
  }
  if (/forecast|forgetting|decay|review|memory|保持|遗忘|复习/i.test(source)) {
    selected.add('preemptive_forgetting_prep');
  }
  if (/goal|exam|ddl|target|schedule|计划|考试|目标|改期/i.test(source)) {
    selected.add('exam_or_goal_shift_replan');
  }
  if (/undo|retract|reject|withdraw|撤回|撤销|拒绝|删除|更正/i.test(source)) {
    selected.add('defer_or_cancel_on_fatigue_or_undo');
  }
  if (/ambiguous|deep|multi|跨|多份|原卷|unclear|不确定/i.test(source)) {
    selected.add('escalate_ambiguous_deep_case');
  }
  if (selected.size < 2) selected.add('chain_post_work_followup');
  return triageSkillCards.filter((card) => selected.has(card.id)).slice(0, 3);
}

export function triagePromptBlock(wakeSource: string): Json {
  return {
    wake_source: wakeSource,
    cards: selectTriageCards(wakeSource).map((card) => ({
      id: card.id,
      when: card.when,
      when_not: card.whenNot,
      must_check: card.mustCheck,
      todo_template: card.todoTemplate,
      examples: card.examples,
    })),
    output_contract: {
      single_json: true,
      required_fields: ['matched_skill', 'reason_brief', 'actions', 'memo_table', 'next_recheck_hint'],
      actions_max: 4,
      ids: 'copy_from_snapshot_only',
      expressions: 'forbidden',
    },
  };
}
