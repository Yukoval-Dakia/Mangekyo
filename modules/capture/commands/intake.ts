import { defineCommand } from '@mangekyo/kernel';
import { captureIntakeCommand, captureIntakeSchema, intakeFactType, materialType, intakePurpose } from '../intake-values.ts';

export default defineCommand({
  type: captureIntakeCommand,
  destructive: false,
  schema: captureIntakeSchema,
  write: (_ctx, { materialId, intakeId, data }) => [
    {
      kind: 'create',
      id: materialId,
      factType: materialType,
      data: data.material,
      purpose: [intakePurpose],
    },
    {
      kind: 'create',
      id: intakeId,
      factType: intakeFactType,
      data: data.document,
      purpose: [intakePurpose],
    },
  ],
});
