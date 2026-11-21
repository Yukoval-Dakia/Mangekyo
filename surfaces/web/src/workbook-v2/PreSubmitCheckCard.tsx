import type { PreSubmitPitfall } from './types.ts';

export function PreSubmitCheckCard({
  pitfalls,
  onAnchor,
  onContinue,
  onConfirm,
}: {
  pitfalls: readonly PreSubmitPitfall[];
  onAnchor: (itemId: string) => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  return (
    <section className="wbv2-pre-submit-card" role="dialog" aria-modal="false" aria-label="交卷前自检">
      <header>
        <h3>交卷前自检</h3>
        <p>先检查这些容易出错的地方，再确认交卷。</p>
      </header>
      <ul>
        {pitfalls.map((pitfall) => (
          <li key={pitfall.text}>
            <p>{pitfall.text}</p>
            <div className="wbv2-pre-submit-anchors">
              {pitfall.anchors.map((anchor) => (
                <button key={anchor.itemId} type="button" onClick={() => onAnchor(anchor.itemId)}>
                  第 {anchor.number} 题
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <footer>
        <button type="button" className="wbv2-pre-submit-secondary" onClick={onContinue}>
          继续检查
        </button>
        <button type="button" className="wbv2-pre-submit-primary" onClick={onConfirm}>
          确认交卷
        </button>
      </footer>
    </section>
  );
}
