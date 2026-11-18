import { defineFact } from '@mangekyo/kernel';

export const note = defineFact({
  type: 'boundary.note',
  schema: { parse: (value: unknown) => ({ body: String(value) }) },
});
