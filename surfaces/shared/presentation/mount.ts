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

/** Project the exercise screen after the host has authorized its mount. */
export function exerciseView(full: Artifact, predictionPrompt: string | null): Artifact {
  return predictionPrompt !== null
    ? {
        version: 1,
        id: full.id,
        revision: full.revision,
        title: '先写下你的预测',
        fallback: predictionPrompt,
        sections: [
          {
            id: 'prediction',
            title: '观察之前',
            layout: 'stack',
            nodes: [
              { kind: 'note', id: 'estimate', label: predictionPrompt },
              {
                kind: 'action',
                id: 'record-prediction',
                label: '保存预测',
                intent: 'saveDraft',
                inputs: ['estimate'],
              },
            ],
          },
        ],
      }
    : {
        ...full,
        sections: full.sections.map((section) => ({
          ...section,
          nodes: section.nodes.map((n) =>
            n.kind === 'asset' ? { kind: 'text' as const, id: n.id, text: n.label + '（媒体尚未授权）' } : n,
          ),
        })),
      };
}

export function savedArtifactCheckpoints(history: readonly {action: ArtifactAction; prediction: boolean}[]) {
  // For each input return its most recent checkpoint. Full action records stay in activity.
  const covered = new Set<string>();
  const saved = [];
  for (const event of history.toReversed()) {
    if (event.prediction) continue;
    const answers = Object.fromEntries(
      Object.entries(event.action.answers).filter(([id]) => !covered.has(id)),
    );
    if (Object.keys(answers).length === 0) continue;
    for (const id of Object.keys(answers)) covered.add(id);
    const { omitted, steps } = event.action.trace;
    saved.unshift({
      answers,
      trace: { omitted, steps: steps.filter((step) => Object.hasOwn(answers, step.nodeId)) },
    });
  }
  return saved;
}
