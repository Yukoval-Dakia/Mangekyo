import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { remember, remembered } from './api';
import './classroom.css';

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

export const STUDY_METHOD_STEP_META: Readonly<Record<StudyMethodStepKind, StudyMethodStepPrimitiveMeta>> = {
  predict: {
    kind: 'predict',
    label: '先预测',
    defaultTitle: '先做预测',
    defaultPromptHint: '在看结论前，先写出你预期的结果或变化方向及理由。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 3,
  },
  try_first: {
    kind: 'try_first',
    label: '先自己试',
    defaultTitle: '独立初试',
    defaultPromptHint: '先不看提示，自己尝试走完核心思路或列式。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 5,
  },
  worked_example: {
    kind: 'worked_example',
    label: '完整例题',
    defaultTitle: '完整示范例题',
    defaultPromptHint: '逐步拆解一道典型例题，标注每步为何这样选。',
    defaultObservationRequired: false,
    defaultBlocksSpoiler: false,
    defaultMaxMinutes: 5,
  },
  faded_example: {
    kind: 'faded_example',
    label: '渐退脚手架',
    defaultTitle: '渐退练习',
    defaultPromptHint: '保留框架提示，由学习者补全关键转折步骤。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 6,
  },
  counterexample: {
    kind: 'counterexample',
    label: '反例辨析',
    defaultTitle: '构造反例辨析',
    defaultPromptHint: '找一个边界或反例，验证条件缺一不可的原因。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 4,
  },
  teach_companion: {
    kind: 'teach_companion',
    label: '教同伴',
    defaultTitle: '讲给同伴听',
    defaultPromptHint: '用自己的话把方法讲给同伴听，同伴只追问漏洞不代答。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 5,
  },
  independent_check: {
    kind: 'independent_check',
    label: '独立检查',
    defaultTitle: '无提示独立检查',
    defaultPromptHint: '合上提示独立作答一道同结构检查题，验证真实掌握。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 5,
  },
  independent_transfer: {
    kind: 'independent_transfer',
    label: '独立迁移',
    defaultTitle: '独立迁移检验',
    defaultPromptHint: '在新情境或变形条件下独立完成一道迁移题，严禁剧透。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: true,
    defaultMaxMinutes: 6,
  },
  self_explanation: {
    kind: 'self_explanation',
    label: '自我解释',
    defaultTitle: '关键步自我解释',
    defaultPromptHint: '回看刚才的推导，用一句话说明最容易卡住的转折依据。',
    defaultObservationRequired: true,
    defaultBlocksSpoiler: false,
    defaultMaxMinutes: 3,
  },
  reflection_summary: {
    kind: 'reflection_summary',
    label: '反思总结',
    defaultTitle: '收束与反思',
    defaultPromptHint: '总结今天确认的规律、易错坑点与下次复习触发条件。',
    defaultObservationRequired: false,
    defaultBlocksSpoiler: false,
    defaultMaxMinutes: 3,
  },
};

export const builtInStudyMethodTemplates: readonly StudyMethodTemplate[] = [
  {
    templateId: 'predict_counterexample_check',
    version: 1,
    name: '预测-反例-独立检验',
    goal: '先暴露直觉假设，再用反例校准边界，最后通过独立检验确认掌握。',
    disciplineTags: ['stem', 'general'],
    steps: [
      {
        stepId: 'predict_1',
        kind: 'predict',
        title: '先做直觉预测',
        promptHint: '给出结论预测并写下依据，不提前看解析。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 5,
      },
      {
        stepId: 'counterexample_2',
        kind: 'counterexample',
        title: '反例冲击与边界修正',
        promptHint: '检验极端或反例情形并修正原假设。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 6,
      },
      {
        stepId: 'check_3',
        kind: 'independent_check',
        title: '无提示独立检验',
        promptHint: '在不展示答案的前提下独立完成同结构检验题。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 8,
      },
      {
        stepId: 'reflect_4',
        kind: 'reflection_summary',
        title: '一句话边界总结',
        promptHint: '记录最易混淆的前提条件与适用边界。',
        observationRequired: false,
        blocksSpoiler: false,
        maxMinutes: 3,
      },
    ],
    observationRequirements: [
      'learner_prediction',
      'counterexample_response',
      'independent_check_result',
    ],
    author: 'co_created',
  },
  {
    templateId: 'worked_faded_independent',
    version: 1,
    name: '样例-渐隐-独立完成',
    goal: '先观察完整示范，再补全渐隐关键步，最后独立完成迁移检验。',
    disciplineTags: ['stem', 'coding', 'general'],
    steps: [
      {
        stepId: 'worked_1',
        kind: 'worked_example',
        title: '精读标准样例',
        promptHint: '拆解样例中每一步转化的触发条件。',
        observationRequired: false,
        blocksSpoiler: false,
        maxMinutes: 5,
      },
      {
        stepId: 'faded_2',
        kind: 'faded_example',
        title: '渐隐空步补全',
        promptHint: '独立补全被隐去的关键推导或代码段。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 6,
      },
      {
        stepId: 'independent_3',
        kind: 'independent_check',
        title: '独立整题检验',
        promptHint: '屏蔽提示与答案，独立完成新变式检验。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 10,
      },
      {
        stepId: 'explain_4',
        kind: 'self_explanation',
        title: '自解释关键决策',
        promptHint: '用自己的话说明关键一步为何成立。',
        observationRequired: true,
        blocksSpoiler: false,
        maxMinutes: 4,
      },
    ],
    observationRequirements: [
      'faded_step_completion',
      'independent_check_result',
      'self_explanation_note',
    ],
    author: 'co_created',
  },
  {
    templateId: 'teach_companion_transfer',
    version: 1,
    name: '费曼教导-独立迁移检验',
    goal: '通过先试做与向学伴讲透原理暴露盲区，再以防剧透独立迁移检验闭环验证。',
    disciplineTags: ['general', 'stem', 'humanities'],
    steps: [
      {
        stepId: 'try_1',
        kind: 'try_first',
        title: '先试做探底',
        promptHint: '独立尝试起步并标出卡点。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 5,
      },
      {
        stepId: 'teach_2',
        kind: 'teach_companion',
        title: '费曼讲给学伴听',
        promptHint: '用自己的语言向学伴讲解原理并回应追问。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 8,
      },
      {
        stepId: 'transfer_3',
        kind: 'independent_transfer',
        title: '防剧透独立迁移检验',
        promptHint: '在新情境下屏蔽提示与答案，独立完成迁移题。',
        observationRequired: true,
        blocksSpoiler: true,
        maxMinutes: 10,
      },
      {
        stepId: 'summary_4',
        kind: 'reflection_summary',
        title: '沉淀迁移口诀',
        promptHint: '提炼跨情境可复用的判断条件。',
        observationRequired: false,
        blocksSpoiler: false,
        maxMinutes: 3,
      },
    ],
    observationRequirements: [
      'initial_attempt',
      'teach_companion_transcript',
      'independent_transfer_result',
    ],
    author: 'co_created',
  },
];

export type StudyMethodValidationResult = {
  readonly valid: boolean;
  readonly teachCompanionViolation: boolean;
  readonly errors: readonly string[];
};

const MAX_STEPS = 12;
const MAX_STEP_MINUTES = 120;

export function validateStudyMethodTemplate(template: StudyMethodTemplate): StudyMethodValidationResult {
  const errors: string[] = [];
  if (!template.name.trim()) {
    errors.push('请填写学法模板名称。');
  }
  if (!template.goal.trim()) {
    errors.push('请填写该模板的教学目标。');
  }
  if (template.steps.length === 0) {
    errors.push('至少需要编排 1 个教学步骤。');
  } else if (template.steps.length > MAX_STEPS) {
    errors.push(`学法模板步骤数量须在 1..${MAX_STEPS} 之间。`);
  }

  let teachCompanionViolation = false;
  for (let i = 0; i < template.steps.length; i++) {
    const step = template.steps[i]!;
    if (!step.title.trim()) {
      errors.push(`第 ${i + 1} 步缺少步骤标题。`);
    }
    if (!step.promptHint.trim()) {
      errors.push(`第 ${i + 1} 步缺少引导提示语（promptHint）。`);
    }
    if (
      step.maxMinutes !== undefined &&
      (!Number.isInteger(step.maxMinutes) || step.maxMinutes < 1 || step.maxMinutes > MAX_STEP_MINUTES)
    ) {
      errors.push(`第 ${i + 1} 步时长上限必须是 1..${MAX_STEP_MINUTES} 内的整数分钟。`);
    }
    if (step.kind === 'teach_companion') {
      const hasIndependentFollowup = template.steps.slice(i + 1).some(
        (later) =>
          (later.kind === 'independent_transfer' || later.kind === 'independent_check') &&
          later.blocksSpoiler === true,
      );
      if (!hasIndependentFollowup) {
        teachCompanionViolation = true;
      }
    }
  }

  if (teachCompanionViolation) {
    errors.push(
      '包含「教同伴」步骤时，其后必须至少有 1 步开启防剧透（blocksSpoiler）的「独立迁移」或「独立检查」，以防止将口头复述误判为独立掌握。',
    );
  }

  return {
    valid: errors.length === 0,
    teachCompanionViolation,
    errors,
  };
}

const TEMPLATES_STORAGE_KEY = 'study-method-templates:v1';
const SELECTED_STORAGE_KEY = 'study-method-selected:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const VALID_STEP_KIND_SET = new Set<StudyMethodStepKind>(studyMethodStepKinds);

function sanitizeStep(raw: unknown, fallbackId: string): StudyMethodStep | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string' || !VALID_STEP_KIND_SET.has(raw.kind as StudyMethodStepKind)) {
    return null;
  }
  const kind = raw.kind as StudyMethodStepKind;
  const meta = STUDY_METHOD_STEP_META[kind];
  const stepId = typeof raw.stepId === 'string' && raw.stepId.trim() ? raw.stepId.trim() : fallbackId;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : meta.defaultTitle;
  const promptHint =
    typeof raw.promptHint === 'string' && raw.promptHint.trim() ? raw.promptHint.trim() : meta.defaultPromptHint;
  const observationRequired =
    typeof raw.observationRequired === 'boolean' ? raw.observationRequired : meta.defaultObservationRequired;
  const blocksSpoiler = typeof raw.blocksSpoiler === 'boolean' ? raw.blocksSpoiler : meta.defaultBlocksSpoiler;
  const maxMinutes =
    typeof raw.maxMinutes === 'number' &&
    Number.isFinite(raw.maxMinutes) &&
    raw.maxMinutes >= 1 &&
    raw.maxMinutes <= MAX_STEP_MINUTES
      ? Math.round(raw.maxMinutes)
      : undefined;

  return {
    stepId,
    kind,
    title,
    promptHint,
    observationRequired,
    blocksSpoiler,
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
  };
}

function sanitizeTemplate(raw: unknown): StudyMethodTemplate | null {
  if (!isRecord(raw) || typeof raw.templateId !== 'string' || !raw.templateId.trim()) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_STEPS) return null;
  const steps: StudyMethodStep[] = [];
  raw.steps.forEach((entry, idx) => {
    const clean = sanitizeStep(entry, `${raw.templateId}-s${idx + 1}`);
    if (clean) steps.push(clean);
  });
  if (steps.length === 0 || steps.length > MAX_STEPS) return null;

  const version =
    typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version >= 1 ? raw.version : 1;
  const author: StudyMethodAuthor =
    raw.author === 'learner' || raw.author === 'companion' || raw.author === 'co_created'
      ? raw.author
      : 'co_created';

  const disciplineTags = Array.isArray(raw.disciplineTags)
    ? raw.disciplineTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];
  const observationRequirements = Array.isArray(raw.observationRequirements)
    ? raw.observationRequirements.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  return {
    templateId: raw.templateId.trim(),
    version,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.templateId.trim(),
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    disciplineTags,
    steps,
    observationRequirements,
    author,
    ...(typeof raw.replacesVersion === 'number' && Number.isSafeInteger(raw.replacesVersion) && raw.replacesVersion >= 1
      ? { replacesVersion: raw.replacesVersion }
      : {}),
    ...(typeof raw.undoToken === 'string' && raw.undoToken.startsWith('undo:method-template:')
      ? { undoToken: raw.undoToken }
      : {}),
  };
}

function mergeTemplates(customList: readonly StudyMethodTemplate[]): StudyMethodTemplate[] {
  const byId = new Map<string, StudyMethodTemplate>();
  for (const builtIn of builtInStudyMethodTemplates) {
    byId.set(builtIn.templateId, builtIn);
  }
  for (const custom of customList) {
    const existing = byId.get(custom.templateId);
    if (!existing || custom.version >= existing.version) {
      byId.set(custom.templateId, custom);
    }
  }
  return [...byId.values()];
}

function mergeRemoteIntoLocal(
  currentLocal: readonly StudyMethodTemplate[],
  remoteList: readonly StudyMethodTemplate[],
): StudyMethodTemplate[] {
  const byId = new Map<string, StudyMethodTemplate>();
  for (const builtIn of builtInStudyMethodTemplates) {
    byId.set(builtIn.templateId, builtIn);
  }
  for (const remote of remoteList) {
    const existing = byId.get(remote.templateId);
    if (!existing || remote.version >= existing.version) {
      byId.set(remote.templateId, remote);
    }
  }
  // 本地已保存的同版本或更高版本模板优先保留，避免异步 GET 慢响应覆盖刚保存的新模板。
  for (const local of currentLocal) {
    const existing = byId.get(local.templateId);
    if (!existing || local.version >= existing.version) {
      byId.set(local.templateId, local);
    }
  }
  return [...byId.values()];
}

export function loadStoredStudyMethodTemplates(): StudyMethodTemplate[] {
  try {
    const raw = remembered(TEMPLATES_STORAGE_KEY);
    if (!raw) return [...builtInStudyMethodTemplates];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...builtInStudyMethodTemplates];
    const sanitized = parsed
      .map(sanitizeTemplate)
      .filter((item): item is StudyMethodTemplate => item !== null);
    return mergeTemplates(sanitized);
  } catch {
    return [...builtInStudyMethodTemplates];
  }
}

function saveStoredStudyMethodTemplates(templates: readonly StudyMethodTemplate[]) {
  remember(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
}

export function loadSelectedStudyMethodTemplateId(): string {
  const stored = remembered(SELECTED_STORAGE_KEY);
  return stored && stored.trim() ? stored.trim() : builtInStudyMethodTemplates[0]!.templateId;
}

export function saveSelectedStudyMethodTemplateId(templateId: string) {
  remember(SELECTED_STORAGE_KEY, templateId);
}

function makeStep(kind: StudyMethodStepKind): StudyMethodStep {
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

type UndoRecord = {
  readonly undoToken: string;
  readonly templateId: string;
  readonly savedVersion: number;
  readonly previous: StudyMethodTemplate | null;
  readonly syncedRemote: boolean;
};

const DEFAULT_TEMPLATES_ENDPOINT = '/api/study-method-templates';

async function trySyncSaveTemplate(
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
    return {
      synced: false,
      note: `远端暂未接收（HTTP ${response.status}），已降级保存在本机偏好中。`,
    };
  } catch {
    return {
      synced: false,
      note: `暂无法连接模板同步接口，v${template.version} 已保存在本机偏好中。`,
    };
  }
}

async function trySyncUndoTemplate(
  undoToken: string,
  endpoint = DEFAULT_TEMPLATES_ENDPOINT,
): Promise<boolean> {
  try {
    const undoEndpoint = `${endpoint.replace(/\/+$/, '')}/undo`;
    const response = await fetch(undoEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ undoToken }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function StudyMethodTemplateDrawer({
  open,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onTemplatesChange,
  onClose,
  endpoint,
  autoFetch,
}: {
  readonly open: boolean;
  readonly templates: readonly StudyMethodTemplate[];
  readonly selectedTemplateId: string;
  readonly onSelectTemplate: (template: StudyMethodTemplate) => void;
  readonly onTemplatesChange: (nextTemplates: readonly StudyMethodTemplate[]) => void;
  readonly onClose: () => void;
  readonly endpoint?: string | undefined;
  readonly autoFetch?: boolean | undefined;
}) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const templatesRef = useRef(templates);
  templatesRef.current = templates;
  const onTemplatesChangeRef = useRef(onTemplatesChange);
  onTemplatesChangeRef.current = onTemplatesChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef(0);
  const mutationVersionRef = useRef(0);

  const resolvedEndpoint =
    typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : DEFAULT_TEMPLATES_ENDPOINT;
  const shouldAutoFetch =
    autoFetch === true || (autoFetch !== false && typeof endpoint === 'string' && endpoint.trim().length > 0);

  const activeTemplate = useMemo(
    () => templates.find((item) => item.templateId === selectedTemplateId) ?? templates[0] ?? builtInStudyMethodTemplates[0]!,
    [templates, selectedTemplateId],
  );

  const [draft, setDraft] = useState<StudyMethodTemplate>(() => activeTemplate);
  const [newStepKind, setNewStepKind] = useState<StudyMethodStepKind>('predict');
  const [tagsInput, setTagsInput] = useState(() => activeTemplate.disciplineTags.join('、'));
  const [obsInput, setObsInput] = useState(() => activeTemplate.observationRequirements.join('\n'));
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  const [undoRecord, setUndoRecord] = useState<UndoRecord | null>(null);

  const loadIntoEditor = useCallback((template: StudyMethodTemplate) => {
    setDraft(template);
    setTagsInput(template.disciplineTags.join('、'));
    setObsInput(template.observationRequirements.join('\n'));
  }, []);

  const syncFromRemote = useCallback(
    async (explicitTrigger = false) => {
      fetchAbortRef.current?.abort();
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      const seq = ++fetchSeqRef.current;
      if (explicitTrigger) {
        setSyncing(true);
        setStatusNote('');
      }
      try {
        const response = await fetch(resolvedEndpoint, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          if (explicitTrigger && !controller.signal.aborted && seq === fetchSeqRef.current) {
            setStatusNote(
              response.status === 404 || response.status === 405
                ? `当前环境尚未开放远端模板库（HTTP ${response.status}），继续使用本机模板。`
                : `远端模板同步未成功（HTTP ${response.status}），继续使用本机模板。`,
            );
          }
          return;
        }
        const body: unknown = await response.json().catch(() => null);
        const list = Array.isArray(body)
          ? body
          : isRecord(body) && Array.isArray(body.templates)
            ? body.templates
            : null;
        if (!list || controller.signal.aborted || seq !== fetchSeqRef.current) return;
        const sanitized = list.map(sanitizeTemplate).filter((item): item is StudyMethodTemplate => item !== null);
        if (sanitized.length > 0) {
          const merged = mergeRemoteIntoLocal(templatesRef.current, sanitized);
          saveStoredStudyMethodTemplates(merged);
          onTemplatesChangeRef.current(merged);
          if (explicitTrigger) {
            setStatusNote(`已从远端同步 ${sanitized.length} 套学法模板。`);
          }
        } else if (explicitTrigger) {
          setStatusNote('远端暂未返回新的学法模板，已保留本机模板。');
        }
      } catch {
        if (explicitTrigger && !controller.signal.aborted && seq === fetchSeqRef.current) {
          setStatusNote('暂无法连接远端模板库，继续使用本机模板。');
        }
      } finally {
        if (explicitTrigger && !controller.signal.aborted && seq === fetchSeqRef.current) {
          setSyncing(false);
        }
      }
    },
    [resolvedEndpoint],
  );

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    loadIntoEditor(activeTemplate);
    const rafId = requestAnimationFrame(() => closeButtonRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
    // Intentionally sync focus/draft only on open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !shouldAutoFetch) return;
    void syncFromRemote(false);
    return () => {
      fetchAbortRef.current?.abort();
    };
  }, [open, shouldAutoFetch, syncFromRemote]);

  const validation = useMemo(() => validateStudyMethodTemplate(draft), [draft]);

  if (!open) return null;

  function selectExisting(template: StudyMethodTemplate) {
    onSelectTemplate(template);
    saveSelectedStudyMethodTemplateId(template.templateId);
    loadIntoEditor(template);
    setStatusNote('');
  }

  function createCustomFork() {
    const suffix = Math.random().toString(36).slice(2, 6);
    const created: StudyMethodTemplate = {
      templateId: `custom_${suffix}`,
      version: 1,
      name: `${draft.name}（共创版）`,
      goal: draft.goal || '按学习者节奏共创的受控课堂步骤编排。',
      disciplineTags: draft.disciplineTags.length ? draft.disciplineTags : ['共创'],
      steps: draft.steps.map((step, index) => ({ ...step, stepId: `custom-${suffix}-${index + 1}` })),
      observationRequirements: draft.observationRequirements,
      author: 'co_created',
    };
    loadIntoEditor(created);
    setStatusNote('已创建共创草稿，点击「保存新版本并使用」生效。');
  }

  function clearStepMaxMinutes(index: number) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step, idx) => {
        if (idx !== index) return step;
        const { maxMinutes: _removed, ...rest } = step;
        return rest;
      }),
    }));
  }

  function updateStep(index: number, patch: Partial<StudyMethodStep>) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.map((step, idx) => (idx === index ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(index: number, delta: -1 | 1) {
    setDraft((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.steps.length) return prev;
      const nextSteps = [...prev.steps];
      const [moved] = nextSteps.splice(index, 1);
      if (!moved) return prev;
      nextSteps.splice(target, 0, moved);
      return { ...prev, steps: nextSteps };
    });
  }

  function removeStep(index: number) {
    setDraft((prev) => ({
      ...prev,
      steps: prev.steps.filter((_, idx) => idx !== index),
    }));
  }

  function addStep(kind: StudyMethodStepKind) {
    setDraft((prev) => {
      if (prev.steps.length >= MAX_STEPS) return prev;
      return {
        ...prev,
        steps: [...prev.steps, makeStep(kind)],
      };
    });
  }

  function appendIndependentTransferGuard() {
    setDraft((prev) => {
      if (prev.steps.length >= MAX_STEPS) return prev;
      return {
        ...prev,
        steps: [
          ...prev.steps,
          {
            ...makeStep('independent_transfer'),
            title: '独立迁移检验',
            observationRequired: true,
            blocksSpoiler: true,
          },
        ],
      };
    });
  }

  async function handleSaveVersion() {
    if (!validation.valid || saving) return;
    setSaving(true);
    setStatusNote('');
    mutationVersionRef.current += 1;

    try {
      const currentTemplates = templatesRef.current;
      const existing = currentTemplates.find((item) => item.templateId === draft.templateId) ?? null;
      const nextVersion = existing ? existing.version + 1 : 1;
      const undoToken = existing
        ? `undo:method-template:${draft.templateId}:v${nextVersion}:from-v${existing.version}`
        : `undo:method-template:${draft.templateId}:v${nextVersion}`;
      const disciplineTags = tagsInput
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const observationRequirements = obsInput
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean);

      const savedTemplate: StudyMethodTemplate = {
        templateId: draft.templateId,
        version: nextVersion,
        name: draft.name.trim(),
        goal: draft.goal.trim(),
        disciplineTags,
        steps: draft.steps.map((step) => ({
          ...step,
          title: step.title.trim(),
          promptHint: step.promptHint.trim(),
        })),
        observationRequirements,
        author: 'co_created',
        ...(existing ? { replacesVersion: existing.version } : {}),
        undoToken,
      };

      const nextList = existing
        ? currentTemplates.map((item) => (item.templateId === savedTemplate.templateId ? savedTemplate : item))
        : [...currentTemplates, savedTemplate];

      saveStoredStudyMethodTemplates(nextList);
      saveSelectedStudyMethodTemplateId(savedTemplate.templateId);
      onTemplatesChange(nextList);
      onSelectTemplate(savedTemplate);
      loadIntoEditor(savedTemplate);

      const syncResult = await trySyncSaveTemplate(savedTemplate, resolvedEndpoint);
      setUndoRecord({
        undoToken,
        templateId: savedTemplate.templateId,
        savedVersion: nextVersion,
        previous: existing,
        syncedRemote: syncResult.synced,
      });
      setStatusNote(syncResult.note);
    } finally {
      setSaving(false);
    }
  }

  async function handleUndo() {
    if (!undoRecord || saving) return;
    setSaving(true);
    try {
      if (undoRecord.syncedRemote) {
        const remoteUndone = await trySyncUndoTemplate(undoRecord.undoToken, resolvedEndpoint);
        if (!remoteUndone) {
          setStatusNote('远端模板撤回失败，当前版本保持不变，请稍后重试。');
          return;
        }
      }

      mutationVersionRef.current += 1;
      const currentTemplates = templatesRef.current;
      const restoredList = undoRecord.previous
        ? currentTemplates.map((item) => (item.templateId === undoRecord.templateId ? undoRecord.previous! : item))
        : currentTemplates.filter((item) => item.templateId !== undoRecord.templateId);
      const fallback = undoRecord.previous ?? restoredList[0] ?? builtInStudyMethodTemplates[0]!;

      saveStoredStudyMethodTemplates(restoredList);
      saveSelectedStudyMethodTemplateId(fallback.templateId);
      onTemplatesChange(restoredList);
      onSelectTemplate(fallback);
      loadIntoEditor(fallback);
      setStatusNote(
        undoRecord.previous
          ? `已通过 ${undoRecord.undoToken} 撤回至 v${undoRecord.previous.version}。`
          : `已通过 ${undoRecord.undoToken} 撤回新建模板。`,
      );
      setUndoRecord(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="smt-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="smt-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="smt-head">
          <div className="smt-head-copy">
            <span className="smt-kicker">共创学法模板 · 受控原语编排</span>
            <h2 id={titleId} className="smt-title">选择与编排课堂学法</h2>
            <p className="smt-honesty-note">
              当前版本 <strong>v{draft.version}</strong>
              {draft.replacesVersion !== undefined ? ` · 替代 v${draft.replacesVersion}` : ''} · 修改模板仅生成新版本，绝不改写历史课堂。
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="smt-close"
            aria-label="关闭学法模板抽屉"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="smt-body">
          {undoRecord && (
            <div className="smt-undo-bar" role="status">
              <div className="smt-undo-copy">
                <strong>已保存 v{undoRecord.savedVersion}</strong>
                <code>{undoRecord.undoToken}</code>
              </div>
              <button type="button" className="smt-undo-btn" disabled={saving} onClick={() => void handleUndo()}>
                {undoRecord.previous ? `撤回至 v${undoRecord.previous.version}` : '撤回本次保存'}
              </button>
            </div>
          )}

          {statusNote && (
            <p className="smt-status-note" role="status">
              {statusNote}
            </p>
          )}

          {/* 模板选择区 */}
          <section className="smt-section" aria-label="可用学法模板">
            <div className="smt-section-head">
              <h3>内置与已存模板</h3>
              <div className="smt-step-controls">
                <button
                  type="button"
                  className="smt-ghost-btn"
                  disabled={syncing || saving}
                  onClick={() => void syncFromRemote(true)}
                >
                  {syncing ? '正在同步…' : '同步远端模板'}
                </button>
                <button type="button" className="smt-ghost-btn" onClick={createCustomFork}>
                  + 基于当前新建共创模板
                </button>
              </div>
            </div>
            <div className="smt-template-list" role="radiogroup" aria-label="学法模板列表">
              {templates.map((item) => {
                const active = item.templateId === draft.templateId;
                return (
                  <button
                    key={item.templateId}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`smt-template-card${active ? ' is-active' : ''}`}
                    onClick={() => selectExisting(item)}
                  >
                    <div className="smt-template-card-head">
                      <strong>{item.name}</strong>
                      <span className="smt-version-pill">
                        v{item.version}
                        {item.replacesVersion !== undefined ? ` (←v${item.replacesVersion})` : ''}
                      </span>
                    </div>
                    <p className="smt-template-goal">{item.goal}</p>
                    <div className="smt-step-chain">
                      {item.steps.map((step, idx) => (
                        <span key={step.stepId} className="smt-chain-pill">
                          {idx + 1}. {STUDY_METHOD_STEP_META[step.kind].label}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 模板元信息编辑 */}
          <section className="smt-section" aria-label="模板目标与观察要求">
            <h3>模板信息与观察要求</h3>
            <div className="smt-meta-grid">
              <label className="smt-field">
                模板名称
                <input
                  type="text"
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.currentTarget.value }))}
                  placeholder="例如：先预测 → 构反例 → 独立检查"
                />
              </label>
              <label className="smt-field">
                学科标签（用顿号或逗号分隔）
                <input
                  type="text"
                  maxLength={120}
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.currentTarget.value)}
                  placeholder="例如：通用、数理推理"
                />
              </label>
              <label className="smt-field smt-field--full">
                学法目标
                <textarea
                  rows={2}
                  maxLength={240}
                  value={draft.goal}
                  onChange={(event) => setDraft((prev) => ({ ...prev, goal: event.currentTarget.value }))}
                  placeholder="说明这套学法想解决什么学习瓶颈…"
                />
              </label>
              <label className="smt-field smt-field--full">
                课堂观察要求（每行一条）
                <textarea
                  rows={2}
                  maxLength={400}
                  value={obsInput}
                  onChange={(event) => setObsInput(event.currentTarget.value)}
                  placeholder="每行写一条课堂需记录的观察要点…"
                />
              </label>
            </div>
          </section>

          {/* 教同伴硬校验提示 */}
          {!validation.valid && (
            <div className="smt-validation-box" role="alert">
              <strong>保存前需修正以下校验问题：</strong>
              <ul>
                {validation.errors.map((err, idx) => (
                  <li key={idx}>{err}</li>
                ))}
              </ul>
              {validation.teachCompanionViolation && (
                <button
                  type="button"
                  className="smt-fix-btn"
                  onClick={appendIndependentTransferGuard}
                >
                  一键补加「独立迁移检验」
                </button>
              )}
            </div>
          )}

          {/* 10 种受控步骤原语编排区 */}
          <section className="smt-section" aria-label="受控步骤编排">
            <div className="smt-section-head">
              <h3>步骤编排（仅支持 10 种受控学法原语）</h3>
              <span className="smt-count-pill">共 {draft.steps.length} 步</span>
            </div>

            <div className="smt-add-row">
              <label className="smt-add-select-label">
                <span className="visually-hidden">选择要添加的步骤原语</span>
                <select
                  value={newStepKind}
                  onChange={(event) => setNewStepKind(event.currentTarget.value as StudyMethodStepKind)}
                >
                  {studyMethodStepKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {STUDY_METHOD_STEP_META[kind].label}（{kind}）
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="smt-add-btn"
                disabled={draft.steps.length >= MAX_STEPS}
                onClick={() => addStep(newStepKind)}
              >
                + 添加步骤
              </button>
            </div>

            <ol className="smt-steps-list">
              {draft.steps.map((step, index) => (
                <li key={step.stepId} className="smt-step-item">
                  <div className="smt-step-head">
                    <span className="smt-step-index">第 {index + 1} 步</span>
                    <select
                      aria-label={`第 ${index + 1} 步原语类型`}
                      className="smt-step-kind-select"
                      value={step.kind}
                      onChange={(event) => {
                        const kind = event.currentTarget.value as StudyMethodStepKind;
                        const meta = STUDY_METHOD_STEP_META[kind];
                        updateStep(index, {
                          kind,
                          blocksSpoiler: meta.defaultBlocksSpoiler,
                          observationRequired: meta.defaultObservationRequired,
                        });
                      }}
                    >
                      {studyMethodStepKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {STUDY_METHOD_STEP_META[kind].label}
                        </option>
                      ))}
                    </select>
                    <div className="smt-step-controls" role="group" aria-label={`第 ${index + 1} 步顺序与删除操作`}>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn"
                        disabled={index === 0}
                        aria-label={`上移第 ${index + 1} 步`}
                        onClick={() => moveStep(index, -1)}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn"
                        disabled={index === draft.steps.length - 1}
                        aria-label={`下移第 ${index + 1} 步`}
                        onClick={() => moveStep(index, 1)}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="smt-step-ctrl-btn is-danger"
                        disabled={draft.steps.length <= 1}
                        aria-label={`删除第 ${index + 1} 步`}
                        onClick={() => removeStep(index)}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="smt-step-fields">
                    <label className="smt-field">
                      步骤标题
                      <input
                        type="text"
                        maxLength={80}
                        value={step.title}
                        onChange={(event) => updateStep(index, { title: event.currentTarget.value })}
                      />
                    </label>
                    <label className="smt-field smt-field--minutes">
                      时长上限（分钟）
                      <input
                        type="number"
                        min={1}
                        max={MAX_STEP_MINUTES}
                        value={step.maxMinutes ?? ''}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          if (!raw) {
                            clearStepMaxMinutes(index);
                            return;
                          }
                          const num = Number(raw);
                          if (Number.isFinite(num) && num >= 1 && num <= MAX_STEP_MINUTES) {
                            updateStep(index, { maxMinutes: Math.round(num) });
                          }
                        }}
                      />
                    </label>
                    <label className="smt-field smt-field--full">
                      引导提示语（受控文案）
                      <input
                        type="text"
                        maxLength={200}
                        value={step.promptHint}
                        onChange={(event) => updateStep(index, { promptHint: event.currentTarget.value })}
                      />
                    </label>
                  </div>

                  <div className="smt-step-toggles">
                    <label className="smt-checkbox">
                      <input
                        type="checkbox"
                        checked={step.observationRequired}
                        onChange={(event) => updateStep(index, { observationRequired: event.currentTarget.checked })}
                      />
                      <span>需要记录学习观察（observationRequired）</span>
                    </label>
                    <label className="smt-checkbox">
                      <input
                        type="checkbox"
                        checked={step.blocksSpoiler}
                        onChange={(event) => updateStep(index, { blocksSpoiler: event.currentTarget.checked })}
                      />
                      <span>开启防剧透守卫（blocksSpoiler）</span>
                    </label>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="smt-foot">
          <button type="button" className="smt-secondary-btn" onClick={onClose}>
            完成并返回开课
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!validation.valid || saving}
            onClick={() => void handleSaveVersion()}
          >
            {saving ? '正在保存新版本…' : `保存为新版本并使用`}
          </button>
        </footer>
      </section>
    </div>
  );
}
