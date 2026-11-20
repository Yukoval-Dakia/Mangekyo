import { defineFact } from '@mangekyo/kernel';
import { intakeDocument, intakeFactType } from '../intake-values.ts';

export default defineFact({ type: intakeFactType, schema: { parse: intakeDocument } });
