import { defineFact } from '@mangekyo/kernel';
import { planRule, planRuleType } from '../rules.ts';
export default defineFact({ type: planRuleType, schema: { parse: planRule }, correctableFields: () => [''] });
