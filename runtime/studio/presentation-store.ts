import {learningToolError} from '../../executors/teaching/tool-error.ts';
import { fileURLToPath } from 'node:url';
import { canonicalJsonString } from '../../kernel/src/commands/canonical.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactReadDeniedError,
  FactNotFoundError,
} from '../../kernel/src/commands/reads.ts';
import { factId, commandId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { CommandReceipt } from '../../kernel/src/declarations/types.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';

import { type Manifest } from '../../kernel/src/derivations/manifest.ts';
import { notionReadScope, teachingResultAllowed, type CheckNotionRead } from './notion.ts';
import { loadModuleDirectory } from '../../kernel/src/loader.ts';
import { assessmentRelease, assessmentSubmission, type AssessmentRelease } from '../../modules/activity/assessment-values.ts';
import { artifactMount } from '../../modules/content/artifact.ts';
import { studyTurn } from '../../modules/activity/values.ts';
import {
  validateArtifact,
  operationLocks,
  type Artifact,
  type ArtifactAction,
  type ArtifactIntentV1,
  type HostStateV1,
} from '../../surfaces/shared/presentation/index.ts';
import {
  artifactIntentCommandId,
  artifactViewDigest,
  handleArtifactIntent,
  projectArtifactSnapshot,
  type ArtifactMountV1,
} from './artifact-presentation.ts';
import {
  artifactAssessmentPolicy, qualifyArtifactAssessment, readArtifactAssessment, type ReadArtifactAssessmentWitness,
} from './artifact-assessment.ts';
import { registerFormalAssessment } from './formal-assessment.ts';
import { workspaceGrantChecker } from './harness.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner, purpose, slotType } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { notifySession } from './stream.ts';

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
  const checked = validateArtifact(args.view);
  if (!checked.ok) return learningToolError('invalid_args','view',checked.error);
  const prompt = args.predictionPrompt ?? null;
  if (prompt !== null && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 160))
    return learningToolError('invalid_args','predictionPrompt','预测提示应为 1–160 字。');
  const id = stableId('artifact-mount', turnId, String(step));
  const view = { ...checked.view, id: 'work-' + id.toLowerCase() };
  let assessment: ReturnType<typeof qualifyArtifactAssessment> | undefined;
  if (args.sentenceBreaks !== undefined) {
    if (!prompt) return learningToolError('invalid_args','predictionPrompt','正式断句须先保存预测。');
    try {
      assessment = qualifyArtifactAssessment({ id: factId(id), rev: 1 as Revision }, view, prompt, args.sentenceBreaks, readWitness);
    } catch (error) {
      return learningToolError('invalid_args','sentenceBreaks',error instanceof Error ? error.message : '正式断句无法发放。');
    }
  }
  const data = await db.snapshot(scope, async (tx) => {
    const manifest = await authorize(tx);
    const reader = createCommandReadContext(tx, purpose);
    const turn = studyTurn((await reader.fact(factId(turnId), { mode: 'following' })).value);
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
    input: { id, data },
  });
  return { mountId: id, revision: view.revision, commandId: receipt.commandId, state: receipt.state };
}

type ActionRecord = { stateRev: number; requestId: string; action: ArtifactAction; prediction: boolean };
class MountUnavailable extends Error {}

function unavailableMount(error: unknown) {
  return error instanceof MountUnavailable || error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
}

async function readMount(tx: ReadTransaction, sessionId: string, mountId: string, check: CheckNotionRead) {
  try {
    return await projectMount(tx, sessionId, mountId, workspaceGrantChecker(), check);
  } catch (error) {
    if (unavailableMount(error)) throw conflict(error instanceof MountUnavailable ? error.message : '作品或依据已不可读。');
    throw error;
  }
}

async function projectMount(
  tx: ReadTransaction, sessionId: string, mountId: string, grantCurrent: ReturnType<typeof workspaceGrantChecker>, check: CheckNotionRead,
) {
  const reader = createCommandReadContext(tx, purpose);
  const source = await reader.fact(factId(mountId), { mode: 'following' });
  if (source.type !== 'content.mountedArtifact' || source.ref.rev !== 1) throw new MountUnavailable('作品不可用。');
  const data = artifactMount(source.value);
  if (data.sessionId !== sessionId) throw new MountUnavailable('作品不属于本次对话。');
  const turn = await reader.fact(data.turnId, { mode: 'following' });
  const submission = studyTurn(turn.value);
  if (
    submission.sessionId !== sessionId || !await teachingResultAllowed(tx, submission, data.manifest, grantCurrent, check)
  )
    throw new MountUnavailable('作品的依据已变更。');
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
  const events = await tx.query<{ id: string; receipt: CommandReceipt | null }>(
    `SELECT f.id,c.receipt FROM facts f JOIN fact_revs r ON
    r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev LEFT JOIN commands c ON c.learner_id=r.learner_id AND c.id=r.command_id
    WHERE f.learner_id=$1 AND f.type='activity.artifactAction' AND r.data->>'mountId'=$2 ORDER BY f.created_tick`,
    [tx.learner, mountId],
  );
  const history = [];
  for (const { id, receipt } of events.rows) {
    const fact = await reader.fact<ActionRecord>(factId(id), { mode: 'following' });
    if (fact.ref.rev !== 1) throw new MountUnavailable('操作记录的版本已变化。');
    history.push({ ...fact.value, id, receipt });
  }
  const prediction = history.find((e) => e.prediction);
  const predicting = Boolean(data.predictionPrompt && !prediction);
  const full = result.view;
  const view: Artifact = predicting
    ? {
        version: 1,
        id: full.id,
        revision: full.revision,
        title: '先写下你的预测',
        fallback: data.predictionPrompt!,
        sections: [
          {
            id: 'prediction',
            title: '观察之前',
            layout: 'stack',
            nodes: [
              { kind: 'note', id: 'estimate', label: data.predictionPrompt! },
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
  const stateRev = history.length;
  const base = {
    learnerId: tx.learner,
    sessionId,
    turnId: data.turnId,
    mountId,
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
          mountId,
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
  const release = data.assessment ? assessmentRelease(data.assessment.release) : undefined;
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
  if (!projected.ok) throw new MountUnavailable(projected.code);
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
  const latest = history.at(-1);
  const snapshot = {
    ...projected.snapshot,
    hostState,
    submitted,
    predicting,
    unavailable,
    prediction: prediction ? { id: prediction.id, ...(release ? { rev: 1 } : {}), answer: prediction.action.answers.estimate } : null,
    ...(release ? { questionRef: release.releaseRef } : {}),
    ...(release && submissionEvent ? {
      assessment: await readArtifactAssessment(tx, release.releaseRef, { id: factId(submissionEvent.id), rev: 1 as Revision }),
    } : {}),
    saved,
    commandId: latest?.receipt?.commandId ?? null,
  };
  return { mount, grant, history, snapshot, release, source };
}

export async function turnArtifacts(tx: ReadTransaction, session: string, turn: string, check: CheckNotionRead) {
  const rows = await tx.query<{ id: string }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON r.learner_id=f.learner_id
    AND r.fact_id=f.id AND r.rev=f.current_rev WHERE f.learner_id=$1 AND f.type='content.mountedArtifact'
    AND r.data->>'sessionId'=$2 AND r.data->>'turnId'=$3 ORDER BY f.created_tick`,
    [tx.learner, session, turn],
  );
  const grantCurrent = workspaceGrantChecker();
  const snapshots = [];
  for (const { id } of rows.rows) {
    try {
      snapshots.push((await projectMount(tx, session, id, grantCurrent, check)).snapshot);
    } catch (error) {
      if (!unavailableMount(error)) throw error;
    }
  }
  return snapshots;
}

// Exploration also records a structured handoff, using its original slot contract.
function submissionFor(mount: ArtifactMountV1, view: Artifact, id: string, action: ArtifactAction, release?: AssessmentRelease) {
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
  const releaseRef = { id: factId(mount.mountId), rev: 1 as Revision };
  const schemaVersion = 'artifact-v1';
  const itemId = action.nodeId;
  const declared = view.sections.flatMap((section) => section.nodes).find((n) => n.id === itemId);
  if (declared?.kind !== 'action' || declared.intent !== 'submit') throw conflict('提交动作未声明。');
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

export async function actOnArtifact(db: Db, session: string, raw: Record<string, unknown>) {
  const requestId = clientRequest(raw.requestId);
  if (typeof raw.mountId !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw.mountId))
    throw new RequestError(400, '作品标识无效。');
  const mountId = raw.mountId;
  const notion = notionReadScope(db, studioLearner);
  const read = () => notion.read((tx, check) => readMount(tx, session, mountId, check));
  const { mount, grant, history, snapshot, release } = await read();
  const key = artifactIntentCommandId(requestId);
  function confirmed(state: typeof snapshot, receipt: CommandReceipt | null | undefined) {
    if (receipt?.state !== 'done' || receipt.commandId !== key) throw conflict('操作回执尚未确认。');
    return { receipt: { ...receipt, requestId, mountId, status: 'accepted' }, snapshot: state };
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
    const estimate = action.answers.estimate;
    if (snapshot.predicting && (estimate?.kind !== 'text' || !estimate.text.trim()))
      throw conflict('请先写下预测。');
    if (action.intent === 'submit' && action.trace.omitted) throw conflict('操作轨迹不完整。');
    const stateRev = mount.stateRev + 1;
    const id = stableId('artifact-action', mountId, String(stateRev));
    const data = {
      stateRev,
      mountId,
      sessionId: session,
      turnId: mount.turnId,
      requestId,
      action: { ...action },
      prediction: snapshot.predicting,
      predictionRef: snapshot.prediction?.id ?? null,
      ...(action.intent === 'submit'
        ? { submission: submissionFor(mount, snapshot.view, id, action, release), traceSource: 'learner-reported' }
        : {}),
    };
    const handle = createCommandHandler(db, {
      modules: [await (activity ??= load('activity'))],
      hooks: createStudioCommandHooks({
        afterFactsChanged: async (tx, tick) => {
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
        input: { id, data },
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
