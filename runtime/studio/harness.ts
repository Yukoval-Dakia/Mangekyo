import {loadWorkspaceAccessRoutes, workspaceGrantRevision} from './workspace-access.ts';
import { sameRoute } from '../../executors/teaching/provider-consent.ts';
export { sameRoute, sameActiveProvider, resolveMcpGrants, mcpRevision, routeMatchesInput } from '../../executors/teaching/provider-consent.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { nextTurn, slotType, stableId } from './identity.ts';
import { turnTask } from './model-routes.ts';
import { teachingOrigin } from './reading.ts';
import type { studyTurn } from '../../modules/activity/values.ts';
import { loadSettings } from './settings.ts';

type Settings = Awaited<ReturnType<typeof loadSettings>>;
type StoredTurn = ReturnType<typeof studyTurn>;

type WorkspaceRoutes = Awaited<ReturnType<typeof loadWorkspaceAccessRoutes>>;

export async function workspaceRouteRevision(settings: Settings) {
  const provider = settings.providers.find(profile => profile.id === settings.activeProviderId);
  return provider && workspaceGrantRevision(await loadWorkspaceAccessRoutes(), provider);
}

export const requiresAccountConfirmation = (turn: StoredTurn) => Boolean(turn.attachment || turn.jitContextVersion || turn.accountRevision);

// Before the explicit marker, this keyed lane required the caller's matching account for attachments.
async function completedAttachmentAccount(tx: ReadTransaction, turn: StoredTurn) {
  if (turn.caseId !== 'companion' || !turn.accountRevision) return false;
  const origin = await teachingOrigin(tx,turn);
  if (!origin.attachment || !origin.attachmentBasis || origin.accountRevision !== turn.accountRevision) return false;
  const id = turn.parentId ? nextTurn(turn.sessionId,turn.parentId) : turn.sessionId;
  const {rows:[row]} = await tx.query<{work: string; generation: string; result: string}>(`
    SELECT w.id AS work,w.generation::text,d.id AS result FROM fact_revs r
    JOIN commands c ON (c.learner_id,c.id,c.tick)=(r.learner_id,r.command_id,r.tick)
    JOIN work w ON (w.learner_id,w.slot_key)=(r.learner_id,r.fact_id)
    JOIN work_outbox o ON (o.learner_id,o.work_id,o.generation,o.intent_id)=(w.learner_id,w.id,w.generation,w.execution_ref)
    JOIN slot_state s ON (s.learner_id,s.slot_type,s.slot_key)=(w.learner_id,w.slot_type,w.slot_key)
    JOIN derivations d ON (d.learner_id,d.id,d.slot_type,d.slot_key,d.deriver)=(s.learner_id,s.current_id,w.slot_type,w.slot_key,w.deriver)
    WHERE r.learner_id=$1 AND r.fact_id=$2 AND r.rev=1 AND r.kind='value' AND r.author='learner' AND r.data=$4::jsonb
      AND c.type='activity.submitTurn' AND c.state='done' AND c.input->>'actor'='learner' AND c.input->>'purpose'='teaching'
      AND c.input#>>'{input,id}'=r.fact_id AND c.input#>'{input,data}'=r.data
      AND c.receipt->'wrote' @> jsonb_build_array(jsonb_build_object('id',r.fact_id,'rev',1,'learner',r.learner_id))
      AND w.slot_type=$3 AND w.deriver='activity/evidence-tutor-jit-v1' AND w.state='satisfied' AND o.state='routed_delivered'
      AND d.lifecycle='effective' AND d.freshness='current' AND d.value->>'action'='companion_reply'
      AND EXISTS (SELECT 1 FROM effects e WHERE e.learner_id=w.learner_id AND e.owner_kind='session'
        AND e.owner_id=w.slot_key AND e.label='teaching-model' AND e.state='done' AND e.provider_effect_id IS NOT NULL
        AND e.started_tick>=r.tick AND e.ended_tick<=d.effective_tick)`, [tx.learner,id,slotType,JSON.stringify(turn)]);
  return Boolean(row && row.result === stableId('feedback',tx.learner,row.work,row.generation) &&
    sameRoute(turn,await loadSettings(turnTask(turn.caseId,origin.attachment.mode === 'prepare'))));
}

export function workspaceGrantChecker(historyRead?: ReadTransaction) {
  let current: Promise<[Settings, WorkspaceRoutes]> | undefined;
  return async (turn: StoredTurn) => {
    if (requiresAccountConfirmation(turn) && !turn.accountConfirmation &&
        (!historyRead || !await completedAttachmentAccount(historyRead,turn))) return false;
    if (!turn.workspaceRevision && !turn.accountRevision) return true;
    const [settings, routes] = await (current ??= Promise.all([loadSettings(), loadWorkspaceAccessRoutes()]));
    const provider = settings.providers.find(profile => profile.id === (turn.providerId ?? 'default'));
    if (!provider || provider.baseUrl !== turn.baseUrl || provider.protocol !== (turn.protocol ?? 'openai')) return false;
    if (turn.accountRevision && provider.credentialRevision !== turn.accountRevision) return false;
    return !turn.workspaceRevision || workspaceGrantRevision(routes, provider) === turn.workspaceRevision;
  };
}
