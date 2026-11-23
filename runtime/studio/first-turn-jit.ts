import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { isFactUnavailable, purposeReader } from './fact-read-helpers.ts';
import type { Db, ReadTransaction } from '../../kernel/src/index.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { firstTurnJitMessages, type FirstTurnJitRoute, type FirstTurnJitSlots, type FirstTurnJitTokenizer } from '../../executors/teaching/first-turn-jit.ts';
import { providerEndpoint, type TeachingProvider } from '../../executors/teaching/provider.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { workbookAttemptType } from '../../modules/activity/workbook-values.ts';
import { readCurrentLearningObject } from './current-learning-object.ts';
import { purpose } from './identity.ts';
import { textSlice } from './reading.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkbookQuestionSources } from './workbook-diagnosis.ts';
import { workspaceInput, type WorkspaceWitness } from './workspace-agent.ts';

export type StudioJitCounter = FirstTurnJitRoute & {
  readonly id: string;
  readonly providerId: string;
  readonly tokenizer: FirstTurnJitTokenizer;
};

type RouteSettings = TeachingProvider & { activeProviderId: string; protocol: FirstTurnJitRoute['protocol']; model: string };
type Turn = ReturnType<typeof studyTurn>;
type Access = { maySend: WorkspaceSourceRecipient; authorize(tx: ReadTransaction): Promise<void> };

export function studioJitCounter(counters: readonly StudioJitCounter[], settings: RouteSettings) {
  return counters.find(counter => counter.providerId === settings.activeProviderId && counter.model === settings.model &&
    counter.protocol === settings.protocol && counter.endpoint === providerEndpoint(settings));
}

function witness(fact: Parameters<WorkspaceSourceRecipient>[0], mode: WorkspaceWitness['mode'] = 'following'): WorkspaceWitness {
  return {id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type, mode};
}

// A previous wrong answer is useful here only when both attempts used the same
// frozen paper and its ordinary, deterministic grading recorded an incorrect answer.
async function oldMistake(tx: ReadTransaction, turn: string, current: WorkspaceWitness, maySend: WorkspaceSourceRecipient) {
  const read = purposeReader(tx, maySend);
  const open = async (id: string) => {
    const basis: WorkspaceWitness[] = [];
    try {
      const fact = await read.fact(factId(id), {mode: 'following'});
      if (fact.type !== workbookAttemptType) return;
      const source = await openWorkbookQuestionSources(tx, fact, {maySend, track: (ref, mode) => basis.push(witness(ref, mode))});
      return source && {...source, fact, basis: [witness(fact), ...basis]};
    } catch (error) {
      if (!isFactUnavailable(error)) throw error;
      return;
    }
  };
  const attempt = await open(current.id);
  const question = attempt?.attempt.paper.questions[0];
  if (!attempt || attempt.fact.ref.rev !== current.rev || !question || attempt.attempt.paper.questions.length !== 1 ||
      attempt.attempt.paper.assessmentRelease || question.kind === 'rubric') return;
  const {rows} = await tx.query<{id: string}>(`
    SELECT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    JOIN facts turn ON turn.learner_id=f.learner_id AND turn.id=$5
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND f.id<>$3
      AND f.created_tick<$4 AND r.tick<turn.created_tick AND r.data->>'paperId'=$6
      AND r.data->'feedback' @> $7::jsonb
      AND f.purpose && ARRAY['teaching','all'] AND r.purpose && ARRAY['teaching','all']
    ORDER BY f.created_tick DESC, f.id LIMIT 4`, [tx.learner, workbookAttemptType, current.id, attempt.birth.tick, turn,
      attempt.paper.id, JSON.stringify([{questionId: question.id, result: 'incorrect'}])]);
  for (const {id} of rows) {
    const older = await open(id);
    if (!older || !older.birth.unchanged || older.paper.rev !== attempt.paper.rev) continue;
    const answer = older.attempt.answers[question.id];
    if (answer === null || answer === undefined || String(answer).trim() === '') continue;
    return {evidence: {ref: id, rev: older.fact.ref.rev,
      text: '同版题目旧答判错：' + textSlice(String(answer), 0, 36).content}, basis: [...attempt.basis, ...older.basis]};
  }
  return undefined;
}

export async function prepareFirstTurnJit(db: Db, learner: ReadTransaction['learner'], turn: string, submission: Turn,
  settings: RouteSettings, counter: StudioJitCounter, access: Access) {
  let opened: Awaited<ReturnType<typeof collect>> | undefined;
  async function collect(tx: ReadTransaction) {
    const selection = submission.currentObject;
    const current = selection && await readCurrentLearningObject(tx, selection, access.maySend);
    if (selection && (!current || current.basisDigest !== selection.basisDigest)) return;
    const older = current && selection?.kind === 'attempt' ? await oldMistake(tx, turn, current.root, access.maySend) : undefined;
    const slots: FirstTurnJitSlots = {
      ...(current ? {anchor: {version: {ref: current.root.id, rev: current.root.rev,
        text: current.view.alias + ' · ' + textSlice(current.view.title, 0, 40).content}}} : {}),
      ...(older ? {bridge: {oldMistake: older.evidence}} : {}),
    };
    const basis = [...new Map([...(current?.basis ?? []), ...(older?.basis ?? [])]
      .map(item => [canonicalJsonString(workspaceInput(item)), item])).values()];
    const frame = firstTurnJitMessages({version: 1 as const, slots, tokenizer: counter.tokenizer}, settings);
    const digest = createHash('sha256').update(canonicalJsonString(frame)).digest('hex');
    return {context: {version: 1 as const, slots, tokenizer: counter.tokenizer}, receipt: JSON.stringify({digest, basis}), basis, current};
  }
  const receipt = await recordLocalRead(db, {
    learner, ownerKind: 'session', ownerId: turn, stepKey: 'jit-v1', label: 'local:first-turn-jit',
    input: {version: 1, purpose, providerId: settings.activeProviderId, endpoint: counter.endpoint,
      protocol: settings.protocol, model: settings.model, reasoningEffort: settings.reasoningEffort ?? 'high',
      workspaceRevision: submission.workspaceRevision!, accountRevision:submission.accountRevision!, counter: counter.id},
  }, async tx => {
    opened = await collect(tx);
    return opened?.receipt ?? '';
  }, access.authorize);
  if (!receipt) return;
  opened ??= await db.snapshot({learner}, async tx => {
    await access.authorize(tx);
    return collect(tx);
  });
  if (opened?.receipt !== receipt) return;
  return opened;
}

export async function jitWitnessesCurrent(tx: ReadTransaction, basis: readonly WorkspaceWitness[], maySend: WorkspaceSourceRecipient) {
  const read = purposeReader(tx, maySend);
  try {
    for (const item of basis) await read.reopen({...workspaceInput(item), type: item.type});
    return true;
  } catch (error) {
    if (!isFactUnavailable(error)) throw error;
    return false;
  }
}
