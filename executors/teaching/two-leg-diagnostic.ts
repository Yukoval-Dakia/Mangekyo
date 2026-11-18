type Leg = { speed: number; duration: number };

export type TwoLegVariant = readonly [Leg, Leg];

export type TwoLegAverageSpeedDiagnostic = {
  kind: 'two_leg_average_speed';
  originalLegs: TwoLegVariant;
};

const reasonText = {
  ambiguous_original: '原题用两种不同的方法都可能得到同一个数，换一个条件可以分清你用的是哪种。',
  assisted_only: '这份旧作是在有帮助的情况下完成的，我想看看你独立作答时会怎么想。',
  missing_method: '想看清你的关键步骤，再判断接下来该讲哪一步。',
  response_unclear: '想通过一道具体的题，确认你刚才表达的意思。',
} as const;

export type DiagnosticReason = keyof typeof reasonText;

export const twoLegDiagnosticFormat = [
  '选择 diagnostic_question 时，以 question 和 originalLegs 给出的最初两段行程为原题。即使 followUp 的上一步是另一道迁移题，diagnostic_question 也只用于回到这道原题做变式。',
  '用 diagnosticLegs 提供两个对象，每个对象含正数 speed（公里/小时）和 duration（小时），只改原题的一个数字条件。',
  '用 diagnosticReasons 选择一到两项实际有依据的理由。ambiguous_original 表示原题作答符合不同解法，assisted_only 表示所引用的旧作记录了先看完整例题或获得帮助，missing_method 表示作答未展示关键步骤，response_unclear 表示追答的意思仍需确认。',
  '保留 evidenceIds。选择 assisted_only 时必须引用本轮实际读到的帮助记录。系统会由所选理由和数值生成 rationale 和 nextStep，请省略这两个自由文本字段。',
].join(' ');

export function readDiagnosticReasons(value: unknown, evidenceIds: readonly string[]): DiagnosticReason[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return undefined;
  if (!value.every((reason: unknown): reason is DiagnosticReason => typeof reason === 'string' && Object.hasOwn(reasonText, reason))) {
    return undefined;
  }
  if (value.includes('assisted_only') && evidenceIds.length === 0) return undefined;
  return [...new Set(value)];
}

export function renderDiagnosticReasons(reasons: readonly DiagnosticReason[]): string {
  return reasons.map(reason => reasonText[reason]).join('');
}

function readLeg(value: unknown): Leg | undefined {
  if (typeof value !== 'object' || value === null || !('speed' in value) || !('duration' in value)) return;
  const { speed, duration } = value;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return;
  return { speed, duration };
}

export function readTwoLegVariant(value: unknown): TwoLegVariant | undefined {
  if (!Array.isArray(value) || value.length !== 2) return;
  const first = readLeg(value[0]);
  const second = readLeg(value[1]);
  return first && second ? [first, second] : undefined;
}

export function twoLegProblem([first, second]: TwoLegVariant): string {
  return `一名骑车人先以每小时 ${first.speed} 公里的速度骑了 ${first.duration} 小时，再以每小时 ${second.speed} 公里的速度骑了 ${second.duration} 小时。全程平均速度是多少？`;
}

export function checkTwoLegVariant(original: TwoLegVariant, candidate: TwoLegVariant | undefined): string | undefined {
  if (!candidate) return;
  const [first, second] = candidate;
  const originalValues = original.flatMap(({ speed, duration }) => [speed, duration]);
  const values = [first.speed, first.duration, second.speed, second.duration];
  if (values.filter((value, index) => value !== originalValues[index]).length !== 1) return;

  const combined = (first.speed * first.duration + second.speed * second.duration) / (first.duration + second.duration);
  const unweighted = (first.speed + second.speed) / 2;
  if (!Number.isFinite(combined) || !Number.isFinite(unweighted)) return;
  const tolerance = Math.max(combined, unweighted) * Number.EPSILON * 16;
  if (Math.abs(combined - unweighted) <= tolerance) return;
  return twoLegProblem(candidate) + '请写出关键算式或说明理由。';
}
