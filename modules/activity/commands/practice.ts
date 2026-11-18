import { defineCommand } from '@mangekyo/kernel';
import {
  gradePractice,
  practiceInput,
  ridingPracticeCommand,
  ridingPracticePurpose,
  ridingPracticeType,
} from '../practice-values.ts';
import { creation } from '../values.ts';

export default defineCommand({
  type: ridingPracticeCommand,
  destructive: false,
  schema: creation(practiceInput),
  write: (_ctx, { id, data }) => [
    {
      kind: 'create',
      id,
      factType: ridingPracticeType,
      data: gradePractice(data),
      purpose: [ridingPracticePurpose],
    },
  ],
});
