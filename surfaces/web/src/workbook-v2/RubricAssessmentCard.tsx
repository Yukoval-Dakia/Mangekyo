import { useState } from 'react';
import MathText from '../math-text.tsx';
import { errorStageLabel } from '../learning-labels.ts';
import type { WorkbookV2Assessment } from './types.ts';

// 既有调用方从本模块导入，保持 re-export 以兼容。
export { errorStageLabel };

export function verdictMeta(assessment: WorkbookV2Assessment | undefined): {
  label: string;
  tone: 'ok' | 'warn' | 'info';
} | null {
  if (!assessment || assessment.verdict === 'pending') return null;
  if (assessment.verdict === 'correct') return { label: '正确', tone: 'ok' };
  if (assessment.verdict === 'partial') return { label: '部分正确', tone: 'info' };
  return { label: '待订正', tone: 'warn' };
}

export function RubricAssessmentCard({ assessment }: { assessment: WorkbookV2Assessment }) {
  const stage = errorStageLabel(assessment.errorStage);
  const score = assessment.score;
  return (
    <section className="wbv2-rubric" aria-label="评分标准批改结果">
      {(stage || score) && (
        <div className="wbv2-rubric-meta">
          {stage && <span className="wbv2-stage-badge">错因环节 · {stage}</span>}
          {score && <span className="wbv2-score-badge">得分 {score.earned} / {score.maximum}</span>}
        </div>
      )}
      {assessment.feedback.trim() !== '' && (
        <div className="wbv2-feedback-row">
          <span className="wbv2-feedback-label">AI 评语</span>
          <div className="wbv2-feedback-value">
            <MathText text={assessment.feedback} />
          </div>
        </div>
      )}
      {assessment.evidence.length > 0 && (
        <div className="wbv2-feedback-row">
          <span className="wbv2-feedback-label">原文依据</span>
          <ul className="wbv2-evidence-list">
            {assessment.evidence.map((entry, index) => (
              <li key={index}>
                <MathText text={entry} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AssessTrigger({
  assessing,
  onAssess,
}: {
  assessing: boolean;
  onAssess: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (assessing) {
    return (
      <p className="wbv2-attach-note info" role="status">
        正在请模型按评分标准批改…
      </p>
    );
  }
  if (!confirming) {
    return (
      <button type="button" className="wbv2-btn wbv2-btn--tonal" onClick={() => setConfirming(true)}>
        按评分标准批改
      </button>
    );
  }
  return (
    <div className="wbv2-confirm" role="group" aria-label="确认批改">
      <p className="wbv2-confirm-text">将本题与你的作答发往当前评阅模型按评分标准批改。</p>
      <div className="wbv2-confirm-actions">
        <button type="button" className="wbv2-btn wbv2-btn--primary" onClick={() => { setConfirming(false); onAssess(); }}>
          确认批改
        </button>
        <button type="button" className="wbv2-btn wbv2-btn--ghost" onClick={() => setConfirming(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

export function MarkCorrectedButton({
  busy,
  recorded,
  onMark,
}: {
  busy: boolean;
  recorded: boolean;
  onMark: () => void;
}) {
  if (recorded) {
    return (
      <span className="wbv2-verdict is-ok wbv2-corrected-badge" role="status">
        已订正
      </span>
    );
  }
  return (
    <button type="button" className="wbv2-btn wbv2-btn--tonal" disabled={busy} onClick={onMark}>
      {busy ? '正在记录…' : '标记已完成订正'}
    </button>
  );
}
