import type { FactId, ReadTransaction } from '../../kernel/src/index.ts';
import { readPosttestIssuanceBirth } from '../../modules/activity/evidence-read.ts';
import { posttestAttemptFor, posttestIdFor, readPosttestIssuance as readIssuance, type PosttestFactReader } from '../../modules/activity/retention-host-support.ts';
import { RequestError } from './sessions.ts';
export { posttestAttemptFor, posttestIdFor, type PosttestFactReader };
export function readPosttestIssuance(tx: ReadTransaction, read: PosttestFactReader, id: FactId, readBirth = readPosttestIssuanceBirth) {
  return readIssuance(tx, read, id, readBirth, { RequestError });
}
