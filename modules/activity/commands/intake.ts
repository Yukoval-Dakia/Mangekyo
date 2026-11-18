import { defineCommand } from '@mangekyo/kernel';
import { captureIntakeSchema, intakeFactType, materialType, intakePurpose } from '../intake-values.ts';

export default defineCommand({
  type: 'activity.captureIntake',
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
