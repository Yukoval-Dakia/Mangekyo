import { createHash } from 'node:crypto';
import { commandId } from '../../../kernel/src/declarations/ids.ts';
import {
  handleArtifactIntent as verifyArtifactIntent, type ArtifactCommandAdapterV1, type ArtifactGrantV1, type ArtifactMountV1,
} from './host-authority.ts';
const stableId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 26).toUpperCase();

export * from './host-authority.ts';

export function artifactIntentCommandId(requestId: string) {
  return commandId(stableId('artifact-intent-v1', requestId));
}

export function handleArtifactIntent(mount: ArtifactMountV1, grant: ArtifactGrantV1, raw: unknown, commands?: ArtifactCommandAdapterV1) {
  return verifyArtifactIntent(mount, grant, raw, artifactIntentCommandId, commands);
}
