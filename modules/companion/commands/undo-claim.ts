import { defineCommand } from '@mangekyo/kernel';
import { readClaimPredecessor, claimRef, undoClaimCommand } from '../claim.ts';

export default defineCommand({
  type: undoClaimCommand,
  destructive: true,
  schema: {parse: claimRef},
  async write(ctx, expected) {
    await readClaimPredecessor(ctx, expected);
    return [{kind: 'retract', id: expected.id, expectedRev: expected.rev}];
  },
});
