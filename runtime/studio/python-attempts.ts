import {pythonAttemptsLimit, type PythonAttemptRow, type PythonAttemptsRead} from '../../executors/teaching/agent-tools.ts';
import {createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import {posttestSubmissionType, retentionPaperType} from '../../modules/activity/retention-posttest.ts';
import {parsePythonAttemptSelection} from '../../executors/teaching/python-attempt-selection.ts';
import {workbookExamPacingEvent} from '../../modules/activity/evidence-slice.ts';
import {workbookAttemptView} from '../../modules/activity/workbook-assessment-values.ts';
import {workbookAttempt, workbookAttemptType, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {purpose} from './identity.ts';
import {readActivitySubmissionBirth} from './learning-attempt-read.ts';
import {openControlledSubmission} from './retention-workbook.ts';
import {RequestError} from './sessions.ts';
import type {SourceTrack, WorkspaceSourceRecipient} from './source-read.ts';
import {openWorkbookQuestionSources, readReleasedAssessment} from './workbook-diagnosis.ts';

export async function readPythonAttempts(tx: ReadTransaction, args: Record<string, unknown>, access: {
  maySend: WorkspaceSourceRecipient; known: (id: string) => boolean; track: SourceTrack;
  recordExam?: (event: ReturnType<typeof workbookExamPacingEvent>) => void;
}): Promise<PythonAttemptsRead> {
  const scope = parsePythonAttemptSelection(args);
  if (!scope) return {ok:false, code:'invalid_args', field:'attempts', message:
    `请传 1–${pythonAttemptsLimit} 个不重复的作答 refs（{id, rev?}）。只统计一份卷时可传 paper_id。`};

  const read = createAuthorizedFactReader(tx, purpose, access.maySend);
  async function open(id: string, types: readonly string[]) {
    const denied = access.known(id) ? 'access_revoked' : 'not_found';
    try {
      const fact = await read.fact(factId(id), {mode: 'following'});
      if (!types.includes(fact.type)) return {code: 'not_found'} as const;
      return {fact} as const;
    } catch (error) {
      if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return {code: denied} as const;
      throw error;
    }
  }

  if (scope.paperId) {
    const paper = await open(scope.paperId, [workbookPaperType, retentionPaperType]);
    if ('code' in paper) return {ok:false, code:paper.code, field:'paper_id', message:'请使用当前可读的试卷。'};
  }

  const rows: PythonAttemptRow[] = [];
  const issues: Extract<PythonAttemptsRead, {ok:true}>['issues'] = [];
  for (const [index, ref] of scope.attempts.entries()) {
    const opened = await open(ref.id, [workbookAttemptType, posttestSubmissionType]);
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
    const controlled = opened.fact.type === posttestSubmissionType;
    if (!controlled && scope.paperId && attempt.paperId !== scope.paperId) {
      issues.push({index, code:'not_found'});
      continue;
    }
    if (ref.rev !== undefined && ref.rev !== opened.fact.ref.rev) {
      issues.push({index, code:'basis_stale'});
      continue;
    }
    const collected: Parameters<SourceTrack>[] = [];
    const sources = {maySend: access.maySend, track: (...fact: Parameters<SourceTrack>) => collected.push(fact)};
    let paperId = attempt.paperId;
    let formal: Awaited<ReturnType<typeof readReleasedAssessment>>;
    if (controlled) {
      const birth = await readActivitySubmissionBirth(tx, opened.fact.ref, posttestSubmissionType);
      if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt) {
        issues.push({index, code:'unknown'});
        continue;
      }
      try {
        const { source } = await openControlledSubmission(tx, { async fact(id, options) {
          const fact = await read.fact(id, options);
          sources.track(fact, options.mode);
          return fact;
        } }, attempt, birth.tick);
        paperId = source.ref.id;
        if (scope.paperId && paperId !== scope.paperId) {
          issues.push({index, code:'not_found'});
          continue;
        }
      } catch (error) {
        if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof RequestError)) throw error;
        issues.push({index, code: access.known(ref.id) ? 'access_revoked' : 'not_found'});
        continue;
      }
    } else {
      const frozen = await openWorkbookQuestionSources(tx, opened.fact, sources);
      if (!frozen) {
        issues.push({index, code: access.known(ref.id) ? 'access_revoked' : 'not_found'});
        continue;
      }
      formal = await readReleasedAssessment(tx, attempt, opened.fact, sources);
      access.recordExam?.(workbookExamPacingEvent(opened.fact.ref, attempt, frozen.paper, formal));
    }
    for (const fact of collected) access.track(...fact);
    access.track(opened.fact, 'following');
    const score = formal?.state === 'complete' ? formal.score : null;
    const {feedback} = workbookAttemptView(ref.id, attempt, [], formal?.result);
    rows.push({
      id:ref.id, paper_id:paperId, submitted_at:attempt.submittedAt,
      ...(controlled ? {activity_kind:'controlled_posttest'} : {}),
      results:feedback.map(({questionId, result}) => ({question_id:questionId, result})),
      ...(attempt.effectiveDurationMs === undefined ? {} : {effective_duration_ms:attempt.effectiveDurationMs}),
      ...(score ? {formal_score:score} : {}),
    });
  }
  if (!rows.length) return {ok:false, code:issues[0]!.code, field:'refs', message:'本次选择没有可用于计算的作答。', issues};
  return {ok:true, rows, issues};
}
