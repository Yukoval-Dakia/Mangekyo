import type { FactSnapshot } from '@mangekyo/kernel';
import { materialType, textMaterial } from './library-values.ts';
import { organizerNote, organizerNoteType } from './organizer-values.ts';
import { practiceSubmission, ridingPracticeType } from './practice-values.ts';
import { studyRecord, studyRecordType } from './values.ts';
import { workspaceEntry, workspaceEntryType, type WorkspaceEntryKind } from './workspace-values.ts';
import { workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType, type WorkbookExpected } from './workbook-values.ts';

export type WorkspaceDisplay = {
  readonly title: string;
  readonly excerpt: string;
  readonly text: string;
  readonly kind?: WorkspaceEntryKind;
  readonly links?: readonly string[];
  readonly tags?: readonly string[];
  readonly question?: {prompt:string; answer?:string; rubric?:string};
};

export function cleanText(value: string, limit?: number): string {
  return value.replace(/\u0000/g, '').slice(0, limit);
}

export function summary(value: string, limit = 240): string {
  const compact = cleanText(value).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact;
}

function expectedText(expected: WorkbookExpected): string {
  if (expected.kind === 'numeric') {
    return String(expected.value) + (expected.unit ? ' ' + expected.unit : '') +
      '（容差 ' + String(expected.tolerance) + '）';
  }
  if (expected.kind === 'exact') return expected.values.join(' / ');
  return '评分标准：' + expected.rubric;
}

function practiceDisplay(value: unknown): WorkspaceDisplay {
  const practice = practiceSubmission(value);
  const questions = practice.paper.questions.map((question, index) =>
    String(index + 1) + '. ' + question.prompt + (question.unit ? '（' + question.unit + '）' : '')
  ).join('\n');
  const feedback = practice.feedback.map((item, index) =>
    String(index + 1) + '. ' + item.result +
    '\n   我的作答：' + (item.answer === null ? '未作答' : String(item.answer)) +
    '\n   参考答案：' + String(item.expected) +
    '\n   说明：' + item.explanation
  ).join('\n');
  const text = practice.paper.title + '\n\n' + questions + '\n\n本次反馈\n' + feedback;
  return { title: practice.paper.title, excerpt: summary(questions), text: cleanText(text) };
}

function paperDisplay(value: unknown): WorkspaceDisplay {
  const paper = workbookPaper(value);
  const questions = paper.questions.map((question, index) => {
    const head = String(index + 1) + '. ' + question.prompt;
    if (question.kind === 'numeric') {
      return head + '\n   答案：' + String(question.answer) + (question.unit ? ' ' + question.unit : '') +
        '\n   容差：' + String(question.tolerance);
    }
    if (question.kind === 'exact') return head + '\n   答案：' + question.answers.join(' / ');
    if (question.kind === 'bank') return head;
    return head + '\n   评分标准：' + question.rubric;
  }).join('\n');
  const source = paper.materialId ? '\n来源材料：' + paper.materialId : '';
  const text = paper.title + '\n保存于：' + paper.savedAt + source + '\n\n' + questions;
  return { title: paper.title, excerpt: summary(questions), text: cleanText(text) };
}

function attemptDisplay(value: unknown): WorkspaceDisplay {
  const attempt = workbookAttempt(value);
  const questions = attempt.paper.questions.map((question, index) => {
    const feedback = attempt.feedback.find((item) => item.questionId === question.id);
    const answer = attempt.answers[question.id];
    return String(index + 1) + '. ' + question.prompt +
      '\n   我的作答：' + (answer === null || answer === undefined ? '未作答' : String(answer)) +
      (feedback ? '\n   反馈：' + feedback.result +
        (feedback.expected ? '\n   参考答案：' + expectedText(feedback.expected) : '') +
        (feedback.explanation ? '\n   说明：' + feedback.explanation : '') : '');
  }).join('\n');
  const title = attempt.paper.title;
  return {
    title,
    excerpt: summary('提交于 ' + attempt.submittedAt + ' · ' + attempt.feedback.length + ' 题'),
    text: cleanText(title + '\n提交于：' + attempt.submittedAt + '\n\n' + questions),
  };
}

function entryDisplay(value: unknown): WorkspaceDisplay {
  const {kind,title,body,tags,links,answer,rubric} = workspaceEntry(value);
  const details = [
    body,
    answer ? '参考答案\n' + answer : '',
    rubric ? '评分标准\n' + rubric : '',
    tags.length ? '标签：' + tags.join('、') : '',
    links.length ? '关联：' + links.join('、') : '',
  ].filter(Boolean).join('\n\n');
  return {
    title,
    excerpt: summary(body || details || kind),
    text: cleanText(title + '\n类型：' + kind + '\n\n' + details),
    kind,
    links,
    tags,
    ...(kind === 'question' ? {question:{prompt:body, ...(answer ? {answer} : {}), ...(rubric ? {rubric} : {})}} : {}),
  };
}

export function activityQuestions(fact: FactSnapshot): readonly {id: string; prompt: string}[] | undefined {
  if (fact.type === workbookPaperType) return workbookPaper(fact.value).questions.map(({id, prompt}) => ({id, prompt}));
  if (fact.type === workbookAttemptType) return workbookAttempt(fact.value).paper.questions.map(({id, prompt}) => ({id, prompt}));
  if (fact.type === ridingPracticeType) return practiceSubmission(fact.value).paper.questions.map(({id, prompt}) => ({id, prompt}));
  if (fact.type === workspaceEntryType) {
    const entry = workspaceEntry(fact.value);
    if (entry.kind === 'question') return [{id: 'question', prompt: entry.body}];
  }
  return undefined;
}

// The caller authorizes the snapshot and selects the full learner-facing projection.
export function activityWorkspaceDisplay(type: string, value: unknown): WorkspaceDisplay | undefined {
  switch (type) {
    case ridingPracticeType: return practiceDisplay(value);
    case workbookPaperType: return paperDisplay(value);
    case workbookAttemptType: return attemptDisplay(value);
    case workspaceEntryType: return entryDisplay(value);
    case organizerNoteType: {
      const note = organizerNote(value);
      const source = note.source ? '\n来源材料：' + note.source.title + '（' + note.source.id + '）' : '';
      return {title: note.title, excerpt: summary(note.markdown), text: cleanText(note.title + source + '\n\n' + note.markdown)};
    }
    case studyRecordType:
    case materialType: {
      const record = type === materialType ? textMaterial(value) : studyRecord(value);
      return {title: record.title, excerpt: summary(record.text), text: cleanText(record.title + '\n\n' + record.text)};
    }
  }
  return undefined;
}
