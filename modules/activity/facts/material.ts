import { defineFact } from '@mangekyo/kernel';
import { materialType, textMaterial } from '../library-values.ts';

export default defineFact({ type: materialType, schema: { parse: textMaterial } });
