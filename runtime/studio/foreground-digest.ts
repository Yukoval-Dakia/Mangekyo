import { createCommandReadContext, isFactUnavailable } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { parseManifest, type Manifest } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { buildForegroundDigest, readAuthorizedForegroundDigests, type ForegroundDigest } from '../../modules/activity/foreground-digest.ts';
import { purpose, slotType } from './identity.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

export type { ForegroundDigest };
export const foregroundDigest = (id: string, manifest: Manifest, sourceIds: readonly string[], summary: string): ForegroundDigest =>
  buildForegroundDigest(id, manifest.inputs, sourceIds, summary);

export async function readForegroundDigests(tx: ReadTransaction, access: {
  afterTick: string; maySend: WorkspaceSourceRecipient; authorize: (tx: ReadTransaction) => Promise<void>;
}) {
  const result = await readAuthorizedForegroundDigests(tx, slotType, access.afterTick, {
    read: createCommandReadContext(tx, purpose),
    maySend: access.maySend,
    authorize: () => access.authorize(tx),
    isManifestValid: async manifest => (await revalidateManifest(tx, parseManifest(manifest), purpose)).kind === 'valid',
    isUnavailable: isFactUnavailable,
  });
  return { digests: result.digests.map(({ tick: _, ...digest }) => digest), nextAfterTick: result.nextAfterTick };
}
