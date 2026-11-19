import { defineFact } from '@mangekyo/kernel';
import { learnerPreference, learnerPreferenceType } from '../preference-values.ts';

export default defineFact({
  type: learnerPreferenceType,
  schema: { parse: learnerPreference },
  correctableFields: () => ['/text', '/tags', '/scope'],
});
