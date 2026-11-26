import { unresolved, type PartialMountPermissions } from './mount-coverage.ts';
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
import {
  extractCalcBindingsFromUnknown,
  type CalcArtifactBinding,
  type CalcBindingsFreezeVerification,
} from './CalcBindingBadge.tsx';

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
  calcBindings?: readonly CalcArtifactBinding[];
  calcVerification?: CalcBindingsFreezeVerification;
}

export type { ArtifactIntentV1 };

export interface MountedSession extends Session {
  mounts: ArtifactSnapshotV1[];
  withdrawn: ReadonlySet<string>;
  uncertain: ReadonlySet<string>;
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
  const calcData = extractCalcBindingsFromUnknown(input) ?? extractCalcBindingsFromUnknown(input.view);
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
    ...(calcData && calcData.bindings.length > 0 ? { calcBindings: calcData.bindings } : {}),
    ...(calcData?.verification ? { calcVerification: calcData.verification } : {}),
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
export function authorizeMounts(session: MountedSession, turnId: string, ids: ReadonlyMap<string, number>, frame: PartialMountPermissions, covered: ReadonlySet<string>) {
  const withdrawn = new Set(session.withdrawn);
  const uncertain = new Set(session.uncertain);
  const history = session.mounts.filter(m => m.turnId !== turnId);
  const current = session.mounts.filter(m => {
    if (m.turnId !== turnId) return false;
    if (ids.has(m.mountId)) return true;
    if (unresolved(frame, m.mountId, covered)) { uncertain.add(m.mountId); return true; }
    withdrawn.add(m.mountId);
    uncertain.delete(m.mountId);
    return false;
  });
  current.sort((a, b) => (ids.get(a.mountId) ?? Infinity) - (ids.get(b.mountId) ?? Infinity));
  return { ...session, mounts: [...history, ...current], withdrawn, uncertain };
}

// Only a session read (or its session header on the stream) grants a turn.
// A snapshot cannot use its own turnId to authorize itself.
export function streamSnapshot(previous: MountedSession | undefined, input: unknown, order?: ReadonlyMap<string, number>) {
  if (!previous || previous.status !== 'pending' || !previous.currentTurnId) return previous;
  const next = decode(input, previous.id, previous.currentTurnId);
  if (!next || previous.uncertain.has(next.mountId) || (order && !order.has(next.mountId))) return previous;
  const mounts = accept(previous.mounts, previous.withdrawn, next);
  return mounts === previous.mounts ? previous : { ...previous, mounts };
}

export function readSession(
  current: Session,
  previous?: MountedSession,
  atRequest?: MountedSession,
  covered: ReadonlySet<string> = new Set(),
): MountedSession {
  const same = previous?.id === current.id ? previous : undefined;
  const authorized = new Set(current.turns.map((t) => t.turnId));
  if (current.currentTurnId && current.status === 'pending') authorized.add(current.currentTurnId);
  let mounts = (same?.mounts ?? []).filter((m) => authorized.has(m.turnId));
  const withdrawn = new Set(same?.withdrawn);
  const uncertain = new Set(same?.uncertain);
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
        (atRequest !== undefined && (!atRequest.mounts.includes(m) ||
          (uncertain.has(m.mountId) && !atRequest.uncertain.has(m.mountId))))
      )
        return true;
      if (unresolved(current, m.mountId, covered)) { uncertain.add(m.mountId); return true; }
      uncertain.delete(m.mountId);
      withdrawn.add(m.mountId);
      return false;
    });
    for (const snapshot of incoming) if (!uncertain.has(snapshot.mountId)) mounts = accept(mounts, withdrawn, snapshot, true);
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
  return { ...current, mounts, withdrawn, uncertain };
}

// A reconnect read may race with a turn change, a receipt or a withdrawal.
// Refresh only the draft bases that are still current when this read returns.
export function refreshDraftBases(latest: MountedSession, prior: MountedSession, ids: string[], read: MountedSession, confirmed: ReadonlySet<string>) {
  let mounts = latest.mounts;
  const withdrawn = new Set(latest.withdrawn);
  const uncertain = new Set(latest.uncertain);
  const covered = new Set(ids);
  for (const id of ids) {
    const base = prior.mounts.find(m => m.mountId === id);
    if (withdrawn.has(id) || latest.mounts.find(m => m.mountId === id) !== base) continue;
    if (prior.uncertain.has(id) !== latest.uncertain.has(id)) continue;
    const current = read.mounts.find(m => m.mountId === id);
    if (!current && unresolved(read, id, covered)) { uncertain.add(id); continue; }
    if (!current) {
      withdrawn.add(id);
      uncertain.delete(id);
      mounts = mounts.filter(m => m !== base);
      continue;
    }
    if (!confirmed.has(id)) continue;
    if (base && (current.turnId !== base.turnId || current.stateRev < base.stateRev || current.viewSeq < base.viewSeq))
      throw new Error('Stale artifact checkpoint');
    uncertain.delete(id);
    if (!base) mounts = accept(mounts, withdrawn, current);
    else if (current.stateRev !== base.stateRev || current.viewSeq !== base.viewSeq ||
        current.view.id !== base.view.id || current.view.revision !== base.view.revision ||
        current.predicting !== base.predicting || current.submitted !== base.submitted)
      mounts = mounts.map(m => m === base ? current : m);
  }
  return { ...latest, mounts, withdrawn, uncertain };
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
    previous.id !== sent.sessionId || previous.uncertain.has(sent.mountId) ||
    !previous.mounts.some((m) => m.turnId === sent.turnId && m.mountId === sent.mountId) ||
    !isRecord(input) ||
    input.mountId !== sent.mountId
  )
    return previous;
  const next = decode(input, sent.sessionId, sent.turnId);
  return next ? { ...previous, mounts: accept(previous.mounts, previous.withdrawn, next) } : previous;
}
