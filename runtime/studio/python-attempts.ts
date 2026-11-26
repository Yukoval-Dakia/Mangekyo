import { pythonAttemptsLimit, type PythonAttemptRow, type PythonAttemptsRead } from '../../executors/teaching/agent-tools.ts';
import { parsePythonAttemptSelection } from '../../executors/teaching/python-attempt-selection.ts';
import { factId, isFactUnavailable, readAvailable, type EvidenceEventV1, type ReadTransaction, type Tick } from '../../kernel/src/index.ts';
import { workbookExamPacingEvent, workbookExamPacingItems } from '../../modules/activity/evidence-slice.ts';
import { readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { posttestSubmissionType, retentionPaperType } from '../../modules/activity/retention-posttest.ts';
import { workbookAttemptView } from '../../modules/activity/workbook-assessment-values.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { buildPythonAttemptsResult, checkPythonAttemptMeta, projectPythonAttemptRow } from '../../modules/learner/retention-slice.ts';
import { purpose, purposeReader } from './identity.ts';
import { openControlledSubmission } from './retention-workbook.ts';
import { RequestError } from './sessions.ts';
import type { SourceTrack, WorkspaceSourceRecipient } from './source-read.ts';
import { openWorkbookQuestionSources, readReleasedAssessment } from './workbook-diagnosis.ts';

export async function readPythonAttempts(tx: ReadTransaction, args: Record<string, unknown>, access: {
  maySend: WorkspaceSourceRecipient; known: (id: string) => boolean; track: SourceTrack;
  recordExam?: (event: EvidenceEventV1) => void; includeExamItems?: boolean; cutoff?: Tick;
}): Promise<PythonAttemptsRead> {
  const scope = parsePythonAttemptSelection(args);
  if (!scope) return { ok: false, code: 'invalid_args', field: 'attempts', message: `请传 1–${pythonAttemptsLimit} 个不重复的作答 refs（{id, rev?}）。只统计一份卷时可传 paper_id。` };
  const read = purposeReader(tx, access.maySend), deniedCode = (id: string) => access.known(id) ? 'access_revoked' as const : 'not_found' as const;
  const open = async (id: string, types: readonly string[]) => {
    const fact = await readAvailable(() => read.fact(factId(id), { mode: 'following' }));
    return !fact ? { code: deniedCode(id) } : !types.includes(fact.type) ? { code: 'not_found' as const } : { fact };
  };
  if (scope.paperId) {
    const paper = await open(scope.paperId, [workbookPaperType, retentionPaperType]);
    if ('code' in paper) return { ok: false, code: paper.code, field: 'paper_id', message: '请使用当前可读的试卷。' };
  }
  const rows: PythonAttemptRow[] = [], issues: Extract<PythonAttemptsRead, { ok: true }>['issues'] = [];
  for (const [index, ref] of scope.attempts.entries()) {
    const opened = await open(ref.id, [workbookAttemptType, posttestSubmissionType]);
    if ('code' in opened) { issues.push({ index, code: opened.code }); continue; }
    let attempt;
    try { attempt = workbookAttempt(opened.fact.value); } catch { issues.push({ index, code: 'unknown' }); continue; }
    const controlled = opened.fact.type === posttestSubmissionType, metaError = checkPythonAttemptMeta(controlled, scope.paperId, attempt.paperId, ref.rev, opened.fact.ref.rev);
    if (metaError) { issues.push({ index, code: metaError }); continue; }
    const collected: Parameters<SourceTrack>[] = [], sources = { maySend: access.maySend, track: (...fact: Parameters<SourceTrack>) => collected.push(fact) };
    let paperId = attempt.paperId, formal: Awaited<ReturnType<typeof readReleasedAssessment>>;
    if (controlled) {
      const birth = await readActivitySubmissionBirth(tx, opened.fact.ref, posttestSubmissionType);
      if (!birth || !birth.unchanged || birth.submittedAt !== attempt.submittedAt) { issues.push({ index, code: 'unknown' }); continue; }
      try {
        const { source } = await openControlledSubmission(tx, { async fact(id, opts) { const f = await read.fact(id, opts); sources.track(f, opts.mode); return f; } }, attempt, birth.tick);
        paperId = source.ref.id;
        if (scope.paperId && paperId !== scope.paperId) { issues.push({ index, code: 'not_found' }); continue; }
      } catch (error) { if (!(isFactUnavailable(error) || error instanceof RequestError)) throw error; issues.push({ index, code: deniedCode(ref.id) }); continue; }
    } else {
      const frozen = await openWorkbookQuestionSources(tx, opened.fact, sources);
      if (!frozen) { issues.push({ index, code: deniedCode(ref.id) }); continue; }
      if (attempt.paper.assessmentRelease) formal = await readReleasedAssessment(tx, attempt, opened.fact, sources, access.cutoff);
      access.recordExam?.(workbookExamPacingEvent(opened.fact.ref, attempt, frozen.paper, formal));
      if (access.includeExamItems && access.recordExam) for (const item of workbookExamPacingItems(opened.fact.ref, attempt, frozen.paper, formal)) access.recordExam(item);
    }
    for (const fact of collected) access.track(...fact);
    access.track(opened.fact, 'following');
    rows.push(projectPythonAttemptRow({
      id: ref.id, paperId, submittedAt: attempt.submittedAt, controlled,
      feedback: workbookAttemptView(ref.id, attempt, [], formal?.result).feedback,
      effectiveDurationMs: attempt.effectiveDurationMs, formalScore: formal?.state === 'complete' ? formal.score : null,
    }));
  }
  return buildPythonAttemptsResult(rows, issues);
}
