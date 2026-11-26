import { remember, remembered } from './api';
import {
  isRecord,
  readArray,
  readBoolean,
  readNumber,
  readSafeInt,
  readStringList,
  readTrimmed,
  safeParseJson,
} from './shared/safe-values';

export const studyMethodStepKinds = [
  'predict',
  'try_first',
  'worked_example',
  'faded_example',
  'counterexample',
  'teach_companion',
  'independent_check',
  'independent_transfer',
  'self_explanation',
  'reflection_summary',
] as const;

export type StudyMethodStepKind = (typeof studyMethodStepKinds)[number];
export type StudyMethodAuthor = 'learner' | 'companion' | 'co_created';

export type StudyMethodStep = {
  readonly stepId: string;
  readonly kind: StudyMethodStepKind;
  readonly title: string;
  readonly promptHint: string;
  readonly observationRequired: boolean;
  readonly blocksSpoiler: boolean;
  readonly maxMinutes?: number;
};

export type StudyMethodTemplate = {
  readonly templateId: string;
  readonly version: number;
  readonly name: string;
  readonly goal: string;
  readonly disciplineTags: readonly string[];
  readonly steps: readonly StudyMethodStep[];
  readonly observationRequirements: readonly string[];
  readonly author: StudyMethodAuthor;
  readonly replacesVersion?: number;
  readonly undoToken?: string;
};

export type StudyMethodStepPrimitiveMeta = {
  readonly kind: StudyMethodStepKind;
  readonly label: string;
  readonly defaultTitle: string;
  readonly defaultPromptHint: string;
  readonly defaultObservationRequired: boolean;
  readonly defaultBlocksSpoiler: boolean;
  readonly defaultMaxMinutes: number;
};

export type StudyMethodValidationResult = {
  readonly valid: boolean;
  readonly teachCompanionViolation: boolean;
  readonly errors: readonly string[];
};

export const MAX_STUDY_METHOD_STEPS = 12;
export const MAX_STUDY_METHOD_STEP_MINUTES = 120;
export const DEFAULT_TEMPLATES_ENDPOINT = '/api/study-method-templates';

const TEMPLATES_STORAGE_KEY = 'study-method-templates:v1';
const SELECTED_STORAGE_KEY = 'study-method-selected:v1';
const VALID_STEP_KIND_SET = new Set<StudyMethodStepKind>(studyMethodStepKinds);

function metaOf(
  kind: StudyMethodStepKind,
  label: string,
  defaultTitle: string,
  defaultPromptHint: string,
  defaultObservationRequired: boolean,
  defaultBlocksSpoiler: boolean,
  defaultMaxMinutes: number,
): StudyMethodStepPrimitiveMeta {
  return {
    kind,
    label,
    defaultTitle,
    defaultPromptHint,
    defaultObservationRequired,
    defaultBlocksSpoiler,
    defaultMaxMinutes,
  };
}

export const STUDY_METHOD_STEP_META: Readonly<Record<StudyMethodStepKind, StudyMethodStepPrimitiveMeta>> = {
  predict: metaOf('predict', '先预测', '先做预测', '在看结论前，先写出你预期的结果或变化方向及理由。', true, true, 3),
  try_first: metaOf('try_first', '先自己试', '独立初试', '先不看提示，自己尝试走完核心思路或列式。', true, true, 5),
  worked_example: metaOf('worked_example', '完整例题', '完整示范例题', '逐步拆解一道典型例题，标注每步为何这样选。', false, false, 5),
  faded_example: metaOf('faded_example', '渐退脚手架', '渐退练习', '保留框架提示，由学习者补全关键转折步骤。', true, true, 6),
  counterexample: metaOf('counterexample', '反例辨析', '构造反例辨析', '找一个边界或反例，验证条件缺一不可的原因。', true, true, 4),
  teach_companion: metaOf('teach_companion', '教同伴', '讲给同伴听', '用自己的话把方法讲给同伴听，同伴只追问漏洞不代答。', true, true, 5),
  independent_check: metaOf('independent_check', '独立检查', '无提示独立检查', '合上提示独立作答一道同结构检查题，验证真实掌握。', true, true, 5),
  independent_transfer: metaOf('independent_transfer', '独立迁移', '独立迁移检验', '在新情境或变形条件下独立完成一道迁移题，严禁剧透。', true, true, 6),
  self_explanation: metaOf('self_explanation', '自我解释', '关键步自我解释', '回看刚才的推导，用一句话说明最容易卡住的转折依据。', true, false, 3),
  reflection_summary: metaOf('reflection_summary', '反思总结', '收束与反思', '总结今天确认的规律、易错坑点与下次复习触发条件。', false, false, 3),
};

function defineBuiltInStep(
  stepId: string,
  kind: StudyMethodStepKind,
  title: string,
  promptHint: string,
  maxMinutes: number,
): StudyMethodStep {
  const meta = STUDY_METHOD_STEP_META[kind];
  return {
    stepId,
    kind,
    title,
    promptHint,
    observationRequired: meta.defaultObservationRequired,
    blocksSpoiler: meta.defaultBlocksSpoiler,
    maxMinutes,
  };
}

export const builtInStudyMethodTemplates: readonly StudyMethodTemplate[] = [
  {
    templateId: 'predict_counterexample_check',
    version: 1,
    name: '预测-反例-独立检验',
    goal: '先暴露直觉假设，再用反例校准边界，最后通过独立检验确认掌握。',
    disciplineTags: ['stem', 'general'],
    steps: [
      defineBuiltInStep('predict_1', 'predict', '先做直觉预测', '给出结论预测并写下依据，不提前看解析。', 5),
      defineBuiltInStep('counterexample_2', 'counterexample', '反例冲击与边界修正', '检验极端或反例情形并修正原假设。', 6),
      defineBuiltInStep('check_3', 'independent_check', '无提示独立检验', '在不展示答案的前提下独立完成同结构检验题。', 8),
      defineBuiltInStep('reflect_4', 'reflection_summary', '一句话边界总结', '记录最易混淆的前提条件与适用边界。', 3),
    ],
    observationRequirements: ['learner_prediction', 'counterexample_response', 'independent_check_result'],
    author: 'co_created',
  },
  {
    templateId: 'worked_faded_independent',
    version: 1,
    name: '样例-渐隐-独立完成',
    goal: '先观察完整示范，再补全渐隐关键步，最后独立完成迁移检验。',
    disciplineTags: ['stem', 'coding', 'general'],
    steps: [
      defineBuiltInStep('worked_1', 'worked_example', '精读标准样例', '拆解样例中每一步转化的触发条件。', 5),
      defineBuiltInStep('faded_2', 'faded_example', '渐隐空步补全', '独立补全被隐去的关键推导或代码段。', 6),
      defineBuiltInStep('independent_3', 'independent_check', '独立整题检验', '屏蔽提示与答案，独立完成新变式检验。', 10),
      defineBuiltInStep('explain_4', 'self_explanation', '自解释关键决策', '用自己的话说明关键一步为何成立。', 4),
    ],
    observationRequirements: ['faded_step_completion', 'independent_check_result', 'self_explanation_note'],
    author: 'co_created',
  },
  {
    templateId: 'teach_companion_transfer',
    version: 1,
    name: '费曼教导-独立迁移检验',
    goal: '通过先试做与向学伴讲透原理暴露盲区，再以防剧透独立迁移检验闭环验证。',
    disciplineTags: ['general', 'stem', 'humanities'],
    steps: [
      defineBuiltInStep('try_1', 'try_first', '先试做探底', '独立尝试起步并标出卡点。', 5),
      defineBuiltInStep('teach_2', 'teach_companion', '费曼讲给学伴听', '用自己的语言向学伴讲解原理并回应追问。', 8),
      defineBuiltInStep('transfer_3', 'independent_transfer', '防剧透独立迁移检验', '在新情境下屏蔽提示与答案，独立完成迁移题。', 10),
      defineBuiltInStep('summary_4', 'reflection_summary', '沉淀迁移口诀', '提炼跨情境可复用的判断条件。', 3),
    ],
    observationRequirements: ['initial_attempt', 'teach_companion_transcript', 'independent_transfer_result'],
    author: 'co_created',
  },
];

export function validateStudyMethodTemplate(template: StudyMethodTemplate): StudyMethodValidationResult {
  const errors: string[] = [];
  if (!template.name.trim()) errors.push('请填写学法模板名称。');
  if (!template.goal.trim()) errors.push('请填写该模板的教学目标。');
  if (template.steps.length === 0) {
    errors.push('至少需要编排 1 个教学步骤。');
  } else if (template.steps.length > MAX_STUDY_METHOD_STEPS) {
    errors.push(`学法模板步骤数量须在 1..${MAX_STUDY_METHOD_STEPS} 之间。`);
  }

  let teachCompanionViolation = false;
  for (let i = 0; i < template.steps.length; i += 1) {
    const step = template.steps[i]!;
    if (!step.title.trim()) errors.push(`第 ${i + 1} 步缺少步骤标题。`);
    if (!step.promptHint.trim()) errors.push(`第 ${i + 1} 步缺少引导提示语（promptHint）。`);
    if (
      step.maxMinutes !== undefined &&
      (!Number.isInteger(step.maxMinutes) ||
        step.maxMinutes < 1 ||
        step.maxMinutes > MAX_STUDY_METHOD_STEP_MINUTES)
    ) {
      errors.push(`第 ${i + 1} 步时长上限必须是 1..${MAX_STUDY_METHOD_STEP_MINUTES} 内的整数分钟。`);
    }
    if (step.kind === 'teach_companion') {
      const hasIndependentFollowup = template.steps
        .slice(i + 1)
        .some(
          (later) =>
            (later.kind === 'independent_transfer' || later.kind === 'independent_check') &&
            later.blocksSpoiler === true,
        );
      if (!hasIndependentFollowup) teachCompanionViolation = true;
    }
  }

  if (teachCompanionViolation) {
    errors.push(
      '包含「教同伴」步骤时，其后必须至少有 1 步开启防剧透（blocksSpoiler）的「独立迁移」或「独立检查」，以防止将口头复述误判为独立掌握。',
    );
  }

  return { valid: errors.length === 0, teachCompanionViolation, errors };
}

function sanitizeStep(raw: unknown, fallbackId: string): StudyMethodStep | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !VALID_STEP_KIND_SET.has(raw.kind as StudyMethodStepKind)) {
    return null;
  }
  const kind = raw.kind as StudyMethodStepKind;
  const meta = STUDY_METHOD_STEP_META[kind];
  const rawMinutes = readNumber(raw.maxMinutes);
  const maxMinutes =
    rawMinutes !== undefined && rawMinutes >= 1 && rawMinutes <= MAX_STUDY_METHOD_STEP_MINUTES
      ? Math.round(rawMinutes)
      : undefined;

  return {
    stepId: readTrimmed(raw.stepId) ?? fallbackId,
    kind,
    title: readTrimmed(raw.title) ?? meta.defaultTitle,
    promptHint: readTrimmed(raw.promptHint) ?? meta.defaultPromptHint,
    observationRequired: readBoolean(raw.observationRequired, meta.defaultObservationRequired),
    blocksSpoiler: readBoolean(raw.blocksSpoiler, meta.defaultBlocksSpoiler),
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
  };
}

export function sanitizeStudyMethodTemplate(raw: unknown): StudyMethodTemplate | null {
  if (!isRecord(raw)) return null;
  const templateId = readTrimmed(raw.templateId);
  if (!templateId || !Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_STUDY_METHOD_STEPS) {
    return null;
  }
  const steps = readArray(raw.steps, (entry, idx) => sanitizeStep(entry, `${templateId}-s${idx + 1}`));
  if (steps.length === 0 || steps.length > MAX_STUDY_METHOD_STEPS) return null;

  const author: StudyMethodAuthor =
    raw.author === 'learner' || raw.author === 'companion' || raw.author === 'co_created'
      ? raw.author
      : 'co_created';
  const replacesVersion = readSafeInt(raw.replacesVersion, 1);
  const undoToken =
    typeof raw.undoToken === 'string' && raw.undoToken.startsWith('undo:method-template:')
      ? raw.undoToken
      : undefined;

  return {
    templateId,
    version: readSafeInt(raw.version, 1) ?? 1,
    name: readTrimmed(raw.name) ?? templateId,
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    disciplineTags: readStringList(raw.disciplineTags),
    steps,
    observationRequirements: readStringList(raw.observationRequirements),
    author,
    ...(replacesVersion !== undefined ? { replacesVersion } : {}),
    ...(undoToken ? { undoToken } : {}),
  };
}

/** Merges built-in templates with ordered layers; later layers win on equal or higher version. */
export function mergeStudyMethodTemplates(
  ...layers: readonly (readonly StudyMethodTemplate[])[]
): StudyMethodTemplate[] {
  const byId = new Map<string, StudyMethodTemplate>();
  for (const builtIn of builtInStudyMethodTemplates) byId.set(builtIn.templateId, builtIn);
  for (const layer of layers) {
    for (const item of layer) {
      const existing = byId.get(item.templateId);
      if (!existing || item.version >= existing.version) byId.set(item.templateId, item);
    }
  }
  return [...byId.values()];
}

export function loadStoredStudyMethodTemplates(): StudyMethodTemplate[] {
  const parsed = safeParseJson<unknown>(remembered(TEMPLATES_STORAGE_KEY));
  if (!Array.isArray(parsed)) return [...builtInStudyMethodTemplates];
  return mergeStudyMethodTemplates(readArray(parsed, sanitizeStudyMethodTemplate));
}

export function saveStoredStudyMethodTemplates(templates: readonly StudyMethodTemplate[]): void {
  remember(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
}

export function loadSelectedStudyMethodTemplateId(): string {
  return readTrimmed(remembered(SELECTED_STORAGE_KEY)) ?? builtInStudyMethodTemplates[0]!.templateId;
}

export function saveSelectedStudyMethodTemplateId(templateId: string): void {
  remember(SELECTED_STORAGE_KEY, templateId);
}

export function createStudyMethodStep(kind: StudyMethodStepKind): StudyMethodStep {
  const meta = STUDY_METHOD_STEP_META[kind];
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    stepId: `step-${kind}-${suffix}`,
    kind,
    title: meta.defaultTitle,
    promptHint: meta.defaultPromptHint,
    observationRequired: meta.defaultObservationRequired,
    blocksSpoiler: meta.defaultBlocksSpoiler,
    maxMinutes: meta.defaultMaxMinutes,
  };
}

export async function trySyncSaveTemplate(
  template: StudyMethodTemplate,
  endpoint = DEFAULT_TEMPLATES_ENDPOINT,
): Promise<{ readonly synced: boolean; readonly note: string }> {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(template),
    });
    if (response.ok) {
      return { synced: true, note: `已保存新版本 v${template.version} 并同步到教研模板库。` };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        synced: false,
        note: `当前环境尚未开放模板同步接口（HTTP ${response.status}），v${template.version} 已保存在本机偏好中。`,
      };
    }
    return { synced: false, note: `远端暂未接收（HTTP ${response.status}），已降级保存在本机偏好中。` };
  } catch {
    return { synced: false, note: `暂无法连接模板同步接口，v${template.version} 已保存在本机偏好中。` };
  }
}

export async function trySyncUndoTemplate(
  undoToken: string,
  endpoint = DEFAULT_TEMPLATES_ENDPOINT,
): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ undoToken }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
