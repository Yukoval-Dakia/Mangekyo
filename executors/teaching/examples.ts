import { twoLegProblem, type TwoLegAverageSpeedDiagnostic } from './two-leg-diagnostic.ts';

export const first45Diagnostic = {
  kind: 'two_leg_average_speed',
  originalLegs: [
    { speed: 30, duration: 1 },
    { speed: 60, duration: 1 },
  ],
} as const satisfies TwoLegAverageSpeedDiagnostic;

export const first45Question = twoLegProblem(first45Diagnostic.originalLegs);

export const first45Answer = '45 公里/小时。';

export const first45Histories = {
  independent: [
    {
      id: 'work-01',
      title: '分段行程练习',
      body: [
        '题目：一辆车以 24 公里/小时行驶 2 小时，再以 36 公里/小时行驶 1 小时。全程平均速度是多少？',
        '学生草稿：前一段走了 24×2=48 公里，后一段走了 36×1=36 公里，一共走了 84 公里，用了 3 小时，平均 84÷3=28 公里/小时。',
        '课堂记录：这是第一次见到的题。学生独立作答、提交后才打开反馈，提交前未见提示和解答。',
      ].join('\n'),
    },
    {
      id: 'work-02',
      title: '速度单位换算练习',
      body: '题目：把每秒 5 米换算成每小时多少千米。学生草稿：一小时 3600 秒，18000 米是 18 千米。',
    },
  ],
  workedExample: [
    {
      id: 'work-01',
      title: '分段行程练习',
      body: [
        '题目：一辆车以 24 公里/小时行驶 2 小时，再以 36 公里/小时行驶 1 小时。全程平均速度是多少？',
        '先展示的完整例题：前一段走了 24×2=48 公里，后一段走了 36×1=36 公里，一共走了 84 公里，用了 3 小时，平均 84÷3=28 公里/小时。',
        '学生草稿：28 公里/小时。课堂记录：学生在完整例题下填答，没有留下独立列式。',
      ].join('\n'),
    },
    {
      id: 'work-02',
      title: '速度单位换算练习',
      body: '题目：把每秒 5 米换算成每小时多少千米。学生草稿：一小时 3600 秒，18000 米是 18 千米。',
    },
  ],
};
