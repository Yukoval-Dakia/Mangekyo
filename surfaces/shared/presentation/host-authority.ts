import { createHash } from 'node:crypto';
import { canonicalJsonString } from '../../../kernel/src/commands/canonical.ts';
import { factId, type CommandId, type LearnerId, type Revision } from '../../../kernel/src/declarations/ids.ts';
import type { CommandReceipt, JsonObject } from '../../../kernel/src/declarations/types.ts';
import {
  validateArtifact,
  type Answer,
  type Artifact,
  type ArtifactAction,
  type ViewNode,
} from './index.ts';
import { assessmentSubmission, type AssessmentRelease } from '../../../modules/activity/assessment-values.ts';
import { isRecord } from './schema.ts';
import { exerciseView, operationLocks, type HostStateV1 } from './mount.ts';

/**
 * Callers load the current mount and grant from the authenticated learner's session/turn.
 * Use one mount ID per mount lifetime. Advance viewSeq for a new delivery and stateRev
 * when the state or grant that actions rely on changes. Pass the last cursor for
 * ordered delivery and omit it for an unconditional snapshot.
 * The grant must come from host policy and committed disclosure state. Hash the exact
 * phase-approved view with artifactViewDigest. Asset resolution must enforce the same
 * learner, mount and phase. A candidate cannot supply its own grant.
 */
export type ArtifactSnapshotV1 = {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly mountId: string;
  readonly viewSeq: number;
  readonly stateRev: number;
  readonly view: Artifact;
};

export type ArtifactIntentV1 = {
  readonly version: 1;
  readonly requestId: string;
  readonly mountId: string;
  readonly baseStateRev: number;
  readonly action: Readonly<ArtifactAction>;
};

type ArtifactCursor = Omit<ArtifactSnapshotV1, 'version' | 'view'>;
type MountRef = Pick<ArtifactCursor, 'sessionId' | 'turnId' | 'mountId'>;
type MountRevision = MountRef & {
  readonly learnerId: LearnerId;
  readonly artifactId: string;
  readonly revision: string;
  readonly stateRev: number;
};
type ProjectionPhase = 'exercise' | 'help' | 'reveal';
type ActionNode = Extract<ViewNode, { kind: 'action' }>;
type DraftIntent = 'explore' | 'saveDraft';
type CommandIntent = Exclude<ArtifactAction['intent'], DraftIntent>;

export type ArtifactMountV1 = MountRevision & {
  readonly viewSeq: number;
  readonly status: 'open' | 'readOnly';
  readonly presentation: {
    readonly phase: ProjectionPhase | 'submission-material';
    readonly view: unknown;
  };
};

export type ArtifactGrantV1 = MountRevision & {
  readonly phase: ProjectionPhase;
  readonly viewDigest: string;
  readonly assets?: readonly string[];
  readonly actions: readonly {
    readonly nodeId: string;
    readonly intent: ArtifactAction['intent'];
    readonly inputs: readonly string[];
  }[];
};

type CommandKey = { readonly learnerId: LearnerId; readonly commandId: CommandId };
type CommandInput = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly intent: ArtifactIntentV1;
};
type VerifiedRequest = CommandKey & {
  readonly input: CommandInput;
  readonly traceStatus: 'reported' | 'truncated';
};

/**
 * A wired adapter reads the kernel's stored command input by learner and stable ID.
 * Execute using that ID and full input for kernel replay comparison, and recheck current
 * mount authorization/revision in the write transaction. The domain owns submission,
 * disclosure, assessment and publication. A browser trace accompanies the request as a
 * report. Process evidence requires independent domain events and a complete history.
 */
export type ArtifactCommandAdapterV1 = {
  readonly readInput: (key: CommandKey) => Promise<CommandInput | null>;
  readonly execute?: Partial<
    Record<CommandIntent, (request: VerifiedRequest) => Promise<CommandReceipt>>
  >;
};

function reject<const Code extends string>(code: Code) {
  return { ok: false as const, code };
}

function sameMount(left: MountRef, right: MountRef): boolean {
  return left.sessionId === right.sessionId && left.turnId === right.turnId && left.mountId === right.mountId;
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function token(value: unknown, minLength = 1): value is string {
  return typeof value === 'string' && value.length >= minLength && value.length <= 100 &&
    !/[^A-Za-z0-9_-]/.test(value);
}

function jsonCopy(value: unknown): unknown {
  try {
    return JSON.parse(canonicalJsonString(value));
  } catch {
    return undefined;
  }
}

export function artifactViewDigest(view: Artifact): string {
  return createHash('sha256').update(canonicalJsonString(view)).digest('hex');
}

export function projectArtifactSnapshot(mount: ArtifactMountV1, grant: ArtifactGrantV1, after?: ArtifactCursor) {
  const { sessionId, turnId, mountId, viewSeq, stateRev, presentation } = mount;
  if (
    !sameMount(mount, grant) || mount.learnerId !== grant.learnerId ||
    mount.artifactId !== grant.artifactId || mount.revision !== grant.revision || stateRev !== grant.stateRev
  ) return reject('mount-forbidden');
  if (
    ![sessionId, turnId, mountId].every(value => token(value)) || !counter(viewSeq) || !counter(stateRev) ||
    (mount.status !== 'open' && mount.status !== 'readOnly')
  ) return reject('invalid-mount');
  if (
    after && (!sameMount(mount, after) || !counter(after.viewSeq) || !counter(after.stateRev) ||
      viewSeq <= after.viewSeq || stateRev < after.stateRev)
  ) return reject('out-of-order');

  const { phase } = presentation;
  if (phase === 'submission-material') return reject('submission-material');
  if ((phase !== 'exercise' && phase !== 'help' && phase !== 'reveal') || phase !== grant.phase)
    return reject('phase-forbidden');
  const validated = validateArtifact(jsonCopy(presentation.view));
  if (!validated.ok || validated.view.id !== mount.artifactId || validated.view.revision !== mount.revision)
    return reject('invalid-view');
  const { view } = validated;
  if (artifactViewDigest(view) !== grant.viewDigest) return reject('view-forbidden');
  if (view.sections.some(section => section.nodes.some(node =>
    node.kind === 'asset' && !grant.assets?.includes(node.assetId)
  ))) return reject('asset-forbidden');
  const snapshot: ArtifactSnapshotV1 = { version: 1, sessionId, turnId, mountId, viewSeq, stateRev, view };
  return { ok: true as const, snapshot };
}


/** Project display and action state once the host has authorized the stored mount and its history. */
export function projectArtifactMountState<Event extends { action: ArtifactAction; prediction: boolean }>(
  approvedView: Artifact,
  predictionPrompt: string | null,
  history: readonly Event[],
  scope: Pick<ArtifactMountV1, 'learnerId' | 'sessionId' | 'turnId' | 'mountId'>,
) {
  const prediction = history.find((e) => e.prediction);
  const predicting = Boolean(predictionPrompt && !prediction);
  const view = exerciseView(approvedView, predicting ? predictionPrompt : null);
  const stateRev = history.length;
  const base = {
    ...scope,
    artifactId: view.id,
    revision: view.revision,
    stateRev,
  };
  const hostState: HostStateV1 | undefined =
    view.interaction?.logic.id === 'prediction-phase' &&
    view.interaction.logic.revision === 'r1' &&
    prediction
      ? {
          version: 1,
          artifactId: view.id,
          revision: view.revision,
          mountId: scope.mountId,
          stateRev,
          logic: view.interaction.logic,
          inputs: { phase: 'experiment' },
        }
      : undefined;
  const locks = operationLocks(view, base, hostState);
  const unavailable: Record<string, string> = {};
  for (const node of view.sections.flatMap((section) => section.nodes)) {
    if (node.kind !== 'action') continue;
    if (node.intent === 'requestHelp' || node.intent === 'requestReveal')
      unavailable[node.id] = '此作品尚未绑定帮助或揭示命令。';
    else if (node.inputs.some((id) => locks.has(id))) unavailable[node.id] = '所需输入尚未开放。';
  }
  const submissionEvent = history.find((e) => e.action.intent === 'submit');
  const submitted = Boolean(submissionEvent);
  const mount: ArtifactMountV1 = {
    ...base,
    viewSeq: stateRev,
    status: submitted ? 'readOnly' : 'open',
    presentation: { phase: 'exercise', view },
  };
  const grant = {
    ...base,
    phase: 'exercise' as const,
    viewDigest: artifactViewDigest(view),
    actions: view.sections.flatMap((s) =>
      s.nodes.flatMap((n) =>
        n.kind === 'action' && !locks.has(n.id) && !Object.hasOwn(unavailable, n.id)
          ? [{ nodeId: n.id, intent: n.intent, inputs: n.inputs }]
          : [],
      ),
    ),
  };
  const projected = projectArtifactSnapshot(mount, grant);
  return { mount, grant, projected, hostState, submitted, predicting, unavailable, prediction, submissionEvent };
}

function fields(value: unknown, required: readonly string[], optional?: string): value is Record<string, unknown> {
  return isRecord(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || key === optional);
}

function answerFor(node: ViewNode | undefined, answer: unknown): answer is Answer {
  if (node?.kind === 'range') {
    return fields(answer, ['kind', 'value', 'unit']) && answer.kind === 'quantity' &&
      answer.unit === node.unit && typeof answer.value === 'number' && node.values.includes(answer.value);
  }
  if (node?.kind === 'selection') {
    return fields(answer, ['kind', 'ids']) && answer.kind === 'selection' && Array.isArray(answer.ids) &&
      answer.ids.length <= node.items.length && new Set(answer.ids).size === answer.ids.length &&
      answer.ids.every(id => node.items.some(item => item.id === id));
  }
  return node?.kind === 'note' && fields(answer, ['kind', 'text']) && answer.kind === 'text' &&
    typeof answer.text === 'string' && answer.text.length <= 4096;
}

function readAnswers(raw: unknown, action: ActionNode, nodes: ReadonlyMap<string, ViewNode>) {
  if (!fields(raw, action.inputs)) return undefined;
  const answers: [string, Answer][] = [];
  for (const id of action.inputs) {
    const answer = raw[id];
    if (!answerFor(nodes.get(id), answer)) return undefined;
    answers.push([id, answer]);
  }
  return Object.fromEntries(answers);
}

function traceMatches(
  trace: unknown,
  answers: Record<string, Answer>,
  nodes: ReadonlyMap<string, ViewNode>,
): trace is ArtifactAction['trace'] {
  if (!fields(trace, ['omitted', 'steps']) || !counter(trace.omitted) ||
    !Array.isArray(trace.steps) || trace.steps.length > 128) return false;
  const startKnown = trace.omitted === 0;
  const positions = new Map<string, number>();
  const selected = new Map<string, boolean>();
  const stepTargets = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind === 'scene') {
      for (const object of node.objects) {
        if (object.kind === 'stepTarget') stepTargets.set(object.id, object.source);
      }
    }
  }
  for (const step of trace.steps) {
    if (!isRecord(step) || typeof step.nodeId !== 'string' || !Object.hasOwn(answers, step.nodeId)) return false;
    const node = nodes.get(step.nodeId);
    if (step.kind === 'adjust' && node?.kind === 'range') {
      if (!fields(step, ['kind', 'nodeId', 'value', 'unit'], 'objectId') ||
        typeof step.value !== 'number' || step.unit !== node.unit) return false;
      const position = node.values.indexOf(step.value);
      if (position < 0) return false;
      if (Object.hasOwn(step, 'objectId')) {
        const before = positions.get(node.id) ?? (startKnown ? node.initial : undefined);
        if (typeof step.objectId !== 'string' || stepTargets.get(step.objectId) !== node.id ||
          position === 0 || (before !== undefined && position !== before + 1)) return false;
      }
      positions.set(node.id, position);
    } else if (step.kind === 'toggle' && node?.kind === 'selection') {
      if (!fields(step, ['kind', 'nodeId', 'objectId', 'selected']) ||
        typeof step.objectId !== 'string' || typeof step.selected !== 'boolean' ||
        !node.items.some(item => item.id === step.objectId)) return false;
      const before = selected.get(step.objectId) ?? (startKnown ? node.selected.includes(step.objectId) : undefined);
      if (before === step.selected) return false;
      selected.set(step.objectId, step.selected);
    } else return false;
  }
  for (const [id, answer] of Object.entries(answers)) {
    const node = nodes.get(id);
    if (answer.kind === 'quantity' && node?.kind === 'range') {
      const position = positions.get(id) ?? (startKnown ? node.initial : undefined);
      if (position !== undefined && answer.value !== node.values[position]) return false;
    }
    if (answer.kind === 'selection' && node?.kind === 'selection') {
      const answerIds = new Set(answer.ids);
      for (const item of node.items) {
        const on = selected.get(item.id) ?? (startKnown ? node.selected.includes(item.id) : undefined);
        if (on !== undefined && on !== answerIds.has(item.id)) return false;
      }
    }
  }
  return true;
}

export async function handleArtifactIntent(
  mount: ArtifactMountV1,
  grant: ArtifactGrantV1,
  raw: unknown,
  commandIdFor: (requestId: string) => CommandId,
  commands?: ArtifactCommandAdapterV1,
) {
  const projection = projectArtifactSnapshot(mount, grant);
  if (!projection.ok) return projection;
  const intent = jsonCopy(raw);
  if (!fields(intent, ['version', 'requestId', 'mountId', 'baseStateRev', 'action']) ||
    intent.version !== 1 || !token(intent.requestId, 8) || !counter(intent.baseStateRev))
    return reject('invalid-intent');
  if (intent.mountId !== mount.mountId) return reject('mount-forbidden');

  const key: CommandKey = {
    learnerId: mount.learnerId,
    commandId: commandIdFor(intent.requestId),
  };
  const scope = { sessionId: mount.sessionId, turnId: mount.turnId };
  const recorded = await commands?.readInput(key);
  if (recorded && canonicalJsonString(recorded) !== canonicalJsonString({ ...scope, intent }))
    return reject('request-conflict');
  if (intent.baseStateRev !== mount.stateRev) return reject('stale-state');
  if (mount.status !== 'open') return reject('mount-read-only');

  const { view } = projection.snapshot;
  const { action } = intent;
  if (
    !fields(action, ['version', 'artifactId', 'revision', 'nodeId', 'intent', 'trace', 'answers']) ||
    action.version !== 1 || action.artifactId !== view.id || action.revision !== view.revision ||
    typeof action.nodeId !== 'string'
  ) return reject('invalid-action');
  const nodes = new Map(view.sections.flatMap(section => section.nodes.map(node => [node.id, node])));
  const node = nodes.get(action.nodeId);
  if (node?.kind !== 'action' || action.intent !== node.intent || !grant.actions.some(allowed =>
    allowed.nodeId === node.id && allowed.intent === node.intent &&
    allowed.inputs.length === node.inputs.length && node.inputs.every(id => allowed.inputs.includes(id))
  )) return reject('action-forbidden');
  const answers = readAnswers(action.answers, node, nodes);
  if (!answers) return reject('invalid-answers');
  if (!traceMatches(action.trace, answers, nodes)) return reject('invalid-trace');

  const verifiedAction: Readonly<ArtifactAction> = {
    version: 1, artifactId: view.id, revision: view.revision,
    nodeId: node.id, intent: node.intent, answers, trace: action.trace,
  };
  const request: VerifiedRequest = {
    ...key,
    input: {
      ...scope,
      intent: {
        version: 1, requestId: intent.requestId, mountId: mount.mountId, baseStateRev: intent.baseStateRev,
        action: verifiedAction,
      },
    } satisfies CommandInput & JsonObject,
    traceStatus: action.trace.omitted === 0 ? 'reported' : 'truncated',
  };
  if (node.intent === 'explore' || node.intent === 'saveDraft')
    return { ok: true as const, kind: 'verified' as const, request };
  const execute = commands?.execute?.[node.intent];
  if (!execute) return reject('command-required');
  const receipt = await execute(request);
  if (receipt.commandId !== key.commandId || receipt.state !== 'done') return reject('command-incomplete');
  return { ok: true as const, kind: 'command-done' as const, commandId: key.commandId };
}

// Exploration also records a structured handoff, using its original slot contract.
export function projectArtifactSubmission(mountId: string, view: Artifact, id: string, action: ArtifactAction, release?: AssessmentRelease) {
  if (release) {
    const item = release.items[0]!;
    const slot = item.slots[0]!;
    const answer = action.answers[slot.slotId];
    return assessmentSubmission({
      releaseRef: release.releaseRef, submissionRef: { id, rev: 1 },
      answers: answer?.kind === 'selection' && answer.ids.length ? [{
        itemId: item.itemId, slotId: slot.slotId, schemaVersion: slot.schemaVersion, path: '',
        value: { kind: 'structured', value: answer },
      }] : [],
    }, release);
  }
  const releaseRef = { id: factId(mountId), rev: 1 as Revision };
  const schemaVersion = 'artifact-v1';
  const itemId = action.nodeId;
  const declared = view.sections.flatMap((section) => section.nodes).find((n) => n.id === itemId);
  if (declared?.kind !== 'action' || declared.intent !== 'submit') return;
  const slots = declared.inputs.map((slotId) => ({
    slotId,
    schemaVersion,
    fields: [{ path: '', kind: 'structured' as const }],
  }));
  return assessmentSubmission(
    {
      releaseRef,
      submissionRef: { id, rev: 1 },
      answers: slots.map(({ slotId }) => ({
        itemId,
        slotId,
        path: '',
        schemaVersion,
        value: { kind: 'structured', value: action.answers[slotId] },
      })),
    },
    { releaseRef, items: [{ itemId, slots }] },
  );
}
