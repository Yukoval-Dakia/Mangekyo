import { FactNotFoundError, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import type { ActivityEvidenceReadScope } from './evidence-read.ts';
import type { WorkspaceFactInput } from './workspace-values.ts';

export type DigestSourceRef = WorkspaceFactInput;

export type ForegroundDigest = {
  id: string;
  kind: 'companion_completed';
  summary: string;
  sourceRefs: DigestSourceRef[];
};

export function buildForegroundDigest(
  id: string,
  inputs: readonly { readonly kind: string; readonly id?: FactId; readonly rev?: number; readonly accessEpoch?: Tick; readonly mode?: string }[],
  sourceIds: readonly string[],
  summary: string,
): ForegroundDigest {
  const allowed = new Set([id, ...sourceIds]);
  const sourceRefs = inputs.filter((entry): entry is DigestSourceRef =>
    entry.kind === 'fact' && typeof entry.id === 'string' && typeof entry.rev === 'number' &&
    typeof entry.accessEpoch === 'string' && (entry.mode === 'pinned' || entry.mode === 'following') && allowed.has(entry.id));
  return {
    id,
    kind: 'companion_completed',
    summary,
    sourceRefs: [...new Map(sourceRefs.map(ref => [`${ref.id}:${ref.rev}:${ref.accessEpoch}:${ref.mode}`, ref])).values()],
  };
}

export async function readAuthorizedForegroundDigests(
  tx: ActivityEvidenceReadScope,
  slotType: string,
  afterTick: string,
  ports: {
    readonly read: Pick<ReadContext, 'fact'>;
    readonly maySend: (fact: FactSnapshot) => boolean;
    readonly authorize: () => Promise<void>;
    readonly isManifestValid: (manifest: unknown) => Promise<boolean>;
    readonly isUnavailable: (error: unknown) => boolean;
  },
) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(afterTick) || BigInt(afterTick) > 9223372036854775807n) {
    throw new Error('Digest 游标无效。');
  }
  await ports.authorize();
  const { rows } = await tx.query<{ digest: ForegroundDigest; manifest: unknown; tick: Tick }>(
    `SELECT d.value->'foregroundDigest' AS digest, d.manifest, d.effective_tick::text AS tick
     FROM slot_state s JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND d.effective_tick>$3::bigint AND d.value ? 'foregroundDigest'
     ORDER BY d.effective_tick LIMIT 24`, [tx.learner, slotType, afterTick],
  );
  const digests: (ForegroundDigest & { readonly tick: Tick })[] = [];
  for (const row of rows) {
    if (!await ports.isManifestValid(row.manifest)) continue;
    try {
      let visible = true;
      for (const ref of row.digest.sourceRefs) {
        const fact = await ports.read.fact(ref.id, ref.mode === 'pinned'
          ? { mode: 'pinned', rev: ref.rev } : { mode: 'following' });
        if (fact.ref.rev !== ref.rev || fact.accessEpoch !== ref.accessEpoch || !ports.maySend(fact)) {
          visible = false;
          break;
        }
      }
      if (visible) digests.push({ ...row.digest, tick: row.tick });
    } catch (error) {
      if (!(error instanceof FactNotFoundError || ports.isUnavailable(error))) throw error;
    }
  }
  return { digests, nextAfterTick: rows.at(-1)?.tick ?? afterTick };
}
