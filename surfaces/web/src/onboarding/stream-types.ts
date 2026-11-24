import type {
  OnboardingStreamEvent,
  OnboardingStreamFindingKind,
  OnboardingStreamStageId,
} from '../api';

export type OnboardingStageStatus = 'pending' | 'active' | 'done' | 'error';

export interface OnboardingStageState {
  id: OnboardingStreamStageId;
  status: OnboardingStageStatus;
  detail?: string | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  findings: OnboardingFindingItem[];
  thinking: string;
}

export interface OnboardingFindingItem {
  id: string;
  stage: OnboardingStreamStageId;
  kind: OnboardingStreamFindingKind;
  label: string;
  detail?: string | undefined;
}

export interface OnboardingStreamMeta {
  model?: string | undefined;
  currentDate?: string | undefined;
  timeZone?: string | undefined;
}

export interface OnboardingWorkbenchState {
  meta: OnboardingStreamMeta;
  stages: OnboardingStageState[];
  activeStage: OnboardingStreamStageId | null;
  findingSeq: number;
}

export const ONBOARDING_STAGE_ORDER: readonly OnboardingStreamStageId[] = [
  'connect',
  'profile_exams',
  'disciplines_plan',
  'knowledge_graph',
  'starter_questions',
  'verify',
];

export const ONBOARDING_STAGE_LABELS: Record<OnboardingStreamStageId, string> = {
  connect: '连接模型与解析背景',
  profile_exams: '推演学制与考试节点',
  disciplines_plan: '规划学科与每日节奏',
  knowledge_graph: '编织初始知识图谱',
  starter_questions: '命制诊断摸底题',
  verify: '结构校验与装订方案',
};

export const ONBOARDING_FINDING_KIND_LABELS: Record<OnboardingStreamFindingKind, string> = {
  subject: '学科',
  exam: '考试',
  discipline: '选科',
  concept: '概念',
  edge: '关系',
  question: '摸底题',
  goal: '目标',
  repair: '自检修复',
};

export function initialWorkbenchState(): OnboardingWorkbenchState {
  return {
    meta: {},
    stages: ONBOARDING_STAGE_ORDER.map(id => ({ id, status: 'pending', findings: [], thinking: '' })),
    activeStage: null,
    findingSeq: 0,
  };
}

function patchStage(
  stages: OnboardingStageState[],
  id: OnboardingStreamStageId,
  patch: Partial<OnboardingStageState>,
): OnboardingStageState[] {
  return stages.map(stage => (stage.id === id ? { ...stage, ...patch } : stage));
}

function activateStage(state: OnboardingWorkbenchState, id: OnboardingStreamStageId): OnboardingStageState[] {
  const now = Date.now();
  const index = ONBOARDING_STAGE_ORDER.indexOf(id);
  return state.stages.map((stage, position) => {
    if (stage.id === id) {
      return { ...stage, status: 'active', startedAt: stage.startedAt ?? now };
    }
    if (stage.status === 'active') {
      return { ...stage, status: 'done', finishedAt: stage.finishedAt ?? now };
    }
    if (position < index && stage.status === 'pending') {
      return { ...stage, status: 'done', finishedAt: stage.finishedAt ?? now };
    }
    return stage;
  });
}

export function reduceStreamEvent(
  state: OnboardingWorkbenchState,
  event: OnboardingStreamEvent,
): OnboardingWorkbenchState {
  switch (event.event) {
    case 'meta':
      return {
        ...state,
        meta: {
          model: event.data.model ?? state.meta.model,
          currentDate: event.data.currentDate ?? state.meta.currentDate,
          timeZone: event.data.timeZone ?? state.meta.timeZone,
        },
      };
    case 'stage': {
      const { stage: id, status, detail } = event.data;
      if (!ONBOARDING_STAGE_ORDER.includes(id)) return state;
      if (status === 'active') {
        return { ...state, stages: activateStage(state, id), activeStage: id };
      }
      if (status === 'done') {
        return {
          ...state,
          stages: patchStage(state.stages, id, {
            status: 'done',
            ...(detail !== undefined ? { detail } : {}),
            finishedAt: Date.now(),
          }),
        };
      }
      return {
        ...state,
        activeStage: id,
        stages: patchStage(state.stages, id, {
          status: 'error',
          ...(detail !== undefined ? { detail } : {}),
          finishedAt: Date.now(),
        }),
      };
    }
    case 'thinking': {
      const { stage: id, delta } = event.data;
      if (!ONBOARDING_STAGE_ORDER.includes(id) || typeof delta !== 'string' || !delta) return state;
      const target = state.stages.find(stage => stage.id === id);
      if (!target) return state;
      return {
        ...state,
        stages: patchStage(state.stages, id, { thinking: target.thinking + delta }),
      };
    }
    case 'finding': {
      const { stage: id, kind, label, detail } = event.data;
      if (!ONBOARDING_STAGE_ORDER.includes(id) || typeof label !== 'string' || !label) return state;
      const target = state.stages.find(stage => stage.id === id);
      if (!target) return state;
      const item: OnboardingFindingItem = {
        id: `f${state.findingSeq + 1}`,
        stage: id,
        kind,
        label,
        ...(detail !== undefined ? { detail } : {}),
      };
      return {
        ...state,
        findingSeq: state.findingSeq + 1,
        stages: patchStage(state.stages, id, { findings: [...target.findings, item] }),
      };
    }
    default:
      return state;
  }
}

/** 错误事件定位节点：优先错误自带 stage，其次当前活跃节点。 */
export function markStageError(
  state: OnboardingWorkbenchState,
  stageId: OnboardingStreamStageId | undefined,
): OnboardingWorkbenchState {
  const target = stageId && ONBOARDING_STAGE_ORDER.includes(stageId) ? stageId : state.activeStage;
  if (!target) return state;
  return {
    ...state,
    stages: patchStage(state.stages, target, { status: 'error', finishedAt: Date.now() }),
  };
}

export interface OnboardingFindingTotals {
  subject: number;
  exam: number;
  concept: number;
  edge: number;
  question: number;
  goal: number;
  repair: number;
}

export function countFindings(stages: readonly OnboardingStageState[]): OnboardingFindingTotals {
  const totals: OnboardingFindingTotals = {
    subject: 0, exam: 0, concept: 0, edge: 0, question: 0, goal: 0, repair: 0,
  };
  for (const stage of stages) {
    for (const finding of stage.findings) {
      if (finding.kind === 'subject' || finding.kind === 'discipline') totals.subject += 1;
      else if (finding.kind in totals) totals[finding.kind as keyof OnboardingFindingTotals] += 1;
    }
  }
  return totals;
}

export function stageDurationSeconds(stage: OnboardingStageState, now: number): number | null {
  if (stage.startedAt == null) return null;
  const end = stage.finishedAt ?? now;
  return Math.max(0, (end - stage.startedAt) / 1000);
}

export function mapErrorNext(next: string | undefined): string | null {
  if (!next) return null;
  switch (next) {
    case 'settings':
      return '请前往模型设置核对端点、密钥与模型名称。';
    case 'offline_manual':
      return '你可以先改用离线手动配置，或稍后重试 AI 推演。';
    default:
      return next;
  }
}
