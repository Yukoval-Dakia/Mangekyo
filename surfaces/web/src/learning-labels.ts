// 后端枚举 → 学习者可读中文。展示层统一在这里归一化，
// 未知的纯英文标识符必须落到中文兜底，绝不把后端枚举直接裸露给学习者。

const ERROR_STAGE_LABELS: Record<string, string> = {
  reading: '审题漏条件',
  comprehension: '审题漏条件',
  modeling: '概念与建模',
  strategy: '思路与策略',
  execution: '计算与执行',
  expression: '表达规范',
};

const HYPOTHESIS_STATUS_LABELS: Record<string, string> = {
  active: '活跃',
  tentative: '初步观察',
  observed: '初步观察',
  supported: '已有依据',
  disputed: '存在反例',
  contested: '存在反例',
  needs_review: '待核对',
  improving: '正在好转',
  retired: '已解决',
  relapsed: '再次出现',
};

const ATTEMPT_VERDICT_LABELS: Record<string, string> = {
  correct: '答对',
  incorrect: '答错',
  partial: '部分正确',
  pending: '待评阅',
  unanswered: '未作答',
  'self-check': '自评',
  unknown: '已作答',
  ungraded: '已作答',
  submitted: '已作答',
};

function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

function labelFor(
  value: string | null | undefined,
  labels: Record<string, string>,
  fallback: string,
): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  return labels[raw.toLowerCase()] ?? (containsNonAscii(raw) ? raw : fallback);
}

export function errorStageLabel(stage: string | null | undefined): string | null {
  return labelFor(stage, ERROR_STAGE_LABELS, '其他失分环节');
}

export function hypothesisStatusLabel(status: string | null | undefined): string {
  return labelFor(status, HYPOTHESIS_STATUS_LABELS, '观察中') ?? '观察中';
}

export function attemptVerdictLabel(verdict: string | null | undefined): string {
  return labelFor(verdict, ATTEMPT_VERDICT_LABELS, '已作答') ?? '已作答';
}
