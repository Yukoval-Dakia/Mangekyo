import { defineFact } from '@mangekyo/kernel';
import { artifactActionRecord } from '../artifact-action.ts';
export default defineFact({ type: 'activity.artifactAction', schema: { parse: artifactActionRecord } });
