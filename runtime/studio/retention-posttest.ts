import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from './fact-read-helpers.ts';
import { RequestError } from './sessions.ts';
import { withinLearnerTransaction } from '../../kernel/src/db/learner.ts';
import { posttestWriter as writer } from '../../modules/activity/retention-host-support.ts';

export { posttestAttemptFor, posttestIdFor, readPosttestIssuance, type PosttestFactReader } from '../../modules/activity/retention-host-support.ts';

export const posttestWriter = (db: Parameters<typeof writer>[0], activity: Parameters<typeof writer>[1]) =>
  writer(db, activity, createPropagationHooks([]), {createCommandReadContext, createCommandHandler, withinLearnerTransaction, RequestError});
