import { defineFact } from '@mangekyo/kernel';
import { artifactMount } from '../artifact.ts';
export default defineFact({ type: 'content.mountedArtifact', schema: { parse: artifactMount } });
