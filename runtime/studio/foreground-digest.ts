import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { Revision } from '../../kernel/src/declarations/ids.ts';
import { parseManifest, type Manifest, type ManifestInput } from '../../kernel/src/derivations/manifest.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { purpose, slotType } from './identity.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

type SourceRef = Extract<ManifestInput, { kind: 'fact' }>;
export type ForegroundDigest = { id: string; kind: 'companion_completed'; summary: string; sourceRefs: SourceRef[] };

export function foregroundDigest(id: string, manifest: Manifest, sourceIds: readonly string[], summary: string): ForegroundDigest {
  const allowed = new Set([id, ...sourceIds]);
  const sourceRefs = manifest.inputs.filter((entry): entry is SourceRef => entry.kind === 'fact' &&
    allowed.has(entry.id));
  return { id, kind: 'companion_completed', summary,
    sourceRefs: [...new Map(sourceRefs.map(ref => [`${ref.id}:${ref.rev}:${ref.accessEpoch}:${ref.mode}`, ref])).values()] };
}

// The accepted turn is the journal entry. A coordinator supplies its own recipient admission and cursor.
export async function readForegroundDigests(tx: ReadTransaction, access: {
  afterTick: string; maySend: WorkspaceSourceRecipient; authorize: (tx: ReadTransaction) => Promise<void>;
}) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(access.afterTick) || BigInt(access.afterTick) > 9223372036854775807n)
    throw new Error('Digest 游标无效。');
  await access.authorize(tx);
  const { rows } = await tx.query<{ digest: ForegroundDigest; manifest: unknown; tick: string }>(
    `SELECT d.value->'foregroundDigest' AS digest,d.manifest,d.effective_tick::text AS tick
     FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND d.effective_tick>$3::bigint AND d.value ? 'foregroundDigest'
     ORDER BY d.effective_tick LIMIT 24`, [tx.learner, slotType, access.afterTick],
  );
  const reader = createCommandReadContext(tx, purpose);
  const digests: ForegroundDigest[] = [];
  for (const row of rows) {
    const manifest = parseManifest(row.manifest);
    if ((await revalidateManifest(tx, manifest, purpose)).kind !== 'valid') continue;
    try {
      let visible = true;
      for (const ref of row.digest.sourceRefs) {
        const fact = await reader.fact(ref.id, ref.mode === 'pinned'
          ? { mode: 'pinned', rev: ref.rev as Revision } : { mode: 'following' });
        if (fact.ref.rev !== ref.rev || fact.accessEpoch !== ref.accessEpoch || !access.maySend(fact)) {
          visible = false;
          break;
        }
      }
      if (visible) digests.push(row.digest);
    } catch (error) {
      if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    }
  }
  return { digests, nextAfterTick: rows.at(-1)?.tick ?? access.afterTick };
}
