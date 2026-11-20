import { defineFact } from '@mangekyo/kernel';

export const note = defineFact({
  type: 'boundary.note',
  schema: { parse: (value: unknown) => ({ body: String(value) }) },
});

import type { BusMutation, CanonicalEvidenceSliceV1, Directive, PipelineBus, ToolError } from '@mangekyo/kernel';

export function recover(error: ToolError) {
  return error.code === 'not_found' ? error.candidates : error.next.args;
}
export function submit(bus: PipelineBus<CanonicalEvidenceSliceV1, 'calculation'>, command: BusMutation) {
  return bus.mutate(command);
}
export type TimedDirective = Extract<Directive<'general', string>, { kind: 'state' }>['validTo'];
// @ts-expect-error A short-lived directive must have an end time.
const missingEnd: TimedDirective = null;
