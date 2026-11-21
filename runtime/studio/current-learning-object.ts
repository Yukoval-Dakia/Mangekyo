import { studyObjectBasisDigest, type StudyObjectWitness } from '../../modules/activity/current-object-basis.ts';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createAuthorizedFactReader } from '../../kernel/src/commands/reads.ts';
import { factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { sourceReference } from '../../modules/activity/source-values.ts';
import type { StudyCurrentObjectSelection } from '../../modules/activity/values.ts';
import { workbookAnswerText } from '../../modules/activity/workspace-projection.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { workspaceEntry, workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { purpose } from './identity.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkbookDiagnosisSource } from './workbook-diagnosis.ts';

export function currentObjectAlias(kind: StudyCurrentObjectSelection['kind']) {
  return kind === 'attempt' ? 'current_attempt' : 'current_page';
}

export function readCurrentLearningObject(tx: ReadTransaction, selection: StudyCurrentObjectSelection,
  maySend: WorkspaceSourceRecipient, ownerNotionRead?: true) {
  return readable(async () => {
    const {kind, id, rev} = selection;
    const fact = await createAuthorizedFactReader(tx, purpose, maySend).fact(factId(id), {mode: 'pinned', rev: rev as Revision});
    const sourceRef = sourceReference(fact, {kind: 'whole'});
    const witnesses = new Map<string, StudyObjectWitness>();
    const track: SourceTrack = (source, mode = 'following') => {
      const {id, rev} = source.ref;
      const key = `${id}:${rev}`;
      if (mode === 'pinned' && witnesses.has(key)) return;
      witnesses.set(key, {id, rev, type: source.type, epoch: source.accessEpoch, mode});
    };
    const access = {maySend, track, ...(ownerNotionRead && {ownerNotionRead})};
    let title: string;
    let original: string;
    let hasAnswer = false;
    let answerSlot: string | undefined;
    if (kind === 'attempt') {
      if (fact.type !== workbookAttemptType) return;
      // The saved attempt embeds a copy of its workbook. The diagnosis reader
      // checks the frozen paper and source prompts before that copy can be used.
      const opened = await openWorkbookDiagnosisSource(tx, sourceRef, access);
      if (!opened) return;
      const {paper, answers} = opened.attempt;
      title = opened.source.title;
      original = workbookAnswerText(opened.attempt, true);
      if (paper.questions.length === 1) answerSlot = paper.questions[0]?.id;
      hasAnswer = Object.values(answers).some(answer => typeof answer === 'number' || Boolean(answer?.trim()));
    } else {
      if (fact.type !== textbookPageType && fact.type !== organizerNoteType &&
          (fact.type !== workspaceEntryType || workspaceEntry(fact.value).kind !== 'page')) return;
      const page = await resolveSource(tx, sourceRef, {recipient: 'workspace', ...access});
      if (!page || typeof page.content !== 'string') return;
      title = page.title;
      original = page.content;
    }
    const root = witnesses.get(`${id}:${rev}`);
    if (!root) return;
    const basis = [...witnesses.values()].sort((a, b) => a.id.localeCompare(b.id) || a.rev - b.rev);
    const basisDigest = await studyObjectBasisDigest(basis);
    const {content, nextOffset} = textSlice(original, 0, 3000);
    return {
      root, basis, basisDigest, answerSlot, openedAnswer: hasAnswer && nextOffset === null,
      view: {alias: currentObjectAlias(kind), sourceRef, title, content, truncated: nextOffset !== null},
    };
  });
}

export type OpenedCurrentLearningObject = NonNullable<Awaited<ReturnType<typeof readCurrentLearningObject>>>;
