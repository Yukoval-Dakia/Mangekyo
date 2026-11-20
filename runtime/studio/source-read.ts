import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId, type Revision} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {intakeFactType} from '../../modules/activity/intake-values.ts';
import {goalType, materialType, storagePurpose, studyGoal} from '../../modules/activity/library-values.ts';
import {organizerNote, organizerNoteType, organizerTask, organizerTaskType} from '../../modules/activity/organizer-values.ts';
import {practiceSubmission, ridingPracticeType} from '../../modules/activity/practice-values.ts';
import {isSourceFactId, sourceReference, sourceRefV1, type SourceAnchorV1} from '../../modules/activity/source-values.ts';
import {studyRecord} from '../../modules/activity/values.ts';
import {workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {
  WorkspaceInputError, workspaceEntry, workspaceEntryType, workspaceShareableTypes,
  type WorkspaceEntryKind,
} from '../../modules/activity/workspace-values.ts';
import {displayOf, syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';
import {intakeTextOf, isMaterialIntakePair, materialIntakeReference, materialTextOf, relatedIntakeId, relatedMaterialId, textSlice} from './reading.ts';

export type SourceReadMode = 'pinned' | 'following';
export type SourceTrack = (fact: FactSnapshot, mode?: SourceReadMode) => void;
export type WorkspaceSourceRecipient = (fact: FactSnapshot) => boolean;
export type SourceAccess = { track?: SourceTrack } & (
  | {recipient: 'learner'}
  | {recipient: 'workspace'; maySend: WorkspaceSourceRecipient}
);

export function sourcePurpose(access: SourceAccess): string {
  return access.recipient === 'learner' ? storagePurpose : purpose;
}

export function sourceMaySend(access: SourceAccess, fact: FactSnapshot): boolean {
  return access.recipient === 'learner' || access.maySend(fact);
}
type SourceProjection = {
  title: string;
  content: string | number | null;
  kind?: WorkspaceEntryKind;
  tags?: readonly string[];
  links?: readonly string[];
};

function intakeDocumentForRead(fact: FactSnapshot) {
  const document = intakeTextOf(fact);
  return {content: document.extraction.text, field: 'text', title: document.title};
}

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

function searchText(fact: FactSnapshot, content: SourceProjection['content']): string {
  const prompts = (questions: readonly {prompt: string}[]) => questions.map(question => question.prompt).join(' ');
  switch (fact.type) {
    case workbookPaperType: return prompts(workbookPaper(fact.value).questions);
    case workbookAttemptType: return prompts(workbookAttempt(fact.value).paper.questions);
    case ridingPracticeType: return prompts(practiceSubmission(fact.value).paper.questions);
    case goalType: return studyGoal(fact.value).text ?? '';
    case organizerTaskType: return organizerTask(fact.value).date;
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

function project(fact: FactSnapshot, anchor: SourceAnchorV1): SourceProjection | undefined {
  try {
    if (anchor.kind === 'answer-slot') {
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
    } else {
      const {title, text, kind, links} = displayOf(fact.type, fact.value);
      const tags = fact.type === workspaceEntryType ? workspaceEntry(fact.value).tags : undefined;
      return {title, content: text, ...(kind ? {kind} : {}), ...(tags ? {tags} : {}), ...(links ? {links} : {})};
    }
  } catch {
    return;
  }
  return undefined;
}

export async function resolveSource(tx: ReadTransaction, input: unknown, access: SourceAccess, mode: SourceReadMode = 'pinned') {
  const reference = sourceRefV1(input);
  const textReference = reference?.textFact;
  if (textReference && (reference.fact.type !== materialType || textReference.type !== intakeFactType ||
      textReference.id !== relatedIntakeId(factId(reference.fact.id)))) return;
  const id = reference?.fact.id ?? input;
  if (!isSourceFactId(id) || (mode !== 'pinned' && mode !== 'following')) return;
  const anchor: SourceAnchorV1 = reference?.anchor ?? {kind: 'whole'};
  const reader = createCommandReadContext(tx, sourcePurpose(access));
  const seen = new Map<string, FactSnapshot>();
  const path = new Set<string>();
  const accepts = (fact: FactSnapshot) => sourceMaySend(access, fact);
  const rootType = (fact: FactSnapshot) =>
    (!reference || fact.type === reference.fact.type) &&
    (workspaceShareableTypes.includes(fact.type) || fact.type === intakeFactType);

  async function visit(key: string, revision?: Revision): Promise<FactSnapshot | undefined> {
    if (path.has(key) || path.size >= 32 || seen.size >= 1024 || syntheticStudyRecords.has(key)) return;
    if (seen.has(key)) return seen.get(key);
    const fact = await reader.fact(factId(key), revision === undefined ? {mode: 'following'} : {mode: 'pinned', rev: revision});
    if (!accepts(fact) || (key === id && !rootType(fact))) return;
    if (fact.type === workspaceEntryType) {
      const entry = workspaceEntry(fact.value);
      path.add(key);
      for (const witness of entry.basis) {
        const source = await visit(witness.id);
        if (!source || source.ref.rev !== witness.rev || source.accessEpoch !== witness.epoch) return;
      }
      if (!entry.links.every(link => seen.has(link))) return;
      path.delete(key);
    }
    seen.set(key, fact);
    return fact;
  }
  try {
    const rootRevision = reference?.fact.rev as Revision | undefined;
    if (reference && mode === 'following') {
      const original = await reader.fact(factId(id), {mode:'pinned', rev:rootRevision as Revision});
      if (!rootType(original) || !accepts(original)) return;
      if (textReference) {
        const text = await reader.fact(factId(textReference.id), {mode:'pinned', rev:textReference.rev as Revision});
        if (original.type !== materialType || !isMaterialIntakePair(original.ref.id, text) || !accepts(text)) return;
        const oldText = intakeTextOf(text).text;
        const originalAnchor = anchor.kind === 'text' ? (() => {
          const {offset, nextOffset} = textSlice(oldText, anchor.start, Math.max(0, anchor.end-anchor.start));
          return {...anchor, start:offset, end:nextOffset ?? oldText.length};
        })() : anchor;
        if (!project(text, originalAnchor)) return;
      } else if (!project(original, anchor)) return;
    }
    const fact = await visit(id, mode === 'pinned' ? rootRevision : undefined);
    if (!fact) return;
    let body = fact;
    let linkedMaterial: FactSnapshot | undefined;
    if (fact.type === materialType || fact.type === intakeFactType) {
      const documentId = fact.type === materialType ? relatedIntakeId(fact.ref.id) : factId(id);
      const documentRevision = textReference?.rev as Revision | undefined;
      // Check for a missing current fact before visiting a pinned revision. Only
      // a genuinely unpaired material may use its own text.
      let currentDocument: FactSnapshot;
      try {
        currentDocument = await reader.fact(documentId, {mode: 'following'});
      } catch (error) {
        if (!(error instanceof FactNotFoundError)) throw error;
        if (fact.type !== materialType || textReference) return;
        const projection = project(fact, anchor);
        if (!projection) return;
        access.track?.(fact, reference ? mode : undefined);
        return {id: fact.ref.id, rev: fact.ref.rev, sourceRef: sourceReference(fact, anchor), ...projection};
      }
      if (currentDocument.type !== intakeFactType || !accepts(currentDocument)) return;
      const material = fact.type === materialType ? fact : await visit(relatedMaterialId(currentDocument));
      if (!material || material.type !== materialType || !isMaterialIntakePair(material.ref.id, currentDocument)) return;
      const document = fact.type === intakeFactType ? fact :
        mode === 'pinned' && documentRevision !== undefined
          ? await reader.fact(documentId, {mode: 'pinned', rev: documentRevision})
          : currentDocument;
      if (!accepts(document) || !isMaterialIntakePair(material.ref.id, document)) return;
      seen.set(documentId, document);
      linkedMaterial = material;
      body = document;
    }
    const projectionAnchor = (mode === 'following' && anchor.kind === 'text' && body.type === intakeFactType)
      ? {...anchor, end:Math.min(anchor.end, intakeTextOf(body).text.length)} : anchor;
    const projection = project(body, projectionAnchor);
    if (!projection) return;
    for (const witness of seen.values()) {
      const isReferenced = witness === fact ? reference : witness === body ? textReference : undefined;
      access.track?.(witness, isReferenced ? mode : undefined);
    }
    return {...projection, id: fact.ref.id, rev: fact.ref.rev, sourceRef: body === fact ? sourceReference(fact, projectionAnchor) : materialIntakeReference(linkedMaterial!, body, projectionAnchor)};
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError || error instanceof WorkspaceInputError) return;
    throw error;
  }
}
