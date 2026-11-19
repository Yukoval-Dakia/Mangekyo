import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import {
  declarePreferenceCommand,
  learnerPreferenceType,
  preferenceDeclareInput,
  storagePurpose,
} from '../preference-values.ts';

export default defineCommand({
  type: declarePreferenceCommand,
  destructive: true,
  schema: { parse: preferenceDeclareInput },
  write: (_ctx, { id, data }): readonly FactWrite[] => [
    { kind: 'create', id, factType: learnerPreferenceType, data, purpose: [storagePurpose] },
  ],
});
