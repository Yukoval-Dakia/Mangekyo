import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId, type Revision} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {intakeFactType} from '../../modules/activity/intake-values.ts';
import {materialType, storagePurpose} from '../../modules/activity/library-values.ts';
import {organizerNote, organizerNoteType} from '../../modules/activity/organizer-values.ts';
import {isSourceFactId, sourceReference, sourceRefV1, type SourceAnchorV1} from '../../modules/activity/source-values.ts';
import {studyRecord} from '../../modules/activity/values.ts';
import {workbookAttempt, workbookAttemptType} from '../../modules/activity/workbook-values.ts';
import {
  WorkspaceInputError, workspaceEntry, workspaceEntryType, workspaceShareableTypes,
  type WorkspaceEntryKind,
} from '../../modules/activity/workspace-values.ts';
import {displayOf, syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';
import {intakeTextOf, materialIntakeReference, materialTextOf, relatedIntakeId, relatedMaterialId, textSlice} from './reading.ts';

export type SourceReadMode = 'pinned' | 'following';
export type SourceTrack = (fact: FactSnapshot, mode?: SourceReadMode) => void;
export type WorkspaceSourceRecipient = (fact: FactSnapshot) => boolean;
type SourceAccess =
  | {recipient: 'learner'}
  | {recipient: 'workspace'; maySend: WorkspaceSourceRecipient; track?: SourceTrack};
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
  const textReference = input && typeof input === 'object' && 'textFact' in input ? sourceRefV1({...input, fact:input.textFact}) : undefined;
  if (input && typeof input === 'object' && 'textFact' in input && !textReference) return;
  const id = reference?.fact.id ?? input;
  if (!isSourceFactId(id) || (mode !== 'pinned' && mode !== 'following')) return;
  const anchor: SourceAnchorV1 = reference?.anchor ?? {kind: 'whole'};
  const reader = createCommandReadContext(tx, access.recipient === 'learner' ? storagePurpose : purpose);
  const seen = new Map<string, FactSnapshot>();
  const path = new Set<string>();
  const accepts = (fact: FactSnapshot) => access.recipient === 'learner' || access.maySend(fact);
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
        const text = await reader.fact(factId(textReference.fact.id), {mode:'pinned', rev:textReference.fact.rev as Revision});
        const oldText = text.type === intakeFactType ? intakeTextOf(text).text : '';
        const originalAnchor = anchor.kind === 'text' ? (() => {
          const {offset, nextOffset} = textSlice(oldText, anchor.start, Math.max(0, anchor.end-anchor.start));
          return {...anchor, start:offset, end:nextOffset ?? oldText.length};
        })() : anchor;
        if (text.type !== intakeFactType || !accepts(text) || !project(text, originalAnchor)) return;
      } else if (!project(original, anchor)) return;
    }
    const fact = await visit(id, mode === 'pinned' ? rootRevision : undefined);
    if (!fact) return;
    let body = fact;
    let linkedMaterial: FactSnapshot | undefined;
    if (fact.type === materialType || fact.type === intakeFactType) {
      const documentId = fact.type === materialType ? relatedIntakeId(fact) : factId(id);
      const documentRevision = (textReference?.fact.rev ?? (reference?.fact.type === intakeFactType && documentId === reference.fact.id
        ? reference.fact.rev : undefined)) as Revision | undefined;
      const document = await visit(documentId, mode === 'pinned' ? documentRevision : undefined);
      if (!document || document.type !== intakeFactType) {
        if (fact.type !== materialType || document || reference || mode === 'following') return;
        const projection = project(fact, anchor);
        if (access.recipient === 'workspace') access.track?.(fact);
        return projection ? {id: fact.ref.id, sourceRef: sourceReference(fact, anchor), ...projection} : undefined;
      }
      const material = fact.type === materialType ? fact : await visit(relatedMaterialId(document));
      if (!material || material.type !== materialType || relatedIntakeId(material) !== documentId) return;
      linkedMaterial = material;
      body = document;
    }
    const projectionAnchor = (mode === 'following' && anchor.kind === 'text' && body.type === intakeFactType)
      ? {...anchor, end:Math.min(anchor.end, intakeTextOf(body).text.length)} : anchor;
    const projection = project(body, projectionAnchor);
    if (!projection) return;
    if (access.recipient === 'workspace') {
      for (const witness of seen.values()) access.track?.(witness, reference && witness === fact ? mode : undefined);
    }
    return {...projection, id: fact.ref.id, rev: fact.ref.rev, sourceRef: body === fact ? sourceReference(fact, projectionAnchor) : materialIntakeReference(linkedMaterial!, body, projectionAnchor)};
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError || error instanceof WorkspaceInputError) return;
    throw error;
  }
}
