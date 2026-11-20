import {createCommandReadContext} from '../../kernel/src/commands/reads.ts';
import {readable} from '../../kernel/src/commands/fact-collection.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
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
async function authorized(tx: ReadTransaction, id: string, access: LearningOverviewAccess) {
  const fact = await readable(() => createCommandReadContext(tx, access.callerPurpose).fact(factId(id), {mode: 'following'}));
  if (!fact) return;
  const output = {id, rev: fact.ref.rev, type: fact.type, value: fact.value, accessEpoch: fact.accessEpoch};
  return access.maySend(output, fact) ? { output, snapshot: fact } : undefined;
}

function witness(fact: LearningOverviewFact): LearningOverviewWitness {
  return {id: fact.id, rev: fact.rev, type: fact.type, accessEpoch: fact.accessEpoch};
}

async function readGoal(tx: ReadTransaction, access: LearningOverviewAccess): Promise<LearningOverview['goal']> {
  const {rows: [row]} = await tx.query<{id: string}>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id LIMIT 1`, [tx.learner, goalType]);
  if (!row) return {state: 'empty'};
  const fact = await authorized(tx, row.id, access);
  if (!fact) return {state: 'unavailable'};
  const text = studyGoal(fact.output.value).text;
  access.track?.(fact.snapshot);
  return {state: 'set', text, witness: witness(fact.output)};
}

async function readTasks(tx: ReadTransaction, access: LearningOverviewAccess): Promise<LearningOverview['tasks']> {
  const {rows} = await tx.query<{id: string}>(
    `SELECT f.id FROM facts f
     JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
       AND f.purpose && ARRAY[$3,'all']::text[] AND r.purpose && ARRAY[$3,'all']::text[]
     ORDER BY r.data->>'date', (r.data->>'done')::boolean, f.created_tick, f.id LIMIT $4`,
    [tx.learner, organizerTaskType, access.callerPurpose, taskLimit + 1]);
  const items: LearningOverviewTask[] = [];
  const witnesses: LearningOverviewWitness[] = [];
  let partial = false;
  for (const row of rows.slice(0, taskLimit)) {
    const fact = await authorized(tx, row.id, access);
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
  return {state: partial || rows.length > taskLimit ? 'partial' : 'available', items, witnesses};
}

export async function readLearningOverview(tx: ReadTransaction, access: LearningOverviewAccess): Promise<LearningOverview> {
  // For today/review/proposals: empty means no current value; unavailable/partial
  // means values were withheld. Tasks are date/unfinished ordered, capped at 50.
  // This is an authorized snapshot with read witnesses, not a generated plan.
  const goal = await readGoal(tx, access);
  const tasks = await readTasks(tx, access);
  return {goal, tasks, witnesses: [...(goal.state === 'set' ? [goal.witness] : []), ...tasks.witnesses]};
}
