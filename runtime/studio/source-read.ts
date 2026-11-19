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
import {purpose, stableId} from './identity.ts';
import {intakeTextOf, materialTextOf} from './reading.ts';

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
      if (!source || source.field !== anchor.field || anchor.end > source.text.length) return;
      const content = source.text.slice(anchor.start, anchor.end);
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
    if (reference && mode === 'following') {
      const original = await reader.fact(factId(id), {mode: 'pinned', rev: reference.fact.rev as Revision});
      if (!rootType(original) || !accepts(original) || !project(original, anchor)) return;
    }
    const fact = await visit(id, mode === 'pinned' ? reference?.fact.rev as Revision | undefined : undefined);
    if (!fact) return;
    const projection = project(fact, anchor);
    if (!projection) return;
    if (fact.type === intakeFactType) {
      const document = intakeTextOf(fact);
      if (stableId('intake-document', document.materialId) !== id) return;
      const material = await reader.fact(document.materialId, {mode: 'following'});
      if (material.type !== materialType || !accepts(material)) return;
    }
    if (access.recipient === 'workspace') {
      for (const witness of seen.values()) access.track?.(witness, reference && witness === fact ? mode : undefined);
    }
    return {sourceRef: sourceReference(fact, anchor), ...projection};
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError || error instanceof WorkspaceInputError) return;
    throw error;
  }
}
