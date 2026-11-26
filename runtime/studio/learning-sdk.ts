import type { CanonicalEvidenceSliceV1, EvidenceEventV1 } from '../../kernel/src/pipeline-contracts.ts';
import { factId, isFactUnavailable, readAvailable, type ReadTransaction, type Tick } from '../../kernel/src/index.ts';
import { pythonAttemptsLimit } from '../../executors/teaching/agent-tools.ts';
import { toolFailure, type LearningError } from '../../executors/teaching/learning-tools.ts';
import { pythonPrerequisiteKinds, pythonPrerequisites, type PythonRead, type PythonReadValue } from '../../executors/teaching/python-sdk.ts';
import { activityEvidenceSlice, type ActivityEvidenceObservation } from '../../modules/activity/evidence-slice.ts';
import { posttestIssuanceType, posttestSubmissionType, retentionPaperType } from '../../modules/activity/retention-posttest.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { purpose } from './identity.ts';
import { readKnowledgeGraph } from './knowledge-graph.ts';
import { readPythonAttempts } from './python-attempts.ts';
import { readPythonQuestions } from './python-questions.ts';
import { studioWorkbookEvidence } from './retention-workbook.ts';
import { readActivitySubmissionBirth } from '../../modules/activity/learning-attempt-read.ts';
import { createNotionReader } from './notion.ts';
import type { SourceTrack, WorkspaceSourceRecipient } from './source-read.ts';
import { readForgettingRisks, type RetentionBasis } from './learner-radar.ts';
import { RequestError } from './sessions.ts';
type Value = {value:PythonReadValue};
const absent = (method: string, message: string) =>
  toolFailure('not_found',message,{tool:'read_context',args:{intent:'tutoring'}},method);
export async function readLearningSdk(tx: ReadTransaction, request: PythonRead, access: {
  maySend: WorkspaceSourceRecipient; track: SourceTrack; trackRetention(basis: RetentionBasis): void; known(id:string): boolean; turn: string; trackNegative(id: string): void;
}, asOf: string, watermark: Tick): Promise<Value | LearningError> {
  if (request.method === 'questions') return readPythonQuestions(tx,request.args,watermark,access);
  if (request.method === 'kg_prereqs') {
    const id = request.args.kc_id;
    if (!isSourceFactId(id)) return absent('kc_id', '请提供可读取的知识点 ID。');
    const hops = typeof request.args.depth === 'number' ? request.args.depth : 2;
    const graph = await pythonPrerequisites(id, hops, (direction, select, fits) =>
      readKnowledgeGraph(tx, {conceptId:id, hops, direction, edgeKinds:pythonPrerequisiteKinds, conceptsOnly:true},
        {recipient:'workspace', maySend:access.maySend, track:access.track, exactReadModes:true}, select, fits));
    if (graph.state === 'ready') return {value:graph.value};
    return graph.state === 'missing-root' && access.known(id)
      ? toolFailure('access_revoked','先前打开的知识点已不可用。',{tool:'read_context',args:{intent:'tutoring'}})
      : absent('kc_id', '请提供可读取的知识点 ID。');
  }
  if (request.method === 'forgetting_risks') {
    return {value:await readForgettingRisks(tx,access.maySend,{asOf,watermark,
      horizonHours:typeof request.args.horizon_hours === 'number' ? request.args.horizon_hours : 48,
      track:access.track,trackRetention:access.trackRetention})};
  }
  if (request.args.subject !== undefined) return absent('subject','作答没有可核对的学科归属。');
  const tracked = createNotionReader(tx, { purpose, recipient: access.maySend, track: access.track });
  const paperIds = Array.isArray(request.args.paper_ids) ? request.args.paper_ids : null;
  for (const id of paperIds ?? []) {
    if (!isSourceFactId(id)) return absent('paper_ids','请提供当前获准的试卷引用。');
    const paper = await readAvailable(() => tracked.fact(factId(id),{mode:'following'}));
    if (!paper) return access.known(id) ? toolFailure('access_revoked','先前打开的试卷已不可用。',{tool:'read_context',args:{intent:'tutoring'}})
      : absent('paper_ids','请提供当前获准的试卷引用。');
    if (paper.type !== workbookPaperType && paper.type !== retentionPaperType)
      return absent('paper_ids','请提供当前获准的试卷引用。');
  }
  const includeExamItems = request.method === 'evidence_slice' && request.args.exam_pacing_items === true;
  const wholePaper = includeExamItems || (request.method === 'evidence_slice' && request.args.exam_pacing === true);
  const {rows: refs} = await tx.query<{id: string; rev: number}>(`
    SELECT f.id,f.current_rev AS rev FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=ANY($2) AND f.retracted_rev IS NULL
      AND f.purpose && ARRAY[$3,'all'] AND NOT EXISTS
        (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id) AND f.changed_tick<=$4::bigint
      AND ($5::text IS NULL OR r.data->>'submittedAt'>=$5) AND r.data->>'submittedAt'<=$6
      AND ($7::text[] IS NULL OR (f.type=$8 AND r.data->>'paperId'=ANY($7)) OR
        (f.type=$9 AND EXISTS (SELECT 1 FROM facts i JOIN fact_revs ir
          ON (ir.learner_id,ir.fact_id,ir.rev)=(i.learner_id,i.id,1)
          WHERE i.learner_id=f.learner_id AND i.id=r.data->>'paperId' AND i.type=$10
            AND ir.data->'paper'->>'id'=ANY($7))))
    ORDER BY f.created_tick DESC,f.id LIMIT $11`, [tx.learner, wholePaper ? [workbookAttemptType] : [workbookAttemptType,posttestSubmissionType], purpose, watermark,
      typeof request.args.since === 'string' ? new Date(request.args.since).toISOString() : null, asOf,
      paperIds, workbookAttemptType, posttestSubmissionType, posttestIssuanceType, pythonAttemptsLimit+1]);
  if (refs.length > pythonAttemptsLimit)
    return toolFailure('limit_exceeded',`本次选择超过 ${pythonAttemptsLimit} 份作答，请缩小时间范围。`,{tool:'read_context',args:{intent:'tutoring'}});
  const events: EvidenceEventV1[] = [];
  const declared = refs.length ? await readPythonAttempts(tx,{refs},
    wholePaper ? {...access,includeExamItems,cutoff:watermark,recordExam:event=>events.push(event)} : access) : undefined;
  const rows = declared?.ok ? declared.rows : [];
  if (declared?.issues?.some(item => item.code === 'access_revoked'))
    return toolFailure('access_revoked','先前打开的作答已不可使用。',{tool:'read_context',args:{intent:'tutoring'}});
  if (request.method === 'attempts') {
    if (declared && (!declared.ok || declared.issues.length)) return absent('attempts','选择中有无法确认的作答，未向 Python 提供部分统计。');
    return {value:rows};
  }
  if (declared && (!declared.ok || declared.issues.length)) return absent('evidence_slice','部分作答来源无法确认，不能当作空证据切片。');
  if (wholePaper) return {value:{...activityEvidenceSlice(watermark,asOf,undefined,[]),events}};
  const observations: ActivityEvidenceObservation[] = [];
  const omissions: NonNullable<CanonicalEvidenceSliceV1['omissions']>[number][] = [];
  const evidence = studioWorkbookEvidence(purpose,access.maySend);
  for (const row of rows) {
    const fact = await tracked.fact(factId(row.id),{mode:'following'});
    const ref = {id:fact.ref.id,rev:fact.ref.rev};
    const attempt = workbookAttempt(fact.value);
    const item = attempt.paper.questions.length === 1 ? attempt.paper.questions[0] : undefined;
    try {
      if (!item) {
        omissions.push({ref,reason:'unresolved-item-identity'});
        continue;
      }
      const birth = await readActivitySubmissionBirth(tx,fact.ref,fact.type === posttestSubmissionType ? posttestSubmissionType : workbookAttemptType);
      if (!birth) {
        omissions.push({ref,reason:'unwitnessed-submission'});
        continue;
      }
      const controlled = fact.type === posttestSubmissionType
        ? await evidence.openControlledSubmission(tx,tracked,attempt,birth.tick) : undefined;
      const opened = await evidence.openRetentionTarget(tx,tracked,controlled?.source.ref.id ?? factId(attempt.paperId),item.id);
      const {observation,process,recordedAt,duration} = await evidence.readWorkbookEvidence(tx,tracked,opened,fact.ref.id,undefined,watermark);
      if (BigInt(recordedAt) > BigInt(watermark) || observation.submittedAt > asOf) {
        omissions.push({ref,reason:'outside-evidence-window'});
        continue;
      }
      // Each observation is anchored to the identical frozen item it was graded on.
      // A prediction's relative transfer condition is not this item's identity.
      const concepts = await evidence.readItemDimensions(tx,tracked,item.sourceQuestionRef,birth.tick);
      observations.push({submission:ref,occurredAt:observation.submittedAt,concepts,novelty:'same',
        helpLevel:process.helpLevel,result:observation.result,...(observation.scoreNorm === undefined ? {} : {score:observation.scoreNorm}),...(observation.errorStage === undefined ? {} : {errorStage:observation.errorStage}),...(duration === undefined ? {} : {duration})});
    } catch (error) {
    if (!(isFactUnavailable(error) || error instanceof RequestError)) throw error;
      omissions.push({ref,reason:'unavailable-process-witness'});
    }
  }
  const slice = activityEvidenceSlice(watermark,asOf,undefined,observations);
  return {value:{...slice,omissions:[...(slice.omissions ?? []),...omissions]}};
}
