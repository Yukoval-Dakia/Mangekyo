import { defineFact } from '@mangekyo/kernel';
import { retentionReviewPermission, retentionReviewPermissionType } from '../research.ts';

export default defineFact({
  type: retentionReviewPermissionType,
  schema: { parse: retentionReviewPermission },
});
