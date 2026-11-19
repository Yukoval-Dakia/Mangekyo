import type { WorkbookExpected } from '../../../modules/activity/workbook-values.ts';

export function ExpectedView({ expected }: { expected: WorkbookExpected }) {
  return expected.kind === 'rubric' ? (
    <span>
      评分标准（{expected.rubricVersion}）：<span className="workbook-rubric-text">{expected.rubric}</span>
    </span>
  ) : expected.kind === 'numeric' ? (
    <span>
      参考答案：<strong>{String(expected.value)}</strong> ± {String(expected.tolerance)}
      {expected.unit ? ' ' + expected.unit : ''}
    </span>
  ) : (
    <span>
      参考答案：{expected.values.map((value) => <code key={value}>{value}</code>)}
    </span>
  );
}
