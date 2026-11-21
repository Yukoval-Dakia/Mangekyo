import { learningPythonReadLabel } from '../../executors/teaching/question-read-receipts.ts';
import { learnerId } from '../../kernel/src/declarations/ids.ts';
import type { SessionErasure } from '../../kernel/src/work/session-erasure.ts';
import { slotType } from './identity.ts';
import { completeTurnStream } from './stream.ts';

export const teachingErasure: SessionErasure = {
  slotType,
  readLabels: ['local:open_learning', 'local:read_workspace', 'local:search_workspace', 'local:read_learner_radar',
    'local:python_attempts', learningPythonReadLabel, 'local:learning-memory', 'local:first-turn-jit'],
  async open(tx, learner, roots) {
    const {rows} = await tx.query<{id:string}>(`
      SELECT DISTINCT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
      JOIN fact_revs origin ON (origin.learner_id,origin.fact_id,origin.rev)=(r.learner_id,r.data->>'sessionId',1)
      WHERE f.learner_id=$1 AND f.type='activity.studyTurn' AND origin.data#>>'{attachment,id}'=ANY($2::text[])`, [learner,roots]);
    const {rows:[store]} = await tx.query<{present:boolean}>("SELECT to_regclass('studio_turn_stream') IS NOT NULL AS present");
    const drafts = store?.present ? (await tx.query<{turn:string; manifest:unknown}>(
      'SELECT turn_id AS turn,manifest FROM studio_turn_stream WHERE learner_id=$1', [learner])).rows : [];
    return {turns:rows.map(row=>row.id),drafts};
  },
  async clearDrafts(tx, learner, turns) {
    const {rows:[store]} = await tx.query<{present:boolean}>("SELECT to_regclass('studio_turn_stream') IS NOT NULL AS present");
    if (store?.present) for (const turn of turns) await completeTurnStream({...tx,learner:learnerId(learner)},turn);
  },
};
