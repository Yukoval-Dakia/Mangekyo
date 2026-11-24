import { createCommandReadContext, factId, readable, type FactSnapshot, type ReadContext, type ReadTransaction } from '@mangekyo/kernel';
import goal from '@mangekyo/module-plan/facts/goal';
import task from '@mangekyo/module-plan/facts/organizer-task';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import type { LearningOverview, LearningOverviewFact, LearningOverviewTask, LearningOverviewWitness } from './workspace-values.ts';

export const learningOverviewPurpose = 'teaching';
const taskLimit = 50;

export const readGoal = (tx: ReadTransaction & ActivityEvidenceReadScope, access: LearningOverviewAccess,
  read: Pick<ReadContext, 'fact'> = createCommandReadContext(tx, access.callerPurpose)) =>
  readGoalOverview(tx, access, read, readable);
export const readTasks = (tx: ReadTransaction & ActivityEvidenceReadScope, access: LearningOverviewAccess, limit?: number | null) =>
  readTasksOverview(tx, access, createCommandReadContext(tx, access.callerPurpose), readable, limit);

export type LearningOverviewAccess = {
  readonly callerPurpose: string; readonly maySend: (fact: LearningOverviewFact, snapshot: FactSnapshot) => boolean;
  readonly track?: (snapshot: FactSnapshot) => void;
};

type FactOpen = <T>(open: () => Promise<T>) => Promise<T | undefined>;
type FactReader = Pick<ReadContext, 'fact'>;

async function authorized(id: string, access: LearningOverviewAccess, read: FactReader, open: FactOpen) {
  const fact = await open(() => read.fact(factId(id), { mode: 'following' }));
  if (!fact) return;
  const output = { id, rev: fact.ref.rev, type: fact.type, value: fact.value, accessEpoch: fact.accessEpoch };
  return access.maySend(output, fact) ? { output, snapshot: fact } : undefined;
}

function witness(fact: LearningOverviewFact): LearningOverviewWitness {
  return { id: fact.id, rev: fact.rev, type: fact.type, accessEpoch: fact.accessEpoch };
}

export async function readGoalOverview(
  tx: ActivityEvidenceReadScope, access: LearningOverviewAccess, read: FactReader, open: FactOpen,
) {
  const { rows: [row] } = await tx.query<{ id: string }>(
    `SELECT id FROM facts WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
     ORDER BY created_tick DESC, id LIMIT 1`, [tx.learner, goal.type]);
  if (!row) return { state: 'empty' as const };
  const fact = await authorized(row.id, access, read, open);
  if (!fact) return { state: 'unavailable' as const };
  const parsed = goal.schema.parse(fact.output.value);
  access.track?.(fact.snapshot);
  return { state: 'set' as const, ...parsed, witness: witness(fact.output) };
}

export async function readTasksOverview(
  tx: ActivityEvidenceReadScope, access: LearningOverviewAccess, read: FactReader, open: FactOpen,
  limit: number | null = taskLimit,
): Promise<LearningOverview['tasks']> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT f.id FROM facts f
     JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL
       AND f.purpose && ARRAY[$3,'all']::text[] AND r.purpose && ARRAY[$3,'all']::text[]
     ORDER BY r.data->>'date', (r.data->>'done')::boolean, CASE WHEN $4::integer IS NULL THEN 0 ELSE f.created_tick END, f.id LIMIT $4`,
    [tx.learner, task.type, access.callerPurpose, limit === null ? null : limit + 1]);
  const items: LearningOverviewTask[] = [];
  const witnesses: LearningOverviewWitness[] = [];
  let partial = false;
  for (const row of limit === null ? rows : rows.slice(0, limit)) {
    const fact = await authorized(row.id, access, read, open);
    try {
      if (!fact) continue;
      const { id, rev, value } = fact.output;
      items.push({ id, rev, ...task.schema.parse(value) });
      witnesses.push(witness(fact.output));
      access.track?.(fact.snapshot);
    } catch {
      partial = true;
    }
    if (!fact) partial = true;
  }
  if (!items.length) return { state: partial ? 'unavailable' : 'empty', witnesses: [] };
  return { state: partial || (limit !== null && rows.length > limit) ? 'partial' : 'available', items, witnesses };
}

export async function readActivityLearningOverview(
  tx: ActivityEvidenceReadScope, access: LearningOverviewAccess, read: FactReader, open: FactOpen,
): Promise<LearningOverview> {
  const current = await readGoalOverview(tx, access, read, open);
  const goalView: LearningOverview['goal'] = current.state === 'set'
    ? { state: current.state, text: current.text, witness: current.witness }
    : current;
  const tasks = await readTasksOverview(tx, access, read, open);
  return { goal: goalView, tasks, witnesses: [...(goalView.state === 'set' ? [goalView.witness] : []), ...tasks.witnesses] };
}

export const readLearningOverview = (tx: ReadTransaction & ActivityEvidenceReadScope, access: LearningOverviewAccess) =>
  readActivityLearningOverview(tx, access, createCommandReadContext(tx, access.callerPurpose), readable);
