import { factId, readable, type ReadTransaction, type Revision } from '../../kernel/src/index.ts';
import { studyObjectBasisDigest, type StudyObjectWitness } from '../../modules/activity/current-object-basis.ts';
import { organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { sourceReference } from '../../modules/activity/source-values.ts';
import type { StudyCurrentObjectSelection } from '../../modules/activity/values.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { workbookAnswerText } from '../../modules/activity/workspace-projection.ts';
import { workspaceEntry, workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { hasAttemptAnswerContent, sortStudyObjectBasis } from '../../modules/content/workspace-slice.ts';
import { purposeReader, toWitness } from './identity.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkbookDiagnosisSource } from './workbook-diagnosis.ts';
export function currentObjectAlias(kind: StudyCurrentObjectSelection['kind']) { return kind === 'attempt' ? 'current_attempt' : 'current_page'; }
export function readCurrentLearningObject(tx: ReadTransaction, selection: StudyCurrentObjectSelection, maySend: WorkspaceSourceRecipient, ownerNotionRead?: true) {
  return readable(async () => {
    const { kind, id, rev } = selection;
    const fact = await purposeReader(tx, maySend).fact(factId(id), { mode: 'pinned', rev: rev as Revision });
    const sourceRef = sourceReference(fact, { kind: 'whole' }), witnesses = new Map<string, StudyObjectWitness>();
    const track: SourceTrack = (source, mode = 'following') => {
      const key = `${source.ref.id}:${source.ref.rev}`;
      if (!(mode === 'pinned' && witnesses.has(key))) witnesses.set(key, toWitness(source, mode));
    };
    const access = { maySend, track, ...(ownerNotionRead && { ownerNotionRead }) };
    let title: string, original: string, hasAnswer = false, answerSlot: string | undefined;
    if (kind === 'attempt') {
      if (fact.type !== workbookAttemptType) return;
      const opened = await openWorkbookDiagnosisSource(tx, sourceRef, access);
      if (!opened) return;
      title = opened.source.title;
      original = workbookAnswerText(opened.attempt, true);
      if (opened.attempt.paper.questions.length === 1) answerSlot = opened.attempt.paper.questions[0]?.id;
      hasAnswer = hasAttemptAnswerContent(opened.attempt.answers);
    } else {
      if (fact.type !== textbookPageType && fact.type !== organizerNoteType && (fact.type !== workspaceEntryType || workspaceEntry(fact.value).kind !== 'page')) return;
      const page = await resolveSource(tx, sourceRef, { recipient: 'workspace', ...access });
      if (!page || typeof page.content !== 'string') return;
      title = page.title;
      original = page.content;
    }
    const root = witnesses.get(`${id}:${rev}`);
    if (!root) return;
    const basis = sortStudyObjectBasis(witnesses.values()), basisDigest = await studyObjectBasisDigest(basis), { content, nextOffset } = textSlice(original, 0, 3000);
    return { root, basis, basisDigest, answerSlot, openedAnswer: hasAnswer && nextOffset === null, view: { alias: currentObjectAlias(kind), sourceRef, title, content, truncated: nextOffset !== null }, };
  });
}
export type OpenedCurrentLearningObject = NonNullable<Awaited<ReturnType<typeof readCurrentLearningObject>>>;
