import { defineCommand } from '@mangekyo/kernel';
import { storagePurpose } from '../library-values.ts';
import { issuedPosttestPaper, issuePosttestCommand, posttestIssuance, posttestIssuanceType, retentionTeachingPurpose } from '../retention-posttest.ts';
import { creation } from '../values.ts';

export default defineCommand({
  type: issuePosttestCommand,
  destructive: false,
  schema: creation(posttestIssuance),
  async write(ctx, { id, data }) {
    // Studio verifies the effective forecast and its manifest under the learner lock.
    await issuedPosttestPaper(ctx.read, data);
    return [{ kind: 'create', id, factType: posttestIssuanceType, data, purpose: [storagePurpose, retentionTeachingPurpose] }];
  },
});
