import { formatShortDateTime } from '../shared/format-time';
import type { MemoryOverviewResponse } from './types';

export function CalibrationCard({ calibration }: { calibration: MemoryOverviewResponse['calibration'] }) {
  const total = Math.max(0, calibration.totalReconciliations);
  const confirmed = Math.max(0, Math.min(calibration.confirmed, total));
  const missed = Math.max(0, total - confirmed);
  const hitRate = total ? confirmed / total : 0;
  const available = calibration.status === 'available' && total > 0;

  return (
    <section className="calibration-card" aria-labelledby="memory-calibration-title">
      <div className="subhead">
        <h2 id="memory-calibration-title">系统判断校准对账</h2>
      </div>
      {available ? (
        <>
          <div className="calibration-summary">
            <div className="calibration-ratio" role="img" aria-label={`命中 ${confirmed} 次，落空 ${missed} 次，共 ${total} 次`}>
              <div className="calibration-track">
                <span className="calibration-hit" style={{ width: `${hitRate * 100}%` }} />
                <span className="calibration-miss" style={{ width: `${(1 - hitRate) * 100}%` }} />
              </div>
              <div className="calibration-copy">
                <strong>{Math.round(hitRate * 100)}%</strong>
                <span>命中</span>
              </div>
            </div>
            <p>
              系统事前判断 <strong>{confirmed}</strong> 次命中，<strong>{missed}</strong> 次落空，累计 <strong>{total}</strong> 次对账。
            </p>
          </div>
          <ul className="calibration-list">
            {calibration.recent.map((item) => (
              <li key={item.key}>
                <div>
                  <strong>{item.status === 'confirmed' ? '命中' : item.status === 'missed' ? '落空' : '记录'}</strong>
                  <p>{item.conceptId ? `概念 ${item.conceptId}` : '未关联概念'}</p>
                </div>
                <time>{formatShortDateTime(item.occurredAt, '时间未知')}</time>
              </li>
            ))}
            {!calibration.recent.length && <li className="memory-empty">暂无近期对账记录</li>}
          </ul>
        </>
      ) : (
        <div className="calibration-empty">
          <p>尚无足够独立对账记录，暂不展示命中率。</p>
          <p>系统会持续累积事前判断与实际结果的独立对照。</p>
        </div>
      )}
    </section>
  );
}
