import {
  validateArtifact,
  type Artifact,
  type Answer,
  type Interaction,
  type ArtifactIntentV1,
  type HostStateV1,
  type ArtifactAction,
} from '../../../shared/presentation/index.ts';
import { isRecord } from '../../../shared/presentation/schema.ts';
import { api, sessionPath, type Session } from '../api.ts';
import { decodeAssessment, sameAssessment, type ArtifactAssessment } from './artifact-assessment.ts';

export interface ArtifactSnapshotV1 {
  version: 1;
  sessionId: string;
  turnId: string;
  mountId: string;
  viewSeq: number;
  stateRev: number;
  view: Artifact;
  hostState?: HostStateV1 | undefined;
  unavailable: Record<string, string>;
  saved: Pick<ArtifactAction, 'answers' | 'trace'>[];
  commandId: string | null;
  submitted: boolean;
  assessment?: ArtifactAssessment;
  predicting: boolean;
  prediction: { id: string; answer: { kind: 'text'; text: string } } | null;
}

export type { ArtifactIntentV1 };

export interface MountedSession extends Session {
  mounts: ArtifactSnapshotV1[];
  withdrawn: ReadonlySet<string>;
}

const counter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function decode(input: unknown, sessionId: string, turnId: string): ArtifactSnapshotV1 | undefined {
  if (
    !isRecord(input) ||
    input.version !== 1 ||
    input.sessionId !== sessionId ||
    input.turnId !== turnId ||
    typeof input.mountId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.mountId) ||
    !counter(input.viewSeq) ||
    !counter(input.stateRev)
  )
    return;
  const result = validateArtifact(input.view);
  if (!result.ok) return;
  const { saved, prediction, commandId, submitted, predicting, unavailable, hostState } = input;
  if (
    typeof submitted !== 'boolean' ||
    typeof predicting !== 'boolean' ||
    (commandId !== null && typeof commandId !== 'string') ||
    !Array.isArray(saved) ||
    saved.length > 128 ||
    !isRecord(unavailable) ||
    !Object.values(unavailable).every((reason) => typeof reason === 'string')
  )
    return;
  if (
    prediction !== null &&
    !(
      isRecord(prediction) &&
      typeof prediction.id === 'string' &&
      isRecord(prediction.answer) &&
      prediction.answer.kind === 'text' &&
      typeof prediction.answer.text === 'string'
    )
  )
    return;
  if (
    hostState !== undefined &&
    (!isRecord(hostState) ||
      hostState.version !== 1 ||
      !isRecord(hostState.inputs) ||
      !isRecord(hostState.logic))
  )
    return;
  for (const edit of saved) {
    if (
      !isRecord(edit) ||
      !isRecord(edit.answers) ||
      !Object.values(edit.answers).every(answer) ||
      !isRecord(edit.trace) ||
      !counter(edit.trace.omitted) ||
      !Array.isArray(edit.trace.steps) ||
      edit.trace.steps.length > 128 ||
      !edit.trace.steps.every(step)
    )
      return;
  }
  const assessment = submitted ? decodeAssessment(input.assessment) : undefined;
  return {
    version: 1,
    sessionId,
    turnId,
    mountId: input.mountId,
    stateRev: input.stateRev,
    viewSeq: input.viewSeq,
    view: result.view,
    submitted,
    predicting,
    ...(assessment && { assessment }),
    commandId,
    saved,
    prediction: prediction as ArtifactSnapshotV1['prediction'],
    hostState: hostState as HostStateV1 | undefined,
    unavailable: unavailable as Record<string, string>,
  };
}

function answer(value: unknown): value is Answer {
  return (
    isRecord(value) &&
    ((value.kind === 'text' && typeof value.text === 'string') ||
      (value.kind === 'quantity' && typeof value.value === 'number' && typeof value.unit === 'string') ||
      (value.kind === 'selection' &&
        Array.isArray(value.ids) &&
        value.ids.every((id) => typeof id === 'string')))
  );
}

function step(value: unknown): value is Interaction {
  return (
    isRecord(value) &&
    typeof value.nodeId === 'string' &&
    ((value.kind === 'adjust' &&
      typeof value.value === 'number' &&
      typeof value.unit === 'string' &&
      (value.objectId === undefined || typeof value.objectId === 'string')) ||
      (value.kind === 'toggle' && typeof value.objectId === 'string' && typeof value.selected === 'boolean'))
  );
}

function accept(mounts: ArtifactSnapshotV1[], withdrawn: ReadonlySet<string>, snapshot: ArtifactSnapshotV1, fromRead = false) {
  const old = mounts.find((m) => m.mountId === snapshot.mountId);
  if (withdrawn.has(snapshot.mountId)) return mounts;
  if (!old) return [...mounts, snapshot];
  if (old.turnId !== snapshot.turnId || snapshot.viewSeq < old.viewSeq || snapshot.stateRev < old.stateRev) return mounts;
  if (snapshot.viewSeq === old.viewSeq) {
    // Settlement changes the authorized assessment without advancing the artifact action clock.
    const next = snapshot.assessment;
    if (snapshot.stateRev !== old.stateRev || !old.assessment || !next || !sameAssessment(old.assessment, next) ||
        next.state === 'queued' || (!fromRead && old.assessment.state !== 'queued')) return mounts;
    snapshot = { ...old, assessment: next };
  } else if (old.assessment && snapshot.assessment && sameAssessment(old.assessment, snapshot.assessment) &&
      old.assessment.state !== 'queued' && snapshot.assessment.state === 'queued') {
    snapshot = { ...snapshot, assessment: old.assessment };
  }
  return mounts.map(m => m === old ? snapshot : m);
}

// A progress header and its authorized snapshots come from one host read.
export function authorizeMounts(session: MountedSession, turnId: string, ids: ReadonlyMap<string, number>) {
  const withdrawn = new Set(session.withdrawn);
  const history = session.mounts.filter(m => m.turnId !== turnId);
  const current = session.mounts.filter(m => {
    if (m.turnId !== turnId) return false;
    if (ids.has(m.mountId)) return true;
    withdrawn.add(m.mountId);
    return false;
  });
  current.sort((a, b) => ids.get(a.mountId)! - ids.get(b.mountId)!);
  return { ...session, mounts: [...history, ...current], withdrawn };
}

// Only a session read (or its session header on the stream) grants a turn.
// A snapshot cannot use its own turnId to authorize itself.
export function streamSnapshot(previous: MountedSession | undefined, input: unknown, order?: ReadonlyMap<string, number>) {
  if (!previous || previous.status !== 'pending' || !previous.currentTurnId) return previous;
  const next = decode(input, previous.id, previous.currentTurnId);
  if (!next || (order && !order.has(next.mountId))) return previous;
  const mounts = accept(previous.mounts, previous.withdrawn, next);
  return mounts === previous.mounts ? previous : { ...previous, mounts };
}

export function readSession(
  current: Session,
  previous?: MountedSession,
  atRequest?: MountedSession,
): MountedSession {
  const same = previous?.id === current.id ? previous : undefined;
  const authorized = new Set(current.turns.map((t) => t.turnId));
  if (current.currentTurnId && current.status === 'pending') authorized.add(current.currentTurnId);
  let mounts = (same?.mounts ?? []).filter((m) => authorized.has(m.turnId));
  const withdrawn = new Set(same?.withdrawn);
  function read(turnId: string, list: unknown) {
    if (!Array.isArray(list)) return;
    const incoming: ArtifactSnapshotV1[] = [];
    for (const input of list) {
      const snapshot = decode(input, current.id, turnId);
      if (snapshot) incoming.push(snapshot);
    }
    // An explicit list is the authorization set. A delayed read cannot
    // withdraw a mount first delivered or advanced after that read started.
    mounts = mounts.filter((m) => {
      if (
        m.turnId !== turnId ||
        incoming.some((s) => s.mountId === m.mountId) ||
        (atRequest !== undefined && !atRequest.mounts.includes(m))
      )
        return true;
      withdrawn.add(m.mountId);
      return false;
    });
    for (const snapshot of incoming) mounts = accept(mounts, withdrawn, snapshot, true);
    // A terminal read can be the first delivery of an earlier mounted stroke.
    const order = new Map(incoming.map((s, i) => [s.mountId, i]));
    const turnMounts = mounts.filter(m => m.turnId === turnId);
    turnMounts.sort((a, b) => (order.get(a.mountId) ?? Infinity) - (order.get(b.mountId) ?? Infinity));
    mounts = [...mounts.filter(m => m.turnId !== turnId), ...turnMounts];
  }
  for (const turn of current.turns) {
    if (turn.turnId) read(turn.turnId, turn.artifacts);
  }
  if (current.status === 'pending' && current.currentTurnId) read(current.currentTurnId, current.artifacts);
  return { ...current, mounts, withdrawn };
}

// A reconnect read may race with a turn change, a receipt or a withdrawal.
// Refresh only the draft bases that are still current when this read returns.
export function refreshDraftBases(latest: MountedSession, bases: ArtifactSnapshotV1[], read: MountedSession) {
  let mounts = latest.mounts;
  const withdrawn = new Set(latest.withdrawn);
  for (const base of bases) {
    if (base.sessionId !== read.id || !mounts.includes(base)) continue;
    const current = read.mounts.find(m => m.turnId === base.turnId && m.mountId === base.mountId);
    if (!current) {
      withdrawn.add(base.mountId);
      mounts = mounts.filter(m => m !== base);
      continue;
    }
    if (current.stateRev < base.stateRev || current.viewSeq < base.viewSeq)
      throw new Error('Stale artifact checkpoint');
    if (current.stateRev !== base.stateRev || current.viewSeq !== base.viewSeq ||
        current.view.id !== base.view.id || current.view.revision !== base.view.revision ||
        current.predicting !== base.predicting || current.submitted !== base.submitted)
      mounts = mounts.map(m => m === base ? current : m);
  }
  return { ...latest, mounts, withdrawn };
}

export async function sendIntent(snapshot: ArtifactSnapshotV1, intent: ArtifactIntentV1) {
  const result = await api<unknown>(sessionPath(snapshot.sessionId) + '/artifact-actions', {
    method: 'POST',
    body: intent,
  });
  const receipt = isRecord(result) ? result.receipt : null;
  if (
    !isRecord(result) ||
    !isRecord(receipt) ||
    receipt.requestId !== intent.requestId ||
    receipt.mountId !== intent.mountId ||
    receipt.state !== 'done' ||
    !Array.isArray(receipt.wrote) ||
    !receipt.wrote.length ||
    typeof receipt.commandId !== 'string' ||
    receipt.status !== 'accepted'
  )
    throw new Error('missing receipt');
  return { snapshot: result.snapshot };
}

export function receiptSnapshot(
  previous: MountedSession | undefined,
  sent: ArtifactSnapshotV1,
  input: unknown,
) {
  if (
    !previous ||
    previous.id !== sent.sessionId ||
    !previous.mounts.some((m) => m.turnId === sent.turnId && m.mountId === sent.mountId) ||
    !isRecord(input) ||
    input.mountId !== sent.mountId
  )
    return previous;
  const next = decode(input, sent.sessionId, sent.turnId);
  return next ? { ...previous, mounts: accept(previous.mounts, previous.withdrawn, next) } : previous;
}
