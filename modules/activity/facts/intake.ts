import { defineFact } from '@mangekyo/kernel';
import { intakeDocument } from '../intake-values.ts';

export default defineFact({ type: 'activity.intakeDocument', schema: { parse: intakeDocument } });
