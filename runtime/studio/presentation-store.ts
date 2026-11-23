import type { ClassroomEvidence } from '../../modules/activity/classroom.ts';
import { assertClassroomAction } from './classroom.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { fileURLToPath } from 'node:url';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, isFactUnavailable } from './fact-read-helpers.ts';
import { factId, commandId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';

import { type Manifest } from '../../kernel/src/derivations/manifest.ts';
import { NotionReadUnconfirmed, notionReadScope, teachingResultAuthority, type CheckNotionRead } from './notion.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { assessmentRelease } from '../../modules/activity/assessment-values.ts';
import { artifactMount } from '../../modules/content/artifact.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import { validateArtifact, savedArtifactCheckpoints, type ArtifactAction, type ArtifactIntentV1, type Artifact } from '../../surfaces/shared/presentation/index.ts';
import { artifactIntentCommandId, handleArtifactIntent, projectArtifactMountState, projectArtifactSubmission } from '../../surfaces/shared/presentation/artifact-intent.ts';
import { artifactAssessmentPolicy, qualifyArtifactAssessment, readArtifactAssessment, type ReadArtifactAssessmentWitness } from './artifact-assessment.ts';
import { registerFormalAssessment } from './formal-assessment.ts';
import { workspaceGrantChecker } from './harness.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner, purpose, slotType } from './identity.ts';
import { clientRequest, readTeachingTurn, RequestError } from './sessions.ts';
import { notifySession } from './stream.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
export { mountPermissionFields } from '../../modules/activity/artifact-action.ts';
import {
  buildArtifactActionData,
  checkArtifactActionSubmit,
  checkMountArgs,
  isUlid,
  buildMountViewData,
  buildMountArtifactInput,
  buildMountProjectionResult,
  buildConfirmedActionResult,
  buildSessionMountEvidenceItem,
  checkArtifactActionReceipt,
  buildArtifactActionRequest,
  buildMountArtifactRequest,
} from '../../modules/companion/facts/session-stream-slice.ts';

const load = (name: string) =>
  loadModuleDirectory(fileURLToPath(new URL('../../modules/' + name, import.meta.url)));
let content: ReturnType<typeof load>, activity: ReturnType<typeof load>;
const scope = { learner: studioLearner };
const conflict = (message: string) => new RequestError(409, message);

export async function mountArtifact(
  db: Db,
  turnId: string,
  step: number,
  args: Record<string, unknown>,
  authorize: (tx: ReadTransaction) => Promise<Manifest>,
  readWitness?: ReadArtifactAssessmentWitness,
) {
  const viewCheck = validateArtifact(args.view);
  const id = stableId('artifact-mount', turnId, String(step));
  const viewCheckView = viewCheck.ok ? viewCheck.view : undefined;
  const argCheck = buildMountArtifactRequest({ viewOk: viewCheck.ok, viewError: viewCheck.ok ? undefined : viewCheck.error,
    predictionPrompt: args.predictionPrompt, hasSentenceBreaks: args.sentenceBreaks !== undefined,
    checkedView: viewCheck.ok ? viewCheck.view : ({} as Artifact), mountId: id, turnId, sessionId: '', manifest: {}, gatherTick: undefined, assessment: undefined });
  if (argCheck.error) return learningToolError('invalid_args', argCheck.error.field, argCheck.error.message);
  const checked = viewCheck;
  const prompt = (args.predictionPrompt ?? null) as string | null;
  const view = argCheck.view!;
  let assessment: ReturnType<typeof qualifyArtifactAssessment> | undefined;
  if (args.sentenceBreaks !== undefined) {
    try {
      assessment = qualifyArtifactAssessment({ id: factId(id), rev: 1 as Revision }, view, prompt!, args.sentenceBreaks, readWitness);
    } catch (error) {
      return learningToolError('invalid_args','sentenceBreaks',error instanceof Error ? error.message : '正式断句无法发放。');
    }
  }
  const data = await db.snapshot(scope, async (tx) => {
    const manifest = await authorize(tx);
    const turn = studyTurn((await readTeachingTurn(tx, turnId)).value);
    // A replay keeps the original gather tick. The command compares all other inputs.
    const existing = await tx.query<{ tick: string }>(
      "SELECT data->'manifest'->>'gatherTick' AS tick FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND rev=1",
      [tx.learner, id],
    );
    return {
      turnId,
      sessionId: turn.sessionId,
      manifest: { ...manifest, gatherTick: existing.rows[0]?.tick ?? manifest.gatherTick },
      view,
      predictionPrompt: prompt,
      ...(assessment ? { assessment } : {}),
    };
  });
  const handle = createCommandHandler(db, {
    modules: [await (content ??= load('content'))],
    hooks: createStudioCommandHooks({
      afterFactsChanged: async (tx) => {
        await authorize(tx);
        await notifySession(tx, data.sessionId);
      },
    }),
  });
  const receipt = await handle({
    ...scope,
    actor: 'companion',
    purpose,
    type: 'content.mountArtifact',
    id: commandId(stableId('mount-command', id)),
    input: buildMountArtifactInput(id, data) as Json,
  });
  return { mountId: id, revision: view.revision, commandId: receipt.commandId, state: receipt.state };
}

type ActionRecord = { stateRev: number; requestId: string; action: ArtifactAction; prediction: boolean };
class MountUnavailable extends Error {}

function unavailableMount(error: unknown) {
  return error instanceof MountUnavailable || isFactUnavailable(error);
}

async function readMount(tx: ReadTransaction, sessionId: string, mountId: string, check: CheckNotionRead, through?: number) {
  try {
    return await projectMount(tx, sessionId, mountId, workspaceGrantChecker(tx), check, through);
  } catch (error) {
    if (error instanceof NotionReadUnconfirmed) throw new RequestError(503, '暂时无法核对作品来源，请重试。');
    if (unavailableMount(error)) throw conflict(error instanceof MountUnavailable ? error.message : '作品或依据已不可读。');
    throw error;
  }
}

async function projectMount(
  tx: ReadTransaction, sessionId: string, mountId: string, grantCurrent: ReturnType<typeof workspaceGrantChecker>, check: CheckNotionRead, through?: number,
) {
  const reader = createCommandReadContext(tx, purpose);
  const source = await reader.fact(factId(mountId), { mode: 'following' });
  if (source.type !== 'content.mountedArtifact' || source.ref.rev !== 1) throw new MountUnavailable('作品不可用。');
  const data = artifactMount(source.value);
  if (data.sessionId !== sessionId) throw new MountUnavailable('作品不属于本次对话。');
  const turn = await readTeachingTurn(tx, data.turnId);
  const submission = studyTurn(turn.value);
  if (submission.sessionId !== sessionId) throw new MountUnavailable('作品不属于本次对话。');
  const {
    rows: [work],
  } = await tx.query<{ failed: boolean }>(
    `SELECT last_error IS NOT NULL AS failed
    FROM slot_state WHERE learner_id=$1 AND slot_key=$2 AND slot_type=$3`,
    [tx.learner, data.turnId, slotType],
  );
  if (!work || work.failed) throw new MountUnavailable('此回合已停止。');
  const result = validateArtifact(data.view);
  if (!result.ok) throw new MountUnavailable('无法读取这个作品版本。');
  const {state: authority} = await teachingResultAuthority(tx, data.turnId, submission, data.manifest, grantCurrent, check);
  if (authority === 'unconfirmed') throw new NotionReadUnconfirmed();
  if (authority === 'withdrawn') throw new MountUnavailable('作品的依据已变更。');
  const events = await tx.query<{ id: string; receipt: CommandReceipt | null }>(
    `SELECT f.id,c.receipt FROM facts f JOIN fact_revs r ON
    r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev LEFT JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
    WHERE f.learner_id=$1 AND f.type='activity.artifactAction' AND r.data->>'mountId'=$2
      AND ($3::bigint IS NULL OR (r.data->>'stateRev')::bigint<=$3) ORDER BY f.created_tick`,
    [tx.learner, mountId, through ?? null],
  );
  const history = [];
  for (const { id, receipt } of events.rows) {
    const fact = await reader.fact<ActionRecord>(factId(id), { mode: 'following' });
    if (fact.ref.rev !== 1 || (through !== undefined && fact.value.stateRev !== history.length + 1)) throw new MountUnavailable('操作记录的版本已变化。');
    history.push({ ...fact.value, id, receipt, witness:fact });
  }
  const { mount, grant, projected, hostState, submitted, predicting, unavailable, prediction, submissionEvent } =
    projectArtifactMountState(result.view, data.predictionPrompt, history,
      { learnerId: tx.learner, sessionId, turnId: data.turnId, mountId });
  const release = data.assessment ? assessmentRelease(data.assessment.release) : undefined;
  if (!projected.ok) throw new MountUnavailable(projected.code);
  const latest = history.at(-1);
  const assessment = release && submissionEvent
    ? await readArtifactAssessment(tx, release.releaseRef, { id: factId(submissionEvent.id), rev: 1 as Revision }) : undefined;
  return buildMountProjectionResult({
    source, turnIdMatches: true, workFailed: false, viewOk: true, authority: 'authorized',
    history, projected: projected.snapshot, projectedOk: true, hostState, submitted, predicting, unavailable,
    prediction, release, submissionEvent: assessment, saved: savedArtifactCheckpoints(history),
    commandId: latest?.receipt?.commandId ?? null, grant, mount, manifest: data.manifest,
  });
}

export async function turnArtifacts(tx: ReadTransaction, session: string, turn: string, check: CheckNotionRead) {
  const rows = await tx.query<{ id: string }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON r.learner_id=f.learner_id
    AND r.fact_id=f.id AND r.rev=f.current_rev WHERE f.learner_id=$1 AND f.type='content.mountedArtifact'
    AND r.data->>'sessionId'=$2 AND r.data->>'turnId'=$3 ORDER BY f.created_tick`,
    [tx.learner, session, turn],
  );
  const grantCurrent = workspaceGrantChecker(tx);
  const snapshots = [];
  const unconfirmed: string[] = [];
  for (const { id } of rows.rows) {
    try {
      snapshots.push((await projectMount(tx, session, id, grantCurrent, check)).snapshot);
    } catch (error) {
      if (error instanceof NotionReadUnconfirmed) unconfirmed.push(id);
      else if (!unavailableMount(error)) throw error;
    }
  }
  return {snapshots, unconfirmed};
}

export async function classroomMountEvidence(tx: ReadTransaction, session: string, turn: string, check: CheckNotionRead) {
  const {snapshots,unconfirmed} = await turnArtifacts(tx,session,turn,check);
  if (unconfirmed.length) throw new RequestError(503,'暂时无法核对课堂作品依据。');
  return snapshots.filter(item => item.stateRev > 0).map(buildSessionMountEvidenceItem);
}

export async function readClassroomMountEvidence(tx: ReadTransaction, session: string, turn: string,
  evidence: ClassroomEvidence, check: CheckNotionRead) {
  const result = await readMount(tx,session,evidence.mountId,check,evidence.stateRev);
  if (result.mount.turnId !== turn || result.snapshot.stateRev !== evidence.stateRev) return;
  const assessment = result.snapshot.assessment;
  if (evidence.assessmentId && (!assessment || !('derivationId' in assessment) || assessment.derivationId !== evidence.assessmentId)) return;
  return {...result,assessment:evidence.assessmentId === null ? undefined : assessment};
}

export async function actOnArtifact(db: Db, session: string, raw: Record<string, unknown>) {
  const requestId = clientRequest(raw.requestId);
  if (!isUlid(raw.mountId)) throw new RequestError(400, '作品标识无效。');
  const mountId = raw.mountId as string;
  const notion = notionReadScope(db, studioLearner);
  const read = () => notion.read((tx, check) => readMount(tx, session, mountId, check));
  const { mount, grant, history, snapshot, release } = await read();
  const key = artifactIntentCommandId(requestId);
  function confirmed(state: typeof snapshot, receipt: CommandReceipt | null | undefined) {
    const result = buildConfirmedActionResult({ receipt, key, snapshot: state, requestId, mountId });
    if (!result) throw conflict('操作回执尚未确认。');
    return result;
  }
  const existing = history.find((e) => e.requestId === requestId);
  if (existing) {
    if (
      canonicalJsonString(raw) !==
      canonicalJsonString({
        version: 1,
        mountId,
        requestId,
        baseStateRev: existing.stateRev - 1,
        action: existing.action,
      })
    )
      throw conflict('同一操作身份的载荷不一致。');
    return confirmed(snapshot, existing.receipt);
  }
  const execute = async ({ input }: { input: { intent: ArtifactIntentV1 } }) => {
    const { action } = input.intent;
    const stateRev = mount.stateRev + 1;
    const id = stableId('artifact-action', mountId, String(stateRev));
    const request = buildArtifactActionRequest({ mountStateRev: mount.stateRev, snapshot, action, sessionId: session, turnId: mount.turnId,
      mountId, requestId, release, projectSubmission: projectArtifactSubmission, id });
    if (request.error) throw conflict(request.error.message);
    const data = request.data as Json;
    const handle = createCommandHandler(db, {
      modules: [await (activity ??= load('activity'))],
      hooks: createStudioCommandHooks({
        afterFactsChanged: async (tx, tick) => {
          await assertClassroomAction(tx,session,mount.turnId);
          const current = await readMount(tx, session, mountId, notion.check(tx));
          if (current.release && action.intent === 'submit') {
            const submitted = await createCommandReadContext(tx, purpose).fact(factId(id), { mode: 'following' });
            await registerFormalAssessment(tx, tick, artifactAssessmentPolicy, current.source, submitted);
          }
          await notifySession(tx, session);
        },
      }),
    });
    try {
      return await handle({
        ...scope,
        actor: 'learner',
        purpose,
        type: 'activity.recordArtifactAction',
        id: key,
        input: { id, data: data as Json },
      });
    } catch (error) {
      if (error instanceof Error && /Fact already exists|different command identity/.test(error.message))
        throw conflict('操作基版本或身份冲突。');
      throw error;
    }
  };
  const checked = await handleArtifactIntent(mount, grant, raw, {
    readInput: async () => null,
    execute: { submit: execute },
  });
  if (!checked.ok) throw conflict(checked.code);
  if (checked.kind === 'verified') await execute(checked.request);
  const current = await read();
  return confirmed(current.snapshot, current.history.find((e) => e.requestId === requestId)?.receipt);
}
