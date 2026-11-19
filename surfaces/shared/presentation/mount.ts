import type { Artifact, ArtifactAction } from './index.ts';
import { isRecord } from './schema.ts';

export type ArtifactMount = { mountId: string; stateRev: number };
export interface ArtifactIntentV1 {
  version: 1;
  requestId: string;
  mountId: string;
  baseStateRev: number;
  action: ArtifactAction;
}

// A projection is supplied by the host for this exact mount, state and logic.
// The view cannot supply its own state or executable content.
export interface HostStateV1 extends ArtifactMount {
  version: 1;
  artifactId: string;
  revision: string;
  logic: { id: string; revision: string };
  inputs: Record<string, string>;
}

export function operationLocks(view: Artifact, mount: ArtifactMount, state?: HostStateV1) {
  const locks = new Map<string, string>();
  const spec = view.interaction;
  if (!spec) return locks;
  const valid =
    state?.version === 1 &&
    state.mountId === mount.mountId &&
    state.stateRev === mount.stateRev &&
    state.artifactId === view.id &&
    state.revision === view.revision &&
    state.logic?.id === spec.logic.id &&
    state.logic.revision === spec.logic.revision &&
    isRecord(state.inputs) &&
    Object.keys(state.inputs).length === spec.inputs.length &&
    spec.inputs.every(
      (i) => Object.hasOwn(state.inputs, i.id) && i.values.includes(state.inputs[i.id]!),
    );
  for (const op of spec.operations) {
    if (!valid || state.inputs[op.input] !== op.equals) locks.set(op.target, op.unavailable);
  }
  return locks;
}
