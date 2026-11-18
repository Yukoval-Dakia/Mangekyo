import { defineCommand } from '@mangekyo/kernel';
import { captureMaterial, materialType, storagePurpose, textMaterial } from '../library-values.ts';
import { creation } from '../values.ts';

export default defineCommand({
  type: captureMaterial,
  destructive: false,
  schema: creation(textMaterial),
  write: (_ctx, { id, data }) => [
    { kind: 'create', id, factType: materialType, data, purpose: [storagePurpose] },
  ],
});
