import type { CanonicalEvidenceSliceV1 } from '../../kernel/src/pipeline-contracts.ts';
import type { ReadContext } from '../../kernel/src/declarations/types.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import { pythonAttemptsLimit } from '../../executors/teaching/agent-tools.ts';
import { toolFailure, type LearningError } from '../../executors/teaching/learning-tools.ts';
import type { PythonRead, PythonReadValue } from '../../executors/teaching/python-sdk.ts';
import { activityEvidenceSlice, type ActivityEvidenceObservation } from '../../modules/activity/evidence-slice.ts';
import { posttestIssuanceType, posttestSubmissionType, retentionPaperType } from '../../modules/activity/retention-posttest.ts';
import { workbookAttempt, workbookAttemptType, workbookPaperType } from '../../modules/activity/workbook-values.ts';
import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { purpose } from './identity.ts';
import { readKnowledgeGraph, type EdgeHit } from './knowledge-graph.ts';
import { readPythonAttempts } from './python-attempts.ts';
import { readPythonQuestions } from './python-questions.ts';
import { studioWorkbookEvidence } from './retention-workbook.ts';
import { readActivitySubmissionBirth } from './learning-attempt-read.ts';
import { checkStudioNotionFact } from './notion.ts';
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
    const edgeKinds = ['prereq_of', 'prerequisite', 'successor'] as const;
    const projectEdge = (edge: EdgeHit) => ({
      id:edge.id, rev:edge.rev, from:edge.from.fact.id, from_rev:edge.from.fact.rev,
      to:edge.to.fact.id, to_rev:edge.to.fact.rev, kind:edge.kind, scope:edge.scope,
    });
    const traverse = (direction: 'inbound' | 'outbound') => {
      // Up to eight reads share the 256 KiB Python input with user code and arguments.
      let remainingBytes = 12 * 1024;
      return readKnowledgeGraph(tx, {conceptId:id, hops, direction, edgeKinds, conceptsOnly:true},
        {recipient:'workspace', maySend:access.maySend, track:access.track, exactReadModes:true},
        (source, _fact, hop) => hop > 0 ? {id:source.id, rev:source.rev, title:source.title, hop} : undefined,
        (edge, node) => {
          remainingBytes -= Buffer.byteLength(JSON.stringify([projectEdge(edge), node]));
          return remainingBytes >= 0;
        });
    };
    const prerequisites = await traverse('inbound');
    if (!prerequisites) return access.known(id)
      ? toolFailure('access_revoked','先前打开的知识点已不可用。',{tool:'read_context',args:{intent:'tutoring'}})
      : absent('kc_id', '请提供可读取的知识点 ID。');
    const successors = await traverse('outbound');
    if (!successors) return absent('kc_id', '请提供可读取的知识点 ID。');
    const edges = new Map([...prerequisites.edges, ...successors.edges].map(edge => [edge.id, projectEdge(edge)]));
    return {value:{kc_id:id, rev:prerequisites.conceptRef.fact.rev, depth:hops, scope:'authorized', edge_kinds:[...edgeKinds],
      prerequisites:prerequisites.results, successors:successors.results, edges:[...edges.values()],
      truncated:prerequisites.truncated || successors.truncated}};
  }
  if (request.method === 'forgetting_risks') {
    return {value:await readForgettingRisks(tx,access.maySend,{asOf,watermark,
      horizonHours:typeof request.args.horizon_hours === 'number' ? request.args.horizon_hours : 48,
      track:access.track,trackRetention:access.trackRetention})};
  }
  if (request.method !== 'attempts' && request.method !== 'evidence_slice')
    return absent(request.method, '该 SDK 查询尚无已授权的生产读取。');
  if (request.args.subject !== undefined) return absent('subject','作答没有可核对的学科归属。');

  const reader = createAuthorizedFactReader(tx,purpose,access.maySend);
  const tracked = {fact:async (...[id,options]: Parameters<ReadContext['fact']>) => {
    const fact = await reader.fact(id,options);
    await checkStudioNotionFact(tx,fact,purpose,access.maySend);
    access.track(fact,options.mode);
    return fact;
  }};
  const paperIds = Array.isArray(request.args.paper_ids) ? request.args.paper_ids : null;
  for (const id of paperIds ?? []) {
    if (!isSourceFactId(id)) return absent('paper_ids','请提供当前获准的试卷引用。');
    try {
      const paper = await tracked.fact(factId(id),{mode:'following'});
      if (paper.type !== workbookPaperType && paper.type !== retentionPaperType)
        return absent('paper_ids','请提供当前获准的试卷引用。');
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
      return access.known(id) ? toolFailure('access_revoked','先前打开的试卷已不可用。',{tool:'read_context',args:{intent:'tutoring'}})
        : absent('paper_ids','请提供当前获准的试卷引用。');
    }
  }
  const {rows: refs} = await tx.query<{id:string;rev:number}>(`
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
    ORDER BY f.created_tick DESC,f.id LIMIT $11`,[tx.learner,[workbookAttemptType,posttestSubmissionType],purpose,watermark,
      typeof request.args.since === 'string' ? new Date(request.args.since).toISOString() : null,asOf,paperIds,workbookAttemptType,posttestSubmissionType,posttestIssuanceType,pythonAttemptsLimit + 1]);
  if (refs.length > pythonAttemptsLimit)
    return toolFailure('limit_exceeded',`本次选择超过 ${pythonAttemptsLimit} 份作答，请缩小时间范围。`,{tool:'read_context',args:{intent:'tutoring'}});
  const declared = refs.length ? await readPythonAttempts(tx,{refs},access) : undefined;
  const rows = declared?.ok ? declared.rows : [];
  if (declared?.issues?.some(item => item.code === 'access_revoked'))
    return toolFailure('access_revoked','先前打开的作答已不可使用。',{tool:'read_context',args:{intent:'tutoring'}});
  if (request.method === 'attempts') {
    if (declared && (!declared.ok || declared.issues.length)) return absent('attempts','选择中有无法确认的作答，未向 Python 提供部分统计。');
    return {value:rows};
  }
  if (declared && (!declared.ok || declared.issues.length)) return absent('evidence_slice','部分作答来源无法确认，不能当作空证据切片。');
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
      const {observation,process,recordedAt,duration} = await evidence.readWorkbookEvidence(tx,tracked,opened,fact.ref.id);
      if (BigInt(recordedAt) > BigInt(watermark) || observation.submittedAt > asOf) {
        omissions.push({ref,reason:'outside-evidence-window'});
        continue;
      }
      // Each observation is anchored to the identical frozen item it was graded on.
      // A prediction's relative transfer condition is not this item's identity.
      const concepts = await evidence.readItemDimensions(tx,tracked,item.sourceQuestionRef,birth.tick);
      observations.push({submission:ref,occurredAt:observation.submittedAt,concepts,novelty:'same',
        helpLevel:process.helpLevel,result:observation.result,...(duration === undefined ? {} : {duration})});
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof RequestError)) throw error;
      omissions.push({ref,reason:'unavailable-process-witness'});
    }
  }
  const slice = activityEvidenceSlice(watermark,asOf,undefined,observations);
  return {value:{...slice,omissions:[...(slice.omissions ?? []),...omissions]}};
}
