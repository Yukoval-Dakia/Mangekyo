import { commandId } from '../../kernel/src/declarations/ids.ts';
import {
  handleArtifactIntent as verifyArtifactIntent, type ArtifactCommandAdapterV1, type ArtifactGrantV1, type ArtifactMountV1,
} from '../../surfaces/shared/presentation/host-authority.ts';
import { stableId } from './identity.ts';

export * from '../../surfaces/shared/presentation/host-authority.ts';

export function artifactIntentCommandId(requestId: string) {
  return commandId(stableId('artifact-intent-v1', requestId));
}

export function handleArtifactIntent(mount: ArtifactMountV1, grant: ArtifactGrantV1, raw: unknown, commands?: ArtifactCommandAdapterV1) {
  return verifyArtifactIntent(mount, grant, raw, artifactIntentCommandId, commands);
}
