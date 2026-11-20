import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { organizerNoteType } from '../../modules/activity/organizer-values.ts';
import { sourceReference } from '../../modules/activity/source-values.ts';
import type { StudyCurrentObjectSelection } from '../../modules/activity/values.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { workspaceEntry, workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { purpose } from './identity.ts';
import { textSlice } from './reading.ts';
import { resolveSource, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkbookDiagnosisSource } from './workbook-diagnosis.ts';
import type { WorkspaceWitness } from './workspace-agent.ts';

export function currentObjectAlias(kind: StudyCurrentObjectSelection['kind']) {
  return kind === 'attempt' ? 'current_attempt' : 'current_page';
}

export async function readCurrentLearningObject(tx: ReadTransaction, selection: StudyCurrentObjectSelection,
  maySend: WorkspaceSourceRecipient) {
  try {
    const {kind, id, rev} = selection;
    const fact = await createCommandReadContext(tx, purpose).fact(factId(id), {mode: 'pinned', rev: rev as Revision});
    if (!maySend(fact)) return;
    const sourceRef = sourceReference(fact, {kind: 'whole'});
    const witnesses = new Map<string, WorkspaceWitness>();
    const track: SourceTrack = (source, mode = 'following') => {
      const {id, rev} = source.ref;
      const key = `${id}:${rev}`;
      if (mode === 'pinned' && witnesses.has(key)) return;
      witnesses.set(key, {id, rev, type: source.type, epoch: source.accessEpoch, mode});
    };
    let title: string;
    let original: string;
    let hasAnswer = false;
    if (kind === 'attempt') {
      if (fact.type !== workbookAttemptType) return;
      // The saved attempt embeds a copy of its workbook. The diagnosis reader
      // checks the frozen paper and source prompts before that copy can be used.
      const opened = await openWorkbookDiagnosisSource(tx, sourceRef, {maySend, track});
      if (!opened) return;
      const {paper, answers} = opened.attempt;
      title = opened.source.title;
      original = paper.questions.map(({id, prompt}, index) =>
        `${index + 1}. ${prompt}\n我的作答：${answers[id] ?? '未作答'}`).join('\n\n');
      hasAnswer = Object.values(answers).some(answer => typeof answer === 'number' || Boolean(answer?.trim()));
    } else {
      if (fact.type !== textbookPageType && fact.type !== organizerNoteType &&
          (fact.type !== workspaceEntryType || workspaceEntry(fact.value).kind !== 'page')) return;
      const page = await resolveSource(tx, sourceRef, {recipient: 'workspace', maySend, track});
      if (!page || typeof page.content !== 'string') return;
      title = page.title;
      original = page.content;
    }
    const root = witnesses.get(`${id}:${rev}`);
    if (!root) return;
    const basis = [...witnesses.values()].sort((a, b) => a.id.localeCompare(b.id) || a.rev - b.rev);
    const basisDigest = createHash('sha256').update(canonicalJsonString(basis)).digest('hex');
    const {content, nextOffset} = textSlice(original, 0, 3000);
    return {
      root, basis, basisDigest, openedAnswer: hasAnswer && nextOffset === null,
      view: {alias: currentObjectAlias(kind), sourceRef, title, content, truncated: nextOffset !== null},
    };
  } catch (error) {
    if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    return undefined;
  }
}

export type OpenedCurrentLearningObject = NonNullable<Awaited<ReturnType<typeof readCurrentLearningObject>>>;
