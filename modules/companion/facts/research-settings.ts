import { defineFact } from '@mangekyo/kernel';
import { researchSettings, researchSettingsType } from '../research.ts';

export default defineFact({ type: researchSettingsType, schema: { parse: researchSettings } });
