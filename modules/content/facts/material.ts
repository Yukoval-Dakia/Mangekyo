import { defineFact } from '@mangekyo/kernel';
import { materialType, textMaterial } from '../text-material.ts';

export default defineFact({ type: materialType, schema: { parse: textMaterial } });
