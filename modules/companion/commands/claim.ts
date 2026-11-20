import { defineCommand } from '@mangekyo/kernel';
import { applyClaimCommand, claimInput, writeTurnClaims } from '../claim.ts';

export default defineCommand({
  type: applyClaimCommand,
  destructive: false,
  schema: {parse: claimInput},
  write: (ctx, entries) => writeTurnClaims(ctx, entries),
});
