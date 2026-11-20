import type { FactSnapshot } from '@mangekyo/kernel';
import { intakeDocument, intakeFactType } from '@mangekyo/module-capture/facts/intake-document';
import { parseTextbookPage, textbookPageFrom, textbookPageType, type TextbookBlockBody } from '@mangekyo/module-content/facts/textbook-page';
import goalFact from '@mangekyo/module-plan/facts/goal';
import taskFact from '@mangekyo/module-plan/facts/organizer-task';
import { materialType, textMaterial } from './library-values.ts';
import { organizerNote, organizerNoteType } from './organizer-values.ts';
import { practiceSubmission, ridingPracticeType } from './practice-values.ts';
import type { SourceAnchorV1 } from './source-values.ts';
import { studyRecord } from './values.ts';
import { workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType } from './workbook-values.ts';
import { activityQuestions, activityWorkspaceDisplay, cleanText, summary, type WorkspaceDisplay } from './workspace-projection.ts';
import { workspaceEntry, workspaceEntryType, type WorkspaceEntryKind } from './workspace-values.ts';

export function materialTextOf(fact: FactSnapshot) {
  const material = textMaterial(fact.value);
  return {field: 'text', ...material};
}

export function intakeTextOf(fact: FactSnapshot) {
  const document = intakeDocument(fact.value);
  return {field: 'text', ...document, text: document.extraction.text};
}

export function textSlice(text: string, offset: number, limit = 4000) {
  let start = Math.min(offset, text.length);
  const low = (index: number) => index >= 0 && index < text.length && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (low(start)) start--;
  let end = Math.min(start + limit, text.length);
  if (low(end)) end--;
  const content = text.slice(start, end);
  return {content, offset: start, nextOffset: end < text.length ? end : null};
}

function goalDisplay(value: unknown): WorkspaceDisplay {
  const goal = goalFact.schema.parse(value);
  if (goal.text === null) {
    return { title: '未设置目标', excerpt: '当前没有学习目标。', text: '当前没有学习目标。' };
  }
  return { title: '学习目标', excerpt: summary(goal.text), text: cleanText(goal.text) };
}

function taskDisplay(value: unknown): WorkspaceDisplay {
  const task = taskFact.schema.parse(value);
  const status = task.done ? '已完成' : '未完成';
  const text = task.title + '\n日期：' + task.date + '\n状态：' + status;
  return { title: task.title, excerpt: status + ' · ' + task.date, text: cleanText(text) };
}

function textbookDisplay(value: unknown): WorkspaceDisplay {
  const { title, blocks } = parseTextbookPage(value);
  const text = blocks.flatMap(({ body }) => {
    switch (body.kind) {
      case 'text': return [body.text];
      case 'formula': return [body.latex];
      case 'table': return body.rows.map(row => row.join(' ｜ '));
      default: return [];
    }
  }).join('\n\n');
  return { title, text: cleanText(text), excerpt: summary(text), kind: 'page' };
}

export function displayOf(type: string, value: unknown): WorkspaceDisplay {
  try {
    if (type === textbookPageType) return textbookDisplay(value);
    if (type === goalFact.type) return goalDisplay(value);
    if (type === taskFact.type) return taskDisplay(value);
    const display = activityWorkspaceDisplay(type, value);
    if (display) return display;
  } catch {
    // A malformed legacy fact must not make the learner's whole access page disappear.
  }
  return {
    title: '无法显示的记录',
    excerpt: '这条记录的格式暂时无法显示，但不会被提供给模型。',
    text: '这条记录的格式暂时无法显示。',
  };
}

type SourceProjection = {
  title: string;
  content: string | number | null;
  kind?: WorkspaceEntryKind;
  tags?: readonly string[];
  links?: readonly string[];
  blocks?: readonly {id:string; parentId:string | null; kind:TextbookBlockBody['kind']}[];
  question?: {prompt:string; answer?:string; rubric?:string};
};

function sourceText(fact: FactSnapshot) {
  switch (fact.type) {
    case materialType: return materialTextOf(fact);
    case 'activity.studyRecord': return {field: 'text', ...studyRecord(fact.value)};
    case intakeFactType: return intakeTextOf(fact);
    case organizerNoteType: {
      const note = organizerNote(fact.value);
      return {field: 'markdown', title: note.title, text: note.markdown};
    }
    case workspaceEntryType: {
      const entry = workspaceEntry(fact.value);
      return {field: 'body', title: entry.title, text: entry.body};
    }
  }
  return undefined;
}

export function textbookText(body: TextbookBlockBody) {
  switch (body.kind) {
    case 'text': return body.text;
    case 'formula': return body.latex;
    case 'table': return body.rows.map(row => row.join(' | ')).join('\n');
    default: return '';
  }
}

function searchText(fact: FactSnapshot, content: SourceProjection['content']): string {
  const prompts = (questions: readonly {prompt: string}[]) => questions.map(question => question.prompt).join(' ');
  switch (fact.type) {
    case workbookPaperType: return prompts(workbookPaper(fact.value).questions);
    case workbookAttemptType: return prompts(workbookAttempt(fact.value).paper.questions);
    case ridingPracticeType: return prompts(practiceSubmission(fact.value).paper.questions);
    case goalFact.type: return goalFact.schema.parse(fact.value).text ?? '';
    case taskFact.type: return taskFact.schema.parse(fact.value).date;
    case materialType: return typeof content === 'string' ? content : '';
    default: return sourceText(fact)?.text ?? '';
  }
}

export function sourceSearchExcerpt(fact: FactSnapshot, content: SourceProjection['content']): string {
  try {
    const text = searchText(fact, content).replace(/\s+/g, ' ').trim();
    if (text.length <= 240) return text;
    return textSlice(text, 0, 239).content + '…';
  } catch {
    return '';
  }
}

export function sourceQuestions(fact: FactSnapshot) {
  return activityQuestions(fact) ?? [];
}

export function projectSource(fact: FactSnapshot, anchor: SourceAnchorV1, recipient: 'learner' | 'workspace'): SourceProjection | undefined {
  try {
    if (anchor.kind === 'question') {
      const question = sourceQuestions(fact).find(item => item.id === anchor.itemId);
      if (question) return {title: displayOf(fact.type, fact.value).title, content: question.prompt};
    } else if (anchor.kind === 'block') {
      if (fact.type !== textbookPageType) return;
      const page = textbookPageFrom(fact);
      const block = page.blocks.find(block => block.id === anchor.blockId);
      if (block) return {kind:'page',title:page.title,content:textbookText(block.body)};
    } else if (anchor.kind === 'answer-slot') {
      if (fact.type !== workbookAttemptType || anchor.slotId !== 'answer' || anchor.path?.length) return;
      const attempt = workbookAttempt(fact.value);
      const answer = attempt.answers[anchor.itemId];
      if (answer !== undefined && Object.hasOwn(attempt.answers, anchor.itemId))
        return {title: attempt.paper.title, content: answer};
    } else if (anchor.kind === 'text') {
      const source = sourceText(fact);
      if (!source || source.field !== anchor.field) return;
      if (anchor.end > source.text.length) return;
      let start = anchor.start;
      let end = Math.min(anchor.end, source.text.length);
      if (start > 0 && start < source.text.length && source.text.charCodeAt(start-1) >= 0xd800 && source.text.charCodeAt(start-1) <= 0xdbff &&
          source.text.charCodeAt(start) >= 0xdc00 && source.text.charCodeAt(start) <= 0xdfff) start--;
      if (end < source.text.length && source.text.charCodeAt(end-1) >= 0xd800 && source.text.charCodeAt(end-1) <= 0xdbff &&
          source.text.charCodeAt(end) >= 0xdc00 && source.text.charCodeAt(end) <= 0xdfff) end--;
      const content = source.text.slice(start, end);
      if (content.isWellFormed()) return {title: source.title, content};
    } else if (fact.type === intakeFactType) {
      return {title:intakeTextOf(fact).title, content:intakeTextOf(fact).extraction.text};
    } else if (recipient === 'workspace' && fact.type === organizerNoteType) {
      const note = organizerNote(fact.value);
      return {title: note.title, content: note.markdown};
    } else if (recipient === 'workspace' && fact.type === textbookPageType) {
      const page = textbookPageFrom(fact);
      return {kind: 'page', title: page.title, content: page.blocks.map(block => textbookText(block.body)).filter(Boolean).join('\n\n'),
        ...(page.tags ? {tags:page.tags} : {}), blocks:page.blocks.map(({id,parentId,body}) => ({id,parentId,kind:body.kind}))};
    } else if (recipient === 'workspace' && fact.type === workbookPaperType) {
      const paper = workbookPaper(fact.value);
      return {title: paper.title, content: paper.questions.map(({prompt}, index) => `${index + 1}. ${prompt}`).join('\n\n')};
    } else if (recipient === 'workspace' && fact.type === workbookAttemptType) {
      const {paper, answers, feedback} = workbookAttempt(fact.value);
      const content = paper.questions.map(({id, prompt}, index) => {
        const verdict = feedback.find(item => item.questionId === id)?.result;
        return `${index + 1}. ${prompt}\n我的作答：${answers[id] ?? '未作答'}` + (verdict ? `\n反馈：${verdict}` : '');
      }).join('\n\n');
      return {title: paper.title, content};
    } else {
      const {title, text, kind, links, question} = displayOf(fact.type, fact.value);
      const tags = fact.type === workspaceEntryType ? workspaceEntry(fact.value).tags : undefined;
      return {title, content: text, ...(kind ? {kind} : {}), ...(tags ? {tags} : {}), ...(links ? {links} : {}), ...(question ? {question} : {})};
    }
  } catch {
    return;
  }
  return undefined;
}
