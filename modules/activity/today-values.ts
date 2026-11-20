import type { FactSnapshot } from '@mangekyo/kernel';
import { studyRecordFact } from './values.ts';
import { workbookAttempt, workbookPaper, workbookAttemptType } from './workbook-values.ts';

function todayMode(mode: string): 'any' | 'one-hand' | 'voice' {
  if (mode !== 'any' && mode !== 'one-hand' && mode !== 'voice') throw new Error('学习模式无效。');
  return mode;
}

export function todaySettings(params: URLSearchParams, now: string) {
  const mode = todayMode(params.get('mode') ?? 'any');
  const timeZone = params.get('timeZone') ?? 'Asia/Tokyo';
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
  const previous = params.get('lastOpenedAt');
  const lastOpenedAt = previous === null ? undefined : new Date(previous).toISOString();
  if (lastOpenedAt && lastOpenedAt > now) throw new Error('上次打开时间无效。');
  return { mode, timeZone, now, ...(lastOpenedAt ? { lastOpenedAt } : {}), dayOf: (at: string) => clock.format(new Date(at)) };
}

export function todayCompletion(fact: FactSnapshot, today: string, dayOf: (at: string) => string) {
  if (fact.type === workbookAttemptType) {
    const attempt = workbookAttempt(fact.value);
    return dayOf(attempt.submittedAt) === today ? attempt.paperId + '/' + attempt.paper.savedAt : null;
  }
  const record = studyRecordFact(fact.value);
  return record.offlinePack && record.submittedAt && dayOf(record.submittedAt) === today
    ? record.offlinePack.id + '@' + record.offlinePack.rev : null;
}

export function todayPaper(fact: FactSnapshot, completed: ReadonlySet<string | null>, day: string) {
  const paper = workbookPaper(fact.value);
  // The ordinary workbook route can reopen a learner-authored fixed paper. It
  // does not attest that an external question release still meets its policy.
  if (paper.materialId || paper.assessmentRelease || paper.questions.some(q => q.sourceQuestionRef)) return;
  const { id, rev } = fact.ref;
  return {
    id: id + '@' + rev,
    title: paper.title,
    topic: paper.title,
    kind: 'review' as const,
    minutes: Math.min(1440, paper.questions.length * 3),
    durationBasis: '按每题约 3 分钟估算。',
    input: 'write' as const,
    open: { kind: 'activity' as const, id, rev },
    reason: '这份自编练习已经保存，可以直接作答。',
    evidence: [id + '@' + rev],
    delayImpact: '推迟后，这份练习的本次作答结果仍未知。',
    ...(completed.has(id + '/' + paper.savedAt) ? { state: 'completed' as const, date: day } : {}),
  };
}
