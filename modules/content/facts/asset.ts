import { defineFact } from '@mangekyo/kernel';
import { assetType, parseAsset } from '../asset.ts';

export default defineFact({ type: assetType, schema: { parse: parseAsset } });
