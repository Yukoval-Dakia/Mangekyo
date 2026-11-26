import { useMemo } from 'react';
import { formatDurationZh } from '../shared/format-time.ts';
import type { ExamTimeValueState, ExamTimeValueView } from './types.ts';

const STATE_LABELS: Record<ExamTimeValueState, string> = {
  steady: '稳健',
  'fast-slip': '快错',
  'time-sink': '耗时卡壳',
  'recovered-skip': '先跳后攻',
  unknown: '待定',
};

export function ExamTimeValueBar({
  value,
  focusedItemId,
  onJump,
}: {
  value: ExamTimeValueView | undefined;
  focusedItemId: string | undefined;
  onJump: (itemId: string) => void;
}) {
  const items = useMemo(
    () => (value?.kind === 'observed' ? [...value.items].sort((left, right) => left.position - right.position) : []),
    [value],
  );
  if (value?.kind !== 'observed' || items.length === 0) return null;
  const totalDurationMs = Math.max(1, value.total_duration_ms);
  const legendStates = [...new Set(items.map((item) => item.state))];

  return (
    <section className="wbv2-time-value" aria-label="答题节奏分布">
      <header className="wbv2-time-value-head">
        <h3>答题节奏分布</h3>
        <p>{value.summary}</p>
      </header>
      <p className="wbv2-time-value-total">总有效用时 {formatDurationZh(value.total_duration_ms)}</p>
      <div className="wbv2-time-value-track">
        {items.map((item) => {
          const label = `第 ${item.position} 题 · ${STATE_LABELS[item.state]} · ${formatDurationZh(item.effective_duration_ms)}`;
          return (
            <button
              key={item.item_id}
              type="button"
              className={`wbv2-time-segment is-${item.state}${focusedItemId === item.item_id ? ' is-focused' : ''}`}
              style={{ flexBasis: `${Math.max(2, (item.effective_duration_ms / totalDurationMs) * 100)}%` }}
              aria-current={focusedItemId === item.item_id ? 'true' : undefined}
              aria-label={label}
              title={label}
              onClick={() => onJump(item.item_id)}
            >
              <span aria-hidden="true">{item.position}</span>
            </button>
          );
        })}
      </div>
      <ul className="wbv2-time-value-legend" aria-label="答题节奏图例">
        {legendStates.map((state) => (
          <li key={state} className={`wbv2-time-legend is-${state}`}>
            <i aria-hidden="true" />
            {STATE_LABELS[state]}
          </li>
        ))}
      </ul>
    </section>
  );
}
