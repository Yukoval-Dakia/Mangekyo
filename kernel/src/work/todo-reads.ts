import { ZodError } from 'zod';
import type { ReadTransaction } from '../db/types.ts';
import { readTodo, todoSlot, type TodoSpec } from './todos.ts';

type ActiveTodoRow = {
  id: string;
  slotKey: string;
  generation: string;
  revision: number;
  state: 'pending' | 'ready' | 'waiting';
};

export async function* readActiveTodos(tx: ReadTransaction, profile: TodoSpec['workerProfile'], id?: string) {
  const {rows} = await tx.query<ActiveTodoRow>(
    `SELECT id, slot_key AS "slotKey", generation::text, revision, state FROM work
     WHERE learner_id=$1 AND slot_type=$2 AND family='todo' AND deriver=$3
       AND state IN ('pending','ready','waiting') AND ($4::text IS NULL OR id=$4)
     ORDER BY registered_tick DESC, id LIMIT 12`, [tx.learner, todoSlot, profile, id ?? null]);
  for (const {slotKey, ...work} of rows) {
    const todo = await readTodo(tx, slotKey).catch(error => {
      if (!(error instanceof ZodError)) throw error;
      return null;
    });
    if (todo?.revision === work.revision) yield {...work, spec:todo.spec};
  }
}
