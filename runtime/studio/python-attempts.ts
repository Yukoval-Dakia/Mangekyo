import {pythonAttemptsLimit, type PythonAttemptRow, type PythonAttemptsRead} from '../../executors/teaching/agent-tools.ts';
import {createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import {isSourceFactId} from '../../modules/activity/source-values.ts';
import {workbookAttempt, workbookAttemptType, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {purpose} from './identity.ts';
import type {SourceTrack, WorkspaceSourceRecipient} from './source-read.ts';
import {openWorkbookQuestionSources, readReleasedAssessment} from './workbook-diagnosis.ts';

type AttemptRef = {id: string; rev?: number};

function attemptRef(input: unknown): AttemptRef | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const {id, rev, ...other} = input as Record<string, unknown>;
  if (Object.keys(other).length || !isSourceFactId(id)) return;
  if (rev === undefined) return {id};
  if (typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 1 && rev <= 2_147_483_647) return {id, rev};
  return undefined;
}

function selection(args: Record<string, unknown>) {
  const {paper_id, refs, ...other} = args;
  if (Object.keys(other).length || (paper_id !== undefined && !isSourceFactId(paper_id)) ||
      !Array.isArray(refs) || !refs.length ||
      refs.length > pythonAttemptsLimit) return;
  const attempts = refs.map(attemptRef);
  if (attempts.some(ref => !ref) || new Set(attempts.map(ref => ref?.id)).size !== attempts.length) return;
  return {paperId: paper_id, attempts: attempts as AttemptRef[]};
}

export async function readPythonAttempts(tx: ReadTransaction, args: Record<string, unknown>, access: {
  maySend: WorkspaceSourceRecipient; known: (id: string) => boolean; track: SourceTrack;
}): Promise<PythonAttemptsRead> {
  const scope = selection(args);
  if (!scope) return {ok:false, code:'invalid_args', field:'attempts', message:
    `请传 1–${pythonAttemptsLimit} 个不重复的作答 refs（{id, rev?}）。只统计一份卷时可传 paper_id。`};

  const read = createAuthorizedFactReader(tx, purpose, access.maySend);
  async function open(id: string, type: string) {
    const denied = access.known(id) ? 'access_revoked' : 'not_found';
    try {
      const fact = await read.fact(factId(id), {mode: 'following'});
      if (fact.type !== type) return {code: 'not_found'} as const;
      return {fact} as const;
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return {code: denied} as const;
      throw error;
    }
  }

  if (scope.paperId) {
    const paper = await open(scope.paperId, workbookPaperType);
    if ('code' in paper) return {ok:false, code:paper.code, field:'paper_id', message:'请使用当前可读的试卷。'};
  }

  const rows: PythonAttemptRow[] = [];
  const issues: Extract<PythonAttemptsRead, {ok:true}>['issues'] = [];
  for (const [index, ref] of scope.attempts.entries()) {
    const opened = await open(ref.id, workbookAttemptType);
    if ('code' in opened) {
      issues.push({index, code: opened.code});
      continue;
    }
    let attempt;
    try {
      attempt = workbookAttempt(opened.fact.value);
    } catch {
      issues.push({index, code:'unknown'});
      continue;
    }
    if (scope.paperId && attempt.paperId !== scope.paperId) {
      issues.push({index, code:'not_found'});
      continue;
    }
    if (ref.rev !== undefined && ref.rev !== opened.fact.ref.rev) {
      issues.push({index, code:'basis_stale'});
      continue;
    }
    const collected: Parameters<SourceTrack>[] = [];
    const sources = {maySend: access.maySend, track: (...fact: Parameters<SourceTrack>) => collected.push(fact)};
    if (!await openWorkbookQuestionSources(tx, opened.fact, sources)) {
      issues.push({index, code: access.known(ref.id) ? 'access_revoked' : 'not_found'});
      continue;
    }
    const formal = await readReleasedAssessment(tx, attempt, opened.fact, sources);
    const score = formal.state === 'complete' ? formal.score : null;
    for (const fact of collected) access.track(...fact);
    access.track(opened.fact, 'following');
    rows.push({
      id:ref.id, paper_id:attempt.paperId, submitted_at:attempt.submittedAt,
      results:attempt.feedback.map(({questionId, result}) => ({question_id:questionId, result})),
      ...(attempt.effectiveDurationMs === undefined ? {} : {effective_duration_ms:attempt.effectiveDurationMs}),
      ...(score ? {formal_score:{earned:score.earned, maximum:score.maximum}} : {}),
    });
  }
  if (!rows.length) return {ok:false, code:issues[0]!.code, field:'refs', message:'本次选择没有可用于计算的作答。', issues};
  return {ok:true, rows, issues};
}
