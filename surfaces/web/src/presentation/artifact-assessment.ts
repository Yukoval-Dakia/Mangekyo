import { isRecord } from '../../../shared/presentation/schema.ts';

type RevisionRef = { id: string; rev: number };
export interface ArtifactAssessment {
  releaseRef: RevisionRef;
  submissionRef: RevisionRef;
  state: 'queued' | 'complete' | 'incomplete' | 'blocked' | 'failed';
  score: { earned: number; maximum: number } | null;
  reason?: string;
  outcomes: { state: string; reason?: string }[];
}

function revisionRef(value: unknown): value is RevisionRef {
  return isRecord(value) && typeof value.id === 'string' && !!value.id &&
    typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev > 0;
}

export function decodeAssessment(raw: unknown): ArtifactAssessment | undefined {
  if (!isRecord(raw) || !revisionRef(raw.releaseRef) || !revisionRef(raw.submissionRef)) return;
  const { state, score, result, reason } = raw;
  if (state !== 'queued' && state !== 'complete' && state !== 'incomplete' && state !== 'blocked' && state !== 'failed') return;
  let points: ArtifactAssessment['score'] = null;
  if (score !== null) {
    if (!isRecord(score) || typeof score.earned !== 'number' || !Number.isFinite(score.earned) ||
        typeof score.maximum !== 'number' || !Number.isFinite(score.maximum) || score.maximum <= 0) return;
    points = { earned: score.earned, maximum: score.maximum };
  }
  const outcomes: ArtifactAssessment['outcomes'] = [];
  if (result !== undefined) {
    if (!isRecord(result) || !Array.isArray(result.outcomes)) return;
    for (const entry of result.outcomes) {
      if (!isRecord(entry) || typeof entry.state !== 'string') return;
      outcomes.push({ state: entry.state, ...(typeof entry.reason === 'string' && { reason: entry.reason }) });
    }
  }
  return { releaseRef: raw.releaseRef, submissionRef: raw.submissionRef, state, outcomes,
    score: points,
    ...(typeof reason === 'string' && { reason }) };
}

export function sameAssessment(a: ArtifactAssessment, b: ArtifactAssessment) {
  return a.submissionRef.id === b.submissionRef.id && a.submissionRef.rev === b.submissionRef.rev &&
    a.releaseRef.id === b.releaseRef.id && a.releaseRef.rev === b.releaseRef.rev;
}

export function assessmentMessage({ state, score, outcomes, reason }: ArtifactAssessment) {
  switch (state) {
    case 'queued': return '已交卷，等待评分。';
    case 'complete': return score ? `正式得分　${score.earned} / ${score.maximum}` : '评估已完成，无数值成绩。';
    case 'incomplete': {
      const missing = outcomes.find(outcome => outcome.state === 'unsubmitted');
      return missing ? (missing.reason || '未提交作答。') : '作答证据不足，暂无成绩。';
    }
    case 'blocked': return '暂时无法评分。' + (reason || '');
    case 'failed': return '评分失败。' + (reason || outcomes.find(o => o.state === 'failed')?.reason || '');
  }
}
