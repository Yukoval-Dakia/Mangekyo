import type { Json } from '../../../kernel/src/declarations/types.ts';
import {
  remediateMisconception,
  preemptiveForgettingPrep,
  deferOrCancelOnFatigueOrUndo,
  examOrGoalShiftReplan,
  chainPostWorkFollowup,
  escalateAmbiguousDeepCase,
  type TriageSkillCard,
} from '../../../modules/companion/research-triage-cards.ts';

export type { TriageSkillCard, TriageTier, TriageTodoTemplate } from '../../../modules/companion/research-triage-cards.ts';

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
