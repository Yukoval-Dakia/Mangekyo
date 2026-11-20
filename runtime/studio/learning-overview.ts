import { readable } from '../../kernel/src/commands/fact-collection.ts';
import {createCommandReadContext} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot, ReadContext} from '../../kernel/src/declarations/types.ts';
import {goalType, studyGoal} from '../../modules/plan/goal-values.ts';
import {organizerTask, organizerTaskType} from '../../modules/plan/organizer-task-values.ts';
import {type LearningOverview, type LearningOverviewFact, type LearningOverviewTask, type LearningOverviewWitness,
} from '../../modules/activity/workspace-values.ts';

export const learningOverviewPurpose = 'teaching';
const taskLimit = 50;
export type LearningOverviewAccess = {
  readonly callerPurpose: string;
  readonly maySend: (fact: LearningOverviewFact, snapshot: FactSnapshot) => boolean;
  readonly track?: (snapshot: FactSnapshot) => void;
};
async function authorized(id: string, access: LearningOverviewAccess, read: ReadContext) {
  const fact = await readable(() => read.fact(factId(id), {mode: 'following'}));
  if (!fact) return;
  const output = {id, rev: fact.ref.rev, type: fact.type, value: fact.value, accessEpoch: fact.accessEpoch};
  return access.maySend(output, fact) ? {output, snapshot: fact} : undefined;
}

function witness(fact: LearningOverviewFact): LearningOverviewWitness {
  return {id: fact.id, rev: fact.rev, type: fact.type, accessEpoch: fact.accessEpoch};
}

export async function readGoal(tx: ReadTransaction, access: LearningOverviewAccess,
  read = createCommandReadContext(tx, access.callerPurpose)) {
  const {rows: [row]} = await tx.query<{id: string}>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id LIMIT 1`, [tx.learner, goalType]);
  if (!row) return {state: 'empty' as const};
  const fact = await authorized(row.id, access, read);
  if (!fact) return {state: 'unavailable' as const};
  const goal = studyGoal(fact.output.value);
  access.track?.(fact.snapshot);
  return {state: 'set' as const, ...goal, witness: witness(fact.output)};
}

export async function readTasks(tx: ReadTransaction, access: LearningOverviewAccess, limit: number | null = taskLimit): Promise<LearningOverview['tasks']> {
  const {rows} = await tx.query<{id: string}>(
    `SELECT f.id FROM facts f
     JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
       AND f.purpose && ARRAY[$3,'all']::text[] AND r.purpose && ARRAY[$3,'all']::text[]
     ORDER BY r.data->>'date', (r.data->>'done')::boolean, CASE WHEN $4::integer IS NULL THEN 0 ELSE f.created_tick END, f.id LIMIT $4`,
    [tx.learner, organizerTaskType, access.callerPurpose, limit === null ? null : limit + 1]);
  const read = createCommandReadContext(tx, access.callerPurpose);
  const items: LearningOverviewTask[] = [];
  const witnesses: LearningOverviewWitness[] = [];
  let partial = false;
  for (const row of limit === null ? rows : rows.slice(0, limit)) {
    const fact = await authorized(row.id, access, read);
    try {
      if (!fact) continue;
      const { id, rev, value } = fact.output;
      items.push({id, rev, ...organizerTask(value)});
      witnesses.push(witness(fact.output));
      access.track?.(fact.snapshot);
    } catch {
      partial = true;
    }
    if (!fact) partial = true;
  }
  if (!items.length) return {state: partial ? 'unavailable' : 'empty', witnesses: []};
  return {state: partial || (limit !== null && rows.length > limit) ? 'partial' : 'available', items, witnesses};
}

export async function readLearningOverview(tx: ReadTransaction, access: LearningOverviewAccess): Promise<LearningOverview> {
  const current = await readGoal(tx, access);
  const goal: LearningOverview['goal'] = current.state === 'set'
    ? {state: current.state, text: current.text, witness: current.witness}
    : current;
  const tasks = await readTasks(tx, access);
  return {goal, tasks, witnesses: [...(goal.state === 'set' ? [goal.witness] : []), ...tasks.witnesses]};
}
