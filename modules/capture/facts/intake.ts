import { defineFact } from '@mangekyo/kernel';
import { archivedIntake, intakeFactType } from '../intake-values.ts';

export default defineFact({ type: intakeFactType, schema: { parse: archivedIntake } });
