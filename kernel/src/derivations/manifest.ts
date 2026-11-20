import { z } from 'zod';
import { canonicalJsonString } from '../commands/canonical.ts';
import { slotTypePattern } from '../declarations/define.ts';
import { derivationId, factId, learnerId, type Tick } from '../declarations/ids.ts';

const tick = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(value => value as Tick);
const slotType = z.string().regex(slotTypePattern);
const member = z.object({
  slotKey: z.string(),
  derivationId: z.string().transform(derivationId),
}).strict();
const fact = z.object({
  kind: z.literal('fact'),
  id: z.string().transform(factId),
  rev: z.number().int().positive().max(2_147_483_647),
  accessEpoch: tick,
  mode: z.enum(['pinned', 'following']),
}).strict();
const slot = z.object({
  kind: z.literal('slot'),
  slotType,
  slotKey: z.string(),
  derivationId: z.string().transform(derivationId),
  mode: z.enum(['pinned', 'following', 'asof']),
}).strict();
const range = z.object({
  kind: z.literal('range'),
  slotType,
  scope: z.record(z.string(), z.json()),
  watermark: tick,
  members: z.array(member),
}).strict().superRefine((value, ctx) => {
  const keys = value.members.map(entry => entry.slotKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate range slot' });
});
const schema = z.object({
  version: z.literal(1),
  learner: z.string().transform(learnerId),
  purpose: z.string().min(1),
  gatherTick: tick,
  inputs: z.array(z.discriminatedUnion('kind', [fact, slot, range])),
}).strict().superRefine((value, ctx) => {
  for (const input of value.inputs) {
    if (input.kind === 'range' && input.watermark !== value.gatherTick) {
      ctx.addIssue({ code: 'custom', message: 'Range watermark must be the gather snapshot tick' });
    }
  }
});
export type Manifest = z.infer<typeof schema>;
export type ManifestInput = Manifest['inputs'][number];
export type ManifestVerdict =
  | { readonly kind: 'valid'; readonly freshness: 'current' | 'behind' }
  | { readonly kind: 'invalid'; readonly reason: string };

export function parseManifest(value: unknown): Manifest {
  canonicalJsonString(value);
  return schema.parse(value);
}
