import { learningToolError } from '../../executors/teaching/tool-error.ts';
import { createBusScope, isFactUnavailable, parseManifest, type FactSnapshot, type ManifestInput, type ReadTransaction, type Revision } from '../../kernel/src/index.ts';
import { readTeachingAttemptAssessments } from '../../modules/activity/learning-attempt-read.ts';
import { readLearningOverview } from '../../modules/activity/learning-overview.ts';
import { isSourceFactId, parseLearningReference, sourceRefV1 } from '../../modules/activity/source-values.ts';
import { workbookAttemptType, workbookFormalAssessmentType, workbookPaperType, workbookRubricAssessmentType } from '../../modules/activity/workbook-values.ts';
import { workspaceReadRecord } from '../../modules/activity/workspace-source-projection.ts';
import { knowledgeEdgeEvidenceType, knowledgeEdgeKinds, knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { buildLearnerModelPayload, extractAssessmentManifestFacts, findUnsupportedWorkspaceQueryFields, validateWorkspaceGraphParams } from '../../modules/content/workspace-slice.ts';
import { purpose } from './identity.ts';
import { openKnowledgeEdge, openKnowledgeEdgeEvidence, readKnowledgeGraph } from './knowledge-graph.ts';
import { resolveSource, type SourceAccess, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';
import { syntheticStudyRecords } from './workspace-access.ts';
import { parseWorkspaceSearch, queryStrings, searchWorkspaceRecords, unappliedWorkspaceFilters, WorkspaceSearchError, workspaceResult, type WorkspaceCandidateChannel } from './workspace-search.ts';

type Arguments = Record<string, unknown>;
const workspaceSourceUnavailable = JSON.stringify(learningToolError('not_found', 'id', '未找到当前可读的学习记录。', { tool: 'search_workspace', args: {}, why: '查询当前已授权的学习记录。' }));
export type AssessmentSlot = Extract<ManifestInput, { kind: 'slot' }>;
export type WorkspaceAssessmentBasis = { slot: AssessmentSlot; facts: Extract<ManifestInput, { kind: 'fact' }>[] };
export function isWorkspaceAssessmentSlot(type: string) { return type === workbookRubricAssessmentType || type === workbookFormalAssessmentType; }

export async function workspaceAssessmentBasis(tx: ReadTransaction, slot: AssessmentSlot, maySend: WorkspaceSourceRecipient): Promise<WorkspaceAssessmentBasis | undefined> {
  if (!isWorkspaceAssessmentSlot(slot.slotType) || slot.mode !== 'following') return;
  const { rows: [current] } = await tx.query<{ manifest: unknown; attempt_id: string; paper_id: string }>(
    `SELECT d.manifest,COALESCE(d.scope_keys->>'attemptId',s.scope_keys->'submissionRef'->>'id') AS attempt_id,
       COALESCE(d.scope_keys->>'paperId',s.scope_keys->'releaseRef'->>'id') AS paper_id
     FROM slot_state s JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id)=(s.learner_id,s.slot_type,s.slot_key,s.current_id)
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3 AND s.current_id=$4 AND d.lifecycle='effective'
       AND NOT d.is_shadow AND d.invalidated_tick IS NULL AND d.selection_ended_tick IS NULL AND d.effective_tick >= d.gather_tick`,
    [tx.learner, slot.slotType, slot.slotKey, slot.derivationId]);
  if (!current) return;
  let manifest;
  try { manifest = parseManifest(current.manifest); } catch { return; }
  if (manifest.learner !== tx.learner) return;
  const facts = extractAssessmentManifestFacts(manifest.inputs, current.attempt_id, syntheticStudyRecords);
  if (!facts || !facts.some(f => f.id === current.attempt_id) || !facts.some(f => f.id === current.paper_id)) return;
  const bus = createBusScope(tx, { actor: 'companion', purpose, maySend, defaultPreset: 'assessmentBasis', presets: new Map([['assessmentBasis', (fact: FactSnapshot) => fact.type]]) });
  try {
    for (let offset = 0; offset < facts.length; offset += 8) {
      const { witnesses } = await bus.resolve(facts.slice(offset, offset + 8).map(ref => ({ ...ref, rev: ref.rev as Revision })), 'assessmentBasis');
      if (witnesses.some(w => (w.id === current.attempt_id && w.type !== workbookAttemptType) || (w.id === current.paper_id && w.type !== workbookPaperType))) return;
    }
  } catch (error) { if (isFactUnavailable(error)) return; throw error; }
  return { slot, facts };
}

export async function readWorkspaceAttemptAssessments(tx: ReadTransaction, attempt: FactSnapshot, maySend: WorkspaceSourceRecipient,
  track: (basis: WorkspaceAssessmentBasis) => void) {
  const assessments = [];
  for (const { ref, attempt: _attempt, ...assessment } of await readTeachingAttemptAssessments(tx, attempt,
    { purpose, recipientEligible: maySend(attempt) })) {
    const basis = await workspaceAssessmentBasis(tx, ref, maySend);
    if (basis) { track(basis); assessments.push(assessment); }
  }
  return assessments;
}

export async function workspaceQuery(tx: ReadTransaction, args: Arguments, access: SourceAccess, semantic?: WorkspaceCandidateChannel) {
  try {
    const unappliedFilters = findUnsupportedWorkspaceQueryFields(args);
    if (unappliedFilters.length) return { results: [], truncated: false, unappliedFilters };
    const criteria = parseWorkspaceSearch(args), { conceptId, hops = 2, direction = 'both' } = args;
    if (conceptId === undefined) {
      if (args.hops !== undefined || args.direction !== undefined || args.edgeKinds !== undefined) throw new WorkspaceSearchError('多跳查询需要 conceptId。');
      return await searchWorkspaceRecords(tx, criteria, access, semantic);
    }
    const invalid = validateWorkspaceGraphParams(isSourceFactId(conceptId), hops, direction, Boolean(criteria.query || criteria.related || criteria.cursor));
    if (invalid) throw new WorkspaceSearchError(invalid);
    const requested = queryStrings(args.edgeKinds, 'edgeKinds', knowledgeEdgeKinds);
    const graph = await readKnowledgeGraph(tx, { conceptId: conceptId as string, hops: hops as 0 | 1 | 2,
      direction: direction as 'both' | 'inbound' | 'outbound', edgeKinds: knowledgeEdgeKinds.filter(kind => requested.includes(kind)) },
      access, (source, fact, hop) => { const match = workspaceResult(source, fact, criteria); return match ? { ...match, hop } : undefined; });
    if (graph) return { ...graph, unappliedFilters: unappliedWorkspaceFilters(criteria) };
  } catch (error) { if (error instanceof WorkspaceSearchError) return { error: error.message, code: error.code, field: error.field }; throw error; }
  return undefined;
}

export async function workspaceSearch(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient): Promise<string> {
  const result = await workspaceQuery(tx, args, { recipient: 'workspace', track, maySend });
  if (result && 'error' in result && result.code) {
    const { cursor: _cursor, ...query } = args;
    return JSON.stringify(learningToolError(result.code, result.field, result.error,
      result.code === 'basis_stale' ? { tool: 'search_workspace', args: query, why: '去掉旧分页位置，重新查询。' } : undefined));
  }
  return result ? JSON.stringify(result) : workspaceSourceUnavailable;
}

export async function workspaceRead(tx: ReadTransaction, args: Arguments, track: SourceTrack, maySend: WorkspaceSourceRecipient,
  trackAssessment?: (basis: WorkspaceAssessmentBasis) => void): Promise<string> {
  if (args.id === 'learner') {
    const [observations, attempts] = await Promise.all([
      workspaceSearch(tx, { kind: 'observation' }, track, maySend).then(JSON.parse),
      workspaceSearch(tx, { kind: 'attempt' }, track, maySend).then(JSON.parse),
    ]);
    const overview = await readLearningOverview(tx, { callerPurpose: purpose, maySend: (_, snapshot) => maySend(snapshot), track });
    return JSON.stringify(buildLearnerModelPayload(observations.results, attempts.results,
      overview.goal.state === 'set' ? overview.goal.text : null, 'items' in overview.tasks ? overview.tasks.items : []));
  }
  const reference = typeof args.id === 'string' ? parseLearningReference(args.id) : sourceRefV1(args.id);
  if (!reference) return JSON.stringify(learningToolError('invalid_args', 'id', '使用记录 id 或 sourceRef。学情概览使用 learner。'));
  const offset = args.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    return JSON.stringify(learningToolError('invalid_args', 'offset', 'offset 须为非负整数。'));
  if (typeof reference !== 'string' && reference.fact.type === knowledgeEdgeType) {
    const edge = await openKnowledgeEdge(tx, reference, { recipient: 'workspace', maySend });
    if (!edge) return workspaceSourceUnavailable;
    for (const witness of edge.opened) track(...witness);
    return JSON.stringify(edge.value);
  }
  let attempt: FactSnapshot | undefined;
  const record = await resolveSource(tx, reference, { recipient: 'workspace', maySend,
    track(fact, mode) { track(fact, mode); if (fact.type === workbookAttemptType) attempt = fact; } });
  if (!record) {
    const proof = (typeof reference === 'string' || reference.fact.type === knowledgeEdgeEvidenceType)
      && await openKnowledgeEdgeEvidence(tx, reference, { recipient: 'workspace', maySend, track });
    return proof ? JSON.stringify(proof) : workspaceSourceUnavailable;
  }
  const assessments = trackAssessment && attempt?.ref.id === record.sourceRef.fact.id && record.sourceRef.anchor.kind === 'whole'
    ? await readWorkspaceAttemptAssessments(tx, attempt, maySend, trackAssessment) : [];
  return JSON.stringify(workspaceReadRecord(record, offset, assessments));
}
