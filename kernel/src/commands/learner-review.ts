import { lockLearner, withinLearnerTransaction } from '../db/learner.ts';
import type { Db, DbTransaction } from '../db/types.ts';
import type { CommandId, FactId, Revision } from '../declarations/ids.ts';
import type { Json, ReadContext } from '../declarations/types.ts';
import type { CommandRequest, CommandRuntimeOptions } from './contracts.ts';
import { createCommandHandler, readRecordedCommand } from './handle.ts';
import { createCommandReadContext } from './reads.ts';

/** Compose proposal decisions and their revision journal inside an existing learner write transaction. */
export function learnerReviewPorts(db: Db, tx: DbTransaction, options: CommandRuntimeOptions) {
  const local = withinLearnerTransaction(db, tx);
  const handle = createCommandHandler(local, options);
  const scope = {
    read: createCommandReadContext(tx, 'storage'),
    recorded: (id: CommandId) => readRecordedCommand(tx, id),
    async revisionCommands(page: FactId, after: Revision, through: Revision) {
      const {rows} = await tx.query<{command_id: CommandId}>(
        'SELECT command_id FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev>$3 AND rev<=$4 ORDER BY rev',
        [tx.learner, page, after, through]);
      return rows.map(row => row.command_id);
    },
    send(request: CommandRequest, bind?: (read: ReadContext) => ReadContext) {
      return bind ? createCommandHandler(local, {...options, bindCommandRead: (inner, req, base) =>
        bind(options.bindCommandRead?.(inner, req, base) ?? base)})(request) : handle(request);
    },
    decideProposal(request: Parameters<typeof handle.decideProposal>[0], select: (input: Json) => Promise<Json | null>) {
      return handle.decideProposal(request, (_, input) => select(input));
    },
  };
  type Scope = typeof scope;
  return {
    read: createCommandReadContext, recorded: readRecordedCommand, decideProposal: handle.decideProposal,
    withLearnerWrite: async <T>(learner: typeof tx.learner, run: (scope: Scope, tx: DbTransaction) => Promise<T>) => {
      if (tx.learner !== learner) throw new Error('Transaction learner mismatch');
      await lockLearner(tx, learner);
      return run(scope, tx);
    },
  };
}
