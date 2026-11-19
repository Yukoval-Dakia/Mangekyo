import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import {goalType, studyGoal} from '../../modules/activity/library-values.ts';
import {organizerTask, organizerTaskType} from '../../modules/activity/organizer-values.ts';
import {learningOverviewConsumerContract, type LearningOverview, type LearningOverviewFact,
  type LearningOverviewRecipient, type LearningOverviewTask, type LearningOverviewWitness,
} from '../../modules/activity/workspace-values.ts';

export const learningOverviewPurpose = 'teaching';
const taskLimit = 50;
export type LearningOverviewAccess = {readonly callerPurpose: string; readonly maySend: LearningOverviewRecipient};
async function authorized(tx: ReadTransaction, id: string, access: LearningOverviewAccess): Promise<LearningOverviewFact | undefined> {
  try {
    const fact = await createCommandReadContext(tx, access.callerPurpose).fact(factId(id), {mode: 'following'});
    const output = {id, rev: fact.ref.rev, type: fact.type, value: fact.value, accessEpoch: fact.accessEpoch};
    return access.maySend(output) ? output : undefined;
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return undefined;
    throw error;
  }
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
  return {state: 'set', text: studyGoal(fact.value).text, witness: witness(fact)};
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
      items.push({id: fact.id, rev: fact.rev, ...organizerTask(fact.value)});
      witnesses.push(witness(fact));
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
