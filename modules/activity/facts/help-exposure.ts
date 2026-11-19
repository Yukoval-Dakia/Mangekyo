import { defineFact } from '@mangekyo/kernel';
import { helpExposure, helpExposureType } from '../help-exposure-values.ts';

export default defineFact({ type: helpExposureType, schema: { parse: helpExposure } });
