import { createAuthorizedFactReader, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import type { WorkbookSourceQuestionRef } from '../../modules/activity/workbook-values.ts';
import { workbookAnswerDisplayCandidates } from '../../modules/activity/evidence-read.ts';
import { isSourceFactId } from '../../modules/activity/source-values.ts';
import { workbookPaper } from '../../modules/activity/workbook-values.ts';
import { workspaceEntry, workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { toolFailure } from '../../executors/teaching/learning-tools.ts';
import type { PythonRead } from '../../executors/teaching/python-sdk.ts';
import { purpose } from './identity.ts';
import { openKnowledgeEdge, type WorkspaceSource } from './knowledge-graph.ts';
import { checkStudioNotionFact } from './notion.ts';
import { resolveSource, type SourceAccess, type SourceTrack, type WorkspaceSourceRecipient } from './source-read.ts';

const scanLimit = 96;
const outputBytes = 12 * 1024;
type Witness = Parameters<SourceTrack>;
type Question = { id: string; rev: number; title: string; prompt: string; kc_ids: string[]; answer_exposed: true | null };

async function confirmedAnswerDisplay(tx: ReadTransaction, source: WorkbookSourceQuestionRef, through: Tick,
  maySend: WorkspaceSourceRecipient, track: SourceTrack): Promise<true | null> {
  const ids = await workbookAnswerDisplayCandidates(tx, source, through, purpose, 8);
  const read = createAuthorizedFactReader(tx, purpose, maySend);
  for (const row of ids) {
    try {
      const evidence = await Promise.all([row.display_id, row.paper_id, row.attempt_id]
        .map(id => read.fact(id, { mode: 'following' })));
      const material = workbookPaper(evidence[1]!.value).materialId;
      const sources: Witness[] = [];
      if (material && !await resolveSource(tx, material, {
        recipient: 'workspace', maySend, exactReadModes: true, track: (...w) => sources.push(w),
      })) continue;
      for (const fact of evidence) {
        await checkStudioNotionFact(tx, fact, purpose, maySend);
        sources.push([fact, 'following']);
      }
      for (const witness of sources) track(...witness);
      return true;
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    }
  }
  return null;
}

export async function readPythonQuestions(tx: ReadTransaction, args: PythonRead['args'], through: Tick, access: {
  maySend: WorkspaceSourceRecipient; track: SourceTrack; known(id: string): boolean;
}) {
  const sourceAccess = { recipient: 'workspace', maySend: access.maySend, exactReadModes: true } as const;
  const concepts: WorkspaceSource['sourceRef']['fact'][] = [];
  const conceptWitnesses: Witness[] = [];
  for (const id of Array.isArray(args.kc_ids) ? args.kc_ids : []) {
    const source = isSourceFactId(id) ? await resolveSource(tx, id, {
      ...sourceAccess, track: (...w) => conceptWitnesses.push(w),
    }) : undefined;
    if (source?.kind !== 'concept' || source.sourceRef.fact.type !== workspaceEntryType) {
      return typeof id === 'string' && access.known(id)
        ? toolFailure('access_revoked', '先前打开的知识点已不可用。', { tool: 'read_context', args: { intent: 'tutoring' } })
        : toolFailure('not_found', '请提供当前可读取的知识点 ID。', { tool: 'read_context', args: { intent: 'tutoring' } }, 'kc_ids');
    }
    concepts.push(source.sourceRef.fact);
  }
  const { rows } = await tx.query<{ id: string }>(`
    SELECT f.id FROM facts f JOIN fact_revs r
      ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
    WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.kind='value'
      AND f.purpose && ARRAY[$3,'all'] AND r.purpose && ARRAY[$3,'all'] AND r.tick<=$4::bigint
      AND r.data->>'kind'='question'
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)
      AND ($7::boolean OR EXISTS (
        SELECT 1 FROM facts e JOIN fact_revs er
          ON (er.learner_id,er.fact_id,er.rev)=(e.learner_id,e.id,e.current_rev)
        JOIN jsonb_to_recordset($6::jsonb) AS kc(id text,rev int)
          ON (er.data#>>'{to,sourceUse,id}',er.data#>>'{to,sourceUse,rev}')=(kc.id,kc.rev::text)
        WHERE e.learner_id=f.learner_id AND e.type=$5 AND e.retracted_rev IS NULL AND er.kind='value'
          AND e.purpose && ARRAY[$3,'all'] AND er.purpose && ARRAY[$3,'all'] AND er.tick<=$4::bigint
          AND er.data->>'kind'='targets_concept' AND er.data#>>'{to,kind}'='concept'
          AND (er.data#>>'{from,sourceUse,id}',er.data#>>'{from,sourceUse,rev}')=(f.id,f.current_rev::text)
      ))
    ORDER BY f.created_tick DESC,f.id LIMIT $8`,
  [tx.learner, workspaceEntryType, purpose, through, knowledgeEdgeType, JSON.stringify(concepts), !concepts.length, scanLimit + 1]);

  const items: Question[] = [];
  let truncated = rows.length > scanLimit;
  let known = 0;
  let unknown = 0;
  let remainingBytes = outputBytes;
  const limit = typeof args.limit === 'number' ? args.limit : 30;
  for (const { id } of rows.slice(0, scanLimit)) {
    const witnesses: Witness[] = [];
    const track: SourceTrack = (...w) => witnesses.push(w);
    const source = await resolveSource(tx, id, { ...sourceAccess, track });
    const root = witnesses.find(([fact]) => fact.ref.id === id)?.[0];
    if (!isSourceFactId(id) || source?.kind !== 'question' || root?.type !== workspaceEntryType) continue;
    const kcIds = new Set<string>();
    if (concepts.length) {
      const { rows: edges } = await tx.query<{ id: string }>(`
        SELECT f.id FROM facts f JOIN fact_revs r
          ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
        JOIN jsonb_to_recordset($5::jsonb) AS kc(id text,rev int)
          ON (r.data#>>'{to,sourceUse,id}',r.data#>>'{to,sourceUse,rev}')=(kc.id,kc.rev::text)
        WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.kind='value'
          AND f.purpose && ARRAY[$6,'all'] AND r.purpose && ARRAY[$6,'all'] AND r.tick<=$7::bigint
          AND r.data->>'kind'='targets_concept' AND r.data#>>'{to,kind}'='concept'
          AND (r.data#>>'{from,sourceUse,id}',r.data#>>'{from,sourceUse,rev}')=($3,$4::int::text)
        ORDER BY f.id LIMIT $8`,
      [tx.learner, knowledgeEdgeType, id, source.rev, JSON.stringify(concepts), purpose, through, scanLimit + 1]);
      truncated ||= edges.length > scanLimit;
      for (const edgeId of edges.slice(0, scanLimit)) {
        const edge = await openKnowledgeEdge(tx, edgeId.id, sourceAccess);
        if (!edge || edge.value.kind !== 'targets_concept' || edge.from.kind !== 'question' ||
            edge.from.id !== id || edge.from.rev !== source.rev || edge.to.kind !== 'concept' ||
            !concepts.some(kc => kc.id === edge.to.id && kc.rev === edge.to.rev) || kcIds.has(edge.to.id)) continue;
        kcIds.add(edge.to.id);
        witnesses.push(...edge.opened);
      }
      if (!kcIds.size) continue;
    }
    const answerExposed = await confirmedAnswerDisplay(tx, root.ref, through, access.maySend, track);
    if (answerExposed === null) unknown++;
    else known++;
    // A row excluded by the answer filter may still determine the coverage status.
    for (const witness of witnesses) access.track(...witness);
    if (args.answer_exposed !== undefined && args.answer_exposed !== answerExposed) continue;
    const { title, body } = workspaceEntry(root.value);
    const item = { id, rev: source.rev, title, prompt: body, kc_ids: [...kcIds].sort(), answer_exposed: answerExposed };
    remainingBytes -= Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length === limit || remainingBytes < 0) {
      truncated = true;
      break;
    }
    items.push(item);
  }
  for (const witness of conceptWitnesses) access.track(...witness);
  const coverage = unknown || truncated ? (known ? 'partial' : 'unknown') : 'complete';
  return { value: { scope: 'authorized_workbook_source_questions', coverage, truncated, items } };
}
