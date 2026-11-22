import { createAuthorizedFactReader, factReadChecks } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { practiceCustodyType } from '../../modules/activity/sealed-practice.ts';
import { workspaceEntryType } from '../../modules/activity/workspace-values.ts';
import { assetType } from '../../modules/content/asset.ts';
import { knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import {
  pythonQuestionsScanLimit, readStudioPythonQuestions, type PythonQuestionsArgs,
  type PythonQuestionsMaySend, type PythonQuestionsTrack, type StudioPythonQuestionsDeps,
} from '../../modules/activity/studio-python-questions-host.ts';
import { toolFailure } from '../../executors/teaching/learning-tools.ts';
import type { PythonRead } from '../../executors/teaching/python-sdk.ts';
import { questionScope } from '../../executors/teaching/question-read-receipts.ts';
import { purpose } from './identity.ts';
import { openKnowledgeEdge } from './knowledge-graph.ts';
import { checkStudioNotionFact } from './notion.ts';
import { questionNegativeCurrent } from './question-exposure.ts';
import { resolveSource } from './source-read.ts';

export async function readPythonQuestions(tx: ReadTransaction, args: PythonRead['args'], through: Tick, access: {
  maySend: PythonQuestionsMaySend; track: PythonQuestionsTrack; known(id: string): boolean; turn: string; trackNegative(id: string): void;
}) {
  const deps: StudioPythonQuestionsDeps = {
    purpose,
    questionScope,
    toolFailure: toolFailure as StudioPythonQuestionsDeps['toolFailure'],
    ...factReadChecks,
    createAuthorizedFactReader: createAuthorizedFactReader as StudioPythonQuestionsDeps['createAuthorizedFactReader'],
    resolveSource: resolveSource as StudioPythonQuestionsDeps['resolveSource'],
    openKnowledgeEdge: (innerTx, input, accessArg) => openKnowledgeEdge(innerTx, input, accessArg as never),
    checkStudioNotionFact: checkStudioNotionFact as StudioPythonQuestionsDeps['checkStudioNotionFact'],
    questionNegativeCurrent: questionNegativeCurrent as StudioPythonQuestionsDeps['questionNegativeCurrent'],
    queryCandidates: async (concepts: readonly { id: string; rev: number }[]) => {
      const { rows } = await tx.query<{ id: string }>(`
        SELECT f.id FROM facts f JOIN fact_revs r
          ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
        WHERE f.learner_id=$1 AND f.type=ANY($2::text[]) AND f.retracted_rev IS NULL AND r.kind='value'
          AND f.purpose && ARRAY[$3,'all'] AND r.purpose && ARRAY[$3,'all'] AND r.tick<=$4::bigint
          AND r.data->>'kind'='question'
          AND (f.type<>$9 OR EXISTS (
            SELECT 1 FROM facts c JOIN fact_revs cr ON (cr.learner_id,cr.fact_id,cr.rev)=(c.learner_id,c.id,c.current_rev)
            WHERE c.learner_id=f.learner_id AND c.type=$10 AND c.retracted_rev IS NULL AND cr.data#>>'{question,id}'=f.id
              AND c.purpose && ARRAY[$3,'all']
          ))
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
      [tx.learner, [workspaceEntryType, assetType], purpose, through, knowledgeEdgeType, JSON.stringify(concepts),
        !concepts.length, pythonQuestionsScanLimit + 1, assetType, practiceCustodyType]);
      return rows;
    },
    queryEdges: async (questionId: string, questionRev: number, concepts: readonly { id: string; rev: number }[]) => {
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
      [tx.learner, knowledgeEdgeType, questionId, questionRev, JSON.stringify(concepts), purpose, through,
        pythonQuestionsScanLimit + 1]);
      return edges;
    },
  };
  return readStudioPythonQuestions(deps, tx, args as PythonQuestionsArgs, through, access) as never;
}
