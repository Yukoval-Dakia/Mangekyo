import type { FactSnapshot } from '@mangekyo/kernel';
import { intakeDocument, intakeFactType } from '@mangekyo/module-capture/facts/intake-document';
import { parseTextbookPage, textbookPageFrom, textbookPageType, type TextbookBlockBody } from '@mangekyo/module-content/facts/textbook-page';
import goalFact from '@mangekyo/module-plan/facts/goal';
import taskFact from '@mangekyo/module-plan/facts/organizer-task';
import { materialType, textMaterial } from './library-values.ts';
import { organizerNote, organizerNoteType } from './organizer-values.ts';
import { practiceSubmission, ridingPracticeType } from './practice-values.ts';
import { sourceReference, type SourceAnchorV1, type SourceRefV1 } from './source-values.ts';
import { workspaceRecordKind } from './workspace-search.ts';
import { studyRecord } from './values.ts';
import { workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType } from './workbook-values.ts';
import { activityQuestions, activityWorkspaceDisplay, openedQuestionText, cleanText, summary, type WorkspaceDisplay } from './workspace-projection.ts';
import { workspaceEntry, workspaceEntryType, type LearningOverview, type WorkspaceEntryKind } from './workspace-values.ts';

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

export type OpenedLearningRecord = {
  ok?: true;
  id?: string;
  sourceRef?: SourceRefV1;
  content?: unknown;
  question?: {prompt:string};
  assessments?: unknown[];
  nextOffset?: number;
  error?: unknown;
} & Record<string, unknown>;

type OpenedLearningPart = {kind:'whole' | 'assessment'} | {kind:'block'; blockId:string} | {kind:'question'; index:number};

/** Adapt the already authorized record to the requested visible part. */
export function projectOpenedLearning(value: OpenedLearningRecord, fact: FactSnapshot, part: OpenedLearningPart): OpenedLearningRecord | undefined {
  const {sourceRef, question, nextOffset, ...body} = value;
  if (!sourceRef) return value;
  if (part.kind === 'block') {
    const block = fact.type === textbookPageType && sourceRef.anchor.kind === 'whole'
      ? textbookPageFrom(fact).blocks.find(block => block.id === part.blockId) : undefined;
    if (!block) return;
    return {id:sourceRef.fact.id,rev:sourceRef.fact.rev,kind:'page',title:value.title,content:textbookText(block.body),
      part,sourceRef:{...sourceRef,anchor:part}};
  }
  if (part.kind === 'question') {
    const item = sourceRef.anchor.kind === 'whole' ? sourceQuestions(fact)[part.index - 1] : undefined;
    if (!item) return;
    const {assessments: _assessments, ...record} = body;
    return {...record, content:item.prompt, part, sourceRef:{...sourceRef,anchor:{kind:'question',itemId:item.id}}};
  }
  if (part.kind === 'assessment') {
    return {id:sourceRef.fact.id, rev:sourceRef.fact.rev, title:value.title, sourceRef, part, assessments:value.assessments ?? []};
  }
  if (sourceRef.anchor.kind === 'whole' && (question || fact.type === workbookPaperType ||
      fact.type === workbookAttemptType || fact.type === ridingPracticeType)) {
    return {...body, sourceRef, content:openedQuestionText(fact)};
  }
  return {...body, sourceRef, ...(nextOffset !== undefined ? {nextOffset} : {})};
}

export function workspaceReadRecord(record: SourceProjection & { sourceRef: SourceRefV1 }, offset: number, assessments: unknown[]) {
  const {sourceRef, title, tags, links, blocks} = record;
  const original = record.content;
  const {content, nextOffset} = typeof original === 'string'
    ? textSlice(original, offset) : {content: original, nextOffset: null};
  return {id: sourceRef.fact.id, rev: sourceRef.fact.rev, kind: record.kind ?? workspaceRecordKind(sourceRef.fact.type),
    title, content, tags, links, sourceRef, ...(blocks ? {blocks} : {}),
    ...(record.question ? {question:record.question} : {}), ...(assessments.length ? {assessments} : {}),
    ...(nextOffset === null ? {} : {nextOffset})};
}

export function retentionEvidenceLink(fact: FactSnapshot, itemId: string, href: string) {
  const ref = { id: fact.ref.id, rev: fact.ref.rev, type: fact.type };
  if (fact.type !== workbookPaperType && fact.type !== workbookAttemptType) return { ...ref, href };
  const anchor = fact.type === workbookPaperType ? { kind: 'question', itemId } as const
    : { kind: 'answer-slot', itemId, slotId: 'answer' } as const;
  return { ...ref, open: { tool: 'open_learning', args: { refs: JSON.stringify(sourceReference(fact, anchor)) } } };
}

export function radarOverview({ goal, tasks }: LearningOverview, limit: number) {
  const active = 'items' in tasks ? tasks.items.filter(task => !task.done).slice(0, limit) : [];
  return {
    witnessIds: [...(goal.state === 'set' ? [goal.witness.id] : []), ...active.map(task => task.id)],
    view: {
      goal: goal.state === 'set' ? { ...goal, text: goal.text === null ? null : textSlice(goal.text, 0, 240).content } : goal,
      tasks: active.length
        ? { state: tasks.state, items: active.map(task => ({ ...task, title: textSlice(task.title, 0, 100).content })) }
        : { state: tasks.state === 'partial' || tasks.state === 'unavailable' ? 'unknown' : 'empty' },
    },
  };
}

export function radarInventory(papers: readonly { id: string; rev: number; title: string; sourceRef: SourceRefV1 }[]) {
  return papers.length ? { state: 'available', items: papers.map(({ id, rev, title, sourceRef }) =>
    ({ id, rev, title: textSlice(title, 0, 100).content, sourceRef, kind: 'paper', status: 'ready', usage: 'unknown' })) }
    : { state: 'unknown' };
}
