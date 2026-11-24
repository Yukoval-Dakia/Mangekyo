import type { Manifest } from '../../kernel/src/index.ts';
import { buildForegroundDigest, type ForegroundDigest } from '../../modules/activity/foreground-digest.ts';
export type { ForegroundDigest };
export const foregroundDigest = (id: string, manifest: Manifest, sourceIds: readonly string[], summary: string): ForegroundDigest =>
  buildForegroundDigest(id, manifest.inputs, sourceIds, summary);
