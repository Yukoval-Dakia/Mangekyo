import type { Confidence } from './types.ts';
import { CONFIDENCE_LABELS } from './types.ts';

const LEVELS: readonly Confidence[] = [1, 2, 3, 4, 5];

export function ConfidenceSelector({
  value,
  onChange,
  disabled,
}: {
  value: Confidence | null;
  onChange: (next: Confidence | null) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <div className="wbv2-confidence">
      <div className="wbv2-confidence-label">
        <span>这题的把握度</span>
        <small>选填，再点一次可取消</small>
      </div>
      <div className="wbv2-confidence-row" role="group" aria-label="把握度">
        {LEVELS.map((level) => {
          const active = value === level;
          return (
            <button
              key={level}
              type="button"
              className="wbv2-conf"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(active ? null : level)}
            >
              <b>{level}</b>
              {CONFIDENCE_LABELS[level]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
