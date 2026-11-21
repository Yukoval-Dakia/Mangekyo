import { defineFact } from '@mangekyo/kernel';
import { carePauseType, carePauseValue } from '../care-pause.ts';

export default defineFact({ type: carePauseType, schema: { parse: carePauseValue } });
