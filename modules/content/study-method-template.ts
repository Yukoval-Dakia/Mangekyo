import { factId, type FactId, type StudyMethodStepKindWire, type StudyMethodStepWire, type StudyMethodTemplateWire } from '@mangekyo/kernel';
import { choice, compact, fields, jsonDeepEqual, key, list, record, requireIso, text } from './parse.ts';

export const studyMethodStepKinds = [
  'predict', 'try_first', 'worked_example', 'faded_example', 'counterexample',
  'teach_companion', 'independent_check', 'independent_transfer', 'self_explanation', 'reflection_summary',
] as const;
export const studyMethodAuthors = ['learner', 'companion', 'co_created'] as const;

export class StudyMethodInvariantError extends Error {
  constructor(message: string) { super(message); this.name = 'StudyMethodInvariantError'; }
}

export type StudyMethodStepKind = StudyMethodStepKindWire;
export type StudyMethodAuthor = StudyMethodTemplateWire['author'];
export type StudyMethodStep = StudyMethodStepWire;
export type StudyMethodTemplate = StudyMethodTemplateWire;
export type StudyMethodTemplateRevisionPatch = {
  readonly name?: string; readonly goal?: string; readonly disciplineTags?: readonly string[];
  readonly steps?: readonly StudyMethodStep[]; readonly observationRequirements?: readonly string[];
  readonly author?: StudyMethodAuthor;
};
export type StudyMethodPlanStepInstance = StudyMethodStep & { readonly stepIndex: number; readonly status: 'pending' };
export type StudyMethodPlanInstance = {
  readonly instanceId: string; readonly templateId: string; readonly templateVersion: number; readonly templateName: string;
  readonly goal: string; readonly targetConceptIds: readonly FactId[]; readonly instantiatedAtIso: string;
  readonly observationRequirements: readonly string[]; readonly steps: readonly StudyMethodPlanStepInstance[]; readonly frozen: true;
};

const undoTokenPattern = /^undo:method-template:/;
const instanceIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
function isStudyMethodUndoToken(value: string): value is NonNullable<StudyMethodTemplateWire['undoToken']> {
  return undoTokenPattern.test(value);
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正整数。`);
  return value;
}
function textList(value: unknown, label: string): readonly string[] {
  return Object.freeze(list(value).map(entry => text(entry, label)));
}
function parseStep(value: unknown, seenIds: Set<string>): StudyMethodStep {
  const row = record(value);
  fields(row, 'stepId', 'kind', 'title', 'promptHint', 'observationRequired', 'blocksSpoiler', 'maxMinutes');
  const stepId = key(row.stepId);
  if (seenIds.has(stepId)) throw new Error(`学法步骤标识重复：${stepId}。`);
  seenIds.add(stepId);
  const kind = choice(row.kind, studyMethodStepKinds, '学法步骤类型');
  const title = text(row.title, '学法步骤标题'), promptHint = text(row.promptHint, '学法步骤提示');
  if (typeof row.observationRequired !== 'boolean' || typeof row.blocksSpoiler !== 'boolean') throw new Error('学法步骤观测与防剧透开关须为布尔值。');
  if (row.maxMinutes !== undefined &&
      (typeof row.maxMinutes !== 'number' || !Number.isInteger(row.maxMinutes) || row.maxMinutes < 1 || row.maxMinutes > 120)) {
    throw new Error('学法步骤时长上限必须是 1..120 内的整数分钟。');
  }
  const maxMinutes = row.maxMinutes as number | undefined;
  return Object.freeze(compact({
    stepId, kind, title, promptHint, observationRequired: row.observationRequired,
    blocksSpoiler: row.blocksSpoiler, maxMinutes,
  }));
}

export function parseStudyMethodTemplate(input: unknown): StudyMethodTemplate {
  const row = record(input);
  fields(row, 'templateId', 'version', 'name', 'goal', 'disciplineTags', 'steps', 'observationRequirements', 'author', 'replacesVersion', 'undoToken');
  const templateId = key(row.templateId), version = positiveInt(row.version, '学法模板版本');
  const name = text(row.name, '学法模板名称'), goal = text(row.goal, '学法模板目标');
  const disciplineTags = textList(row.disciplineTags, '学科标签');
  const observationRequirements = textList(row.observationRequirements, '观测要求');
  const author = choice(row.author, studyMethodAuthors, '学法模板作者');
  let replacesVersion: number | undefined;
  if (row.replacesVersion !== undefined) {
    replacesVersion = positiveInt(row.replacesVersion, '替代版本');
    if (replacesVersion >= version) throw new Error('替代版本必须严格小于当前版本号。');
  }
  let undoToken: StudyMethodTemplateWire['undoToken'] | undefined;
  if (row.undoToken !== undefined) {
    const candidate = text(row.undoToken, '撤销令牌');
    if (!isStudyMethodUndoToken(candidate)) throw new Error('学法模板撤销令牌必须以 undo:method-template: 开头。');
    undoToken = candidate;
  }
  if (undoToken !== undefined && replacesVersion !== undefined &&
      undoToken !== `undo:method-template:${templateId}:v${version}:from-v${replacesVersion}`) {
    throw new Error('学法模板撤销令牌与版本链不匹配。');
  }
  const rawSteps = list(row.steps);
  if (rawSteps.length < 1 || rawSteps.length > 12) throw new Error('学法模板步骤数量须在 1..12 之间。');
  const seenIds = new Set<string>(), steps = Object.freeze(rawSteps.map(entry => parseStep(entry, seenIds)));
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i]!.kind !== 'teach_companion') continue;
    const hasGuard = steps.slice(i + 1).some(s => (s.kind === 'independent_transfer' || s.kind === 'independent_check') && s.blocksSpoiler);
    if (!hasGuard) {
      throw new StudyMethodInvariantError(`学法步骤 ${steps[i]!.stepId}（teach_companion）之后必须安排至少一个 blocksSpoiler=true 的 independent_transfer 或 independent_check 步骤。`);
    }
  }
  return Object.freeze(compact({
    templateId, version, name, goal, disciplineTags, steps, observationRequirements, author, replacesVersion, undoToken,
  }));
}

export function reviseStudyMethodTemplate(previous: StudyMethodTemplate, patch: StudyMethodTemplateRevisionPatch): StudyMethodTemplate {
  const base = parseStudyMethodTemplate(previous), delta = record(patch);
  fields(delta, 'name', 'goal', 'disciplineTags', 'steps', 'observationRequirements', 'author');
  const revisionFields = ['name', 'goal', 'disciplineTags', 'steps', 'observationRequirements', 'author'] as const;
  const changed = revisionFields.filter(field => delta[field] !== undefined && !jsonDeepEqual(delta[field], base[field]));
  if (!changed.length) throw new Error('学法模板修订需要至少一项实质变更。');
  const nextVersion = base.version + 1;
  return parseStudyMethodTemplate({
    templateId: base.templateId, version: nextVersion,
    ...Object.fromEntries(revisionFields.map(field => [field, delta[field] === undefined ? base[field] : delta[field]])),
    replacesVersion: base.version, undoToken: `undo:method-template:${base.templateId}:v${nextVersion}:from-v${base.version}`
  });
}

export function instantiateStudyMethodPlan(
  template: StudyMethodTemplate,
  context: { readonly instanceId: string; readonly instantiatedAtIso: string; readonly targetConceptIds?: readonly FactId[] },
): StudyMethodPlanInstance {
  const parsed = parseStudyMethodTemplate(template), ctx = record(context);
  fields(ctx, 'instanceId', 'instantiatedAtIso', 'targetConceptIds');
  const instanceId = text(ctx.instanceId, '执行实例标识');
  if (!instanceIdPattern.test(instanceId)) throw new Error('执行实例标识格式无效。');
  const instantiatedAtIso = requireIso(ctx.instantiatedAtIso, '实例化时间');
  const targetConceptIds = Object.freeze(
    ctx.targetConceptIds === undefined ? [] : Array.from(new Set(list(ctx.targetConceptIds).map(id => factId(text(id, '目标概念标识'))))),
  );
  const steps = Object.freeze(parsed.steps.map((step, stepIndex) => Object.freeze({ ...step, stepIndex, status: 'pending' as const })));
  return Object.freeze({
    instanceId, templateId: parsed.templateId, templateVersion: parsed.version, templateName: parsed.name,
    goal: parsed.goal, targetConceptIds, instantiatedAtIso, observationRequirements: parsed.observationRequirements,
    steps, frozen: true as const,
  });
}

const predictCounterexampleCheck = parseStudyMethodTemplate({
  templateId: 'predict_counterexample_check', version: 1, name: '预测-反例-独立检验', goal: '先暴露直觉假设，再用反例校准边界，最后通过独立检验确认掌握。',
  disciplineTags: ['stem', 'general'],
  observationRequirements: ['learner_prediction', 'counterexample_response', 'independent_check_result'], author: 'co_created',
  steps: [
    { stepId: 'predict_1', kind: 'predict', title: '先做直觉预测', promptHint: '给出结论预测并写下依据，不提前看解析。', observationRequired: true, blocksSpoiler: true, maxMinutes: 5 },
    { stepId: 'counterexample_2', kind: 'counterexample', title: '反例冲击与边界修正', promptHint: '检验极端或反例情形并修正原假设。', observationRequired: true, blocksSpoiler: true, maxMinutes: 6 },
    { stepId: 'check_3', kind: 'independent_check', title: '无提示独立检验', promptHint: '在不展示答案的前提下独立完成同结构检验题。', observationRequired: true, blocksSpoiler: true, maxMinutes: 8 },
    { stepId: 'reflect_4', kind: 'reflection_summary', title: '一句话边界总结', promptHint: '记录最易混淆的前提条件与适用边界。', observationRequired: false, blocksSpoiler: false, maxMinutes: 3 },
  ],
});
const workedFadedIndependent = parseStudyMethodTemplate({
  templateId: 'worked_faded_independent', version: 1, name: '样例-渐隐-独立完成', goal: '先观察完整示范，再补全渐隐关键步，最后独立完成迁移检验。',
  disciplineTags: ['stem', 'coding', 'general'],
  observationRequirements: ['faded_step_completion', 'independent_check_result', 'self_explanation_note'], author: 'co_created',
  steps: [
    { stepId: 'worked_1', kind: 'worked_example', title: '精读标准样例', promptHint: '拆解样例中每一步转化的触发条件。', observationRequired: false, blocksSpoiler: false, maxMinutes: 5 },
    { stepId: 'faded_2', kind: 'faded_example', title: '渐隐空步补全', promptHint: '独立补全被隐去的关键推导或代码段。', observationRequired: true, blocksSpoiler: true, maxMinutes: 6 },
    { stepId: 'independent_3', kind: 'independent_check', title: '独立整题检验', promptHint: '屏蔽提示与答案，独立完成新变式检验。', observationRequired: true, blocksSpoiler: true, maxMinutes: 10 },
    { stepId: 'explain_4', kind: 'self_explanation', title: '自解释关键决策', promptHint: '用自己的话说明关键一步为何成立。', observationRequired: true, blocksSpoiler: false, maxMinutes: 4 },
  ],
});
const teachCompanionTransfer = parseStudyMethodTemplate({
  templateId: 'teach_companion_transfer', version: 1, name: '费曼教导-独立迁移检验', goal: '通过先试做与向学伴讲透原理暴露盲区，再以防剧透独立迁移检验闭环验证。',
  disciplineTags: ['general', 'stem', 'humanities'],
  observationRequirements: ['initial_attempt', 'teach_companion_transcript', 'independent_transfer_result'], author: 'co_created',
  steps: [
    { stepId: 'try_1', kind: 'try_first', title: '先试做探底', promptHint: '独立尝试起步并标出卡点。', observationRequired: true, blocksSpoiler: true, maxMinutes: 5 },
    { stepId: 'teach_2', kind: 'teach_companion', title: '费曼讲给学伴听', promptHint: '用自己的语言向学伴讲解原理并回应追问。', observationRequired: true, blocksSpoiler: true, maxMinutes: 8 },
    { stepId: 'transfer_3', kind: 'independent_transfer', title: '防剧透独立迁移检验', promptHint: '在新情境下屏蔽提示与答案，独立完成迁移题。', observationRequired: true, blocksSpoiler: true, maxMinutes: 10 },
    { stepId: 'summary_4', kind: 'reflection_summary', title: '沉淀迁移口诀', promptHint: '提炼跨情境可复用的判断条件。', observationRequired: false, blocksSpoiler: false, maxMinutes: 3 },
  ],
});

export const builtInStudyMethodTemplates: readonly StudyMethodTemplate[] = Object.freeze([
  predictCounterexampleCheck, workedFadedIndependent, teachCompanionTransfer,
]);
export const builtInStudyMethodTemplateById: Readonly<
  Record<'predict_counterexample_check' | 'worked_faded_independent' | 'teach_companion_transfer', StudyMethodTemplate>
> = Object.freeze({
  predict_counterexample_check: predictCounterexampleCheck,
  worked_faded_independent: workedFadedIndependent, teach_companion_transfer: teachCompanionTransfer
});
