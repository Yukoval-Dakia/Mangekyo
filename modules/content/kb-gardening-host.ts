import { derivationId, factId, readEffectiveDerivation, stableId, type FactId, type ReadTransaction, type Revision, type SlotRef } from '@mangekyo/kernel';
import type { GardeningGreenAction, GardeningInboxPlan, GardeningYellowProposal, KbGardeningSnapshot } from './kb-gardening.ts';
import { questionStateId } from './question-state.ts';

/**
 * Studio host assembly for the knowledge-gardening inbox: scans the learner's
 * content tables through caller-injected SQL, propagates capture-source
 * revocations transitively through recorded source references, and keeps the
 * resulting snapshot strictly domain-pure.
 */
export type HostSourceUse = { id: string; rev: number; accessEpoch?: string | number };
export type VerifyContentUse = (use: HostSourceUse, type: string) => Promise<boolean>;

export const gardeningOwnerId = stableId('studio-kb-gardening');
export const GARDENING_ACTION_LABEL = 'kb-gardening-action';
export const GARDENING_DECISION_LABEL = 'kb-gardening-decision';
export const GARDENING_GREEN_LABEL = 'kb-gardening-green';
export const GARDENING_UNDO_LABEL = 'kb-gardening-undo';
export const COMPANION_GENERATED_TAG = 'studio:companion-generated';

/** Deep-walk JSON for {id,rev,accessEpoch} or {id,rev,epoch} source-use witnesses. */
export function collectSourceUses(data: unknown, out: HostSourceUse[] = []): HostSourceUse[] {
  if (Array.isArray(data)) {
    for (const item of data) collectSourceUses(item, out);
    return out;
  }
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const epoch = typeof record.accessEpoch === 'string' || typeof record.accessEpoch === 'number'
      ? record.accessEpoch : record.epoch;
    if (typeof record.id === 'string' && typeof record.rev === 'number' &&
        (typeof epoch === 'string' || typeof epoch === 'number')) {
      out.push({ id: record.id, rev: record.rev, accessEpoch: epoch });
    }
    for (const value of Object.values(record)) collectSourceUses(value, out);
  }
  return out;
}

/** Extract referenced fact ids from textbook/question blocks and basis arrays. */
function collectAssetReferencedIds(data: Record<string, unknown>): FactId[] {
  const ids = new Set<FactId>();
  const add = (value: unknown) => { if (typeof value === 'string' && value.length === 26) ids.add(value as FactId); };
  if (Array.isArray(data.basis)) {
    for (const item of data.basis) if (item && typeof item === 'object') add((item as Record<string, unknown>).id);
  }
  if (Array.isArray(data.blocks)) {
    for (const raw of data.blocks) {
      if (!raw || typeof raw !== 'object') continue;
      const body = (raw as Record<string, unknown>).body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') continue;
      const target = body.target as { fact?: { id?: unknown } } | undefined;
      const source = body.source as { fact?: { id?: unknown } } | undefined;
      add(target?.fact?.id);
      add(source?.fact?.id);
      if (Array.isArray(body.allOf)) for (const id of body.allOf) add(id);
    }
  }
  return [...ids];
}

export type HostContentRow = {
  readonly id: FactId;
  readonly type: string;
  readonly rev: Revision;
  readonly accessEpoch: string;
  readonly purpose: readonly string[];
  readonly sticky: boolean;
  readonly retracted: boolean;
  readonly anyLearnerRev: boolean;
  readonly data: Record<string, unknown>;
  readonly revoked: boolean;
};

type ScanRow = Omit<HostContentRow, 'revoked'> & { changedTick: string };

const fallbackUpdatedAt = (nowMs: number, lagTicks: number) =>
  new Date(nowMs - Math.min(Math.max(0, lagTicks), 24 * 3650) * 3_600_000).toISOString();
const asIso = (value: unknown): string | undefined =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && value.includes('T') ? value : undefined;

function extractPaperSourceQuestionIds(data: Record<string, unknown>): FactId[] {
  const paper = (data.paper && typeof data.paper === 'object' ? data.paper : data) as Record<string, unknown>;
  const qs = Array.isArray(paper.questions) ? paper.questions : [];
  const ids: FactId[] = [];
  for (const item of qs) {
    if (!item || typeof item !== 'object') continue;
    const ref = (item as Record<string, unknown>).sourceQuestionRef as { id?: unknown } | undefined;
    if (typeof ref?.id === 'string' && ref.id.length === 26) ids.push(ref.id as FactId);
  }
  return ids;
}

export async function scanKbHostContent(
  tx: ReadTransaction,
  verifyContent: VerifyContentUse,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): Promise<{ snapshot: KbGardeningSnapshot; entries: Map<FactId, HostContentRow>; clock: number }> {
  const [{ rows }, { rows: auxRows }, { rows: [clockRow] }] = await Promise.all([
    tx.query(
      `SELECT f.id, f.type, f.current_rev AS rev, f.access_epoch::text AS "accessEpoch", f.purpose, f.sticky,
         (f.retracted_rev IS NOT NULL OR EXISTS(SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)) AS retracted,
         EXISTS(SELECT 1 FROM fact_revs r WHERE r.learner_id=f.learner_id AND r.fact_id=f.id AND r.author='learner') AS "anyLearnerRev",
         (SELECT data FROM fact_revs r WHERE r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev) AS data,
         f.changed_tick::text AS "changedTick"
       FROM facts f WHERE f.learner_id=$1
         AND f.type IN ('content.asset', 'content.textbookPage', 'content.knowledgeEdge', 'activity.organizerNote')`,
      [tx.learner]),
    tx.query(
      `SELECT f.id, f.type, f.current_rev AS rev, f.access_epoch::text AS "accessEpoch", f.purpose,
         (f.retracted_rev IS NOT NULL OR EXISTS(SELECT 1 FROM tombstones t WHERE t.learner_id=f.learner_id AND t.kind='fact' AND t.id=f.id)) AS retracted,
         (SELECT data FROM fact_revs r WHERE r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev) AS data
       FROM facts f WHERE f.learner_id=$1
         AND f.type IN ('activity.workbookAttempt', 'activity.workbookPaper', 'content.questionState', 'capture.source', 'activity.workspaceEntry')`,
      [tx.learner]),
    tx.query('SELECT clock::text AS clock FROM learners WHERE id=$1', [tx.learner]),
  ]);
  const clock = Number((clockRow as { clock?: string } | undefined)?.clock ?? 0);

  const rawById = new Map<FactId, ScanRow>();
  const normalizedRows: ScanRow[] = (rows as unknown as ScanRow[]).map(raw => ({
    ...raw,
    data: raw.data && typeof raw.data === 'object' ? raw.data : {},
  }));
  for (const raw of normalizedRows) rawById.set(raw.id, raw);

  // Transitive capture-source revocation check: if a page cites a concept backed by a revoked capture source,
  // the page is also excluded rather than leaking downstream derivatives.
  const revokedMemo = new Map<FactId, boolean>();
  const visiting = new Set<FactId>();
  const isRowRevoked = async (raw: ScanRow): Promise<boolean> => {
    const cached = revokedMemo.get(raw.id);
    if (cached !== undefined) return cached;
    if (raw.retracted || !(raw.purpose.includes('storage') || raw.purpose.includes('all'))) {
      revokedMemo.set(raw.id, true);
      return true;
    }
    if (visiting.has(raw.id)) return false;
    visiting.add(raw.id);
    let revoked = false;
    try {
      for (const use of collectSourceUses(raw.data)) {
        if (!(await verifyContent(use, raw.type))) { revoked = true; break; }
        const peer = rawById.get(use.id as FactId);
        if (peer && !peer.retracted && peer.id !== raw.id && await isRowRevoked(peer)) {
          revoked = true;
          break;
        }
      }
    } finally {
      visiting.delete(raw.id);
    }
    revokedMemo.set(raw.id, revoked);
    return revoked;
  };

  const entries = new Map<FactId, HostContentRow>();
  const revokedIds = new Set<FactId>();
  const knownLiveIds = new Set<FactId>();
  const snapshotRows: (ScanRow & { revoked: boolean })[] = [];
  for (const raw of normalizedRows) {
    const revoked = await isRowRevoked(raw);
    entries.set(raw.id, { ...raw, revoked });
    if (revoked) revokedIds.add(raw.id);
    else if (raw.type === 'activity.organizerNote') knownLiveIds.add(raw.id);
    snapshotRows.push({ ...raw, revoked });
  }

  // Process auxiliary facts: workbook attempts/papers (usage & attempts), questionState (stopped), capture sources.
  const attemptCounts = new Map<FactId, number>();
  const externalRefCounts = new Map<FactId, number>();
  const stoppedQuestionIds = new Set<FactId>();
  for (const aux of auxRows as { id: FactId; type: string; rev: number; accessEpoch: string; purpose: string[]; retracted: boolean; data: Record<string, unknown> }[]) {
    if (aux.type === 'capture.source') {
      const ok = !aux.retracted && (aux.purpose.includes('storage') || aux.purpose.includes('all')) &&
        await verifyContent({ id: aux.id, rev: aux.rev, accessEpoch: aux.accessEpoch }, aux.type);
      if (ok) knownLiveIds.add(aux.id); else revokedIds.add(aux.id);
      continue;
    }
    if (aux.retracted) { revokedIds.add(aux.id); continue; }
    knownLiveIds.add(aux.id);
    if (aux.type === 'content.questionState') {
      const qId = typeof aux.data?.questionId === 'string' ? aux.data.questionId as FactId : undefined;
      const restrictions = Array.isArray(aux.data?.restrictions) ? aux.data.restrictions as { action?: unknown }[] : [];
      if (qId && restrictions.some(r => r?.action === 'stop' || r?.action === 'withdraw')) stoppedQuestionIds.add(qId);
      continue;
    }
    if (aux.type === 'activity.workbookAttempt') {
      for (const qId of new Set(extractPaperSourceQuestionIds(aux.data ?? {}))) {
        attemptCounts.set(qId, (attemptCounts.get(qId) ?? 0) + 1);
        externalRefCounts.set(qId, (externalRefCounts.get(qId) ?? 0) + 1);
      }
      continue;
    }
    if (aux.type === 'activity.workbookPaper') {
      for (const qId of new Set(extractPaperSourceQuestionIds(aux.data ?? {}))) {
        externalRefCounts.set(qId, (externalRefCounts.get(qId) ?? 0) + 1);
      }
    }
  }

  // Pre-index concept ids and edge-linked concept memberships for questions/textbooks.
  const conceptIdSet = new Set<FactId>();
  const edgeConceptsByAsset = new Map<FactId, Set<FactId>>();
  for (const row of snapshotRows) {
    if (row.type === 'content.asset' && row.data.kind === 'concept') conceptIdSet.add(row.id);
  }
  const addAssetConcept = (assetId: FactId, conceptId: FactId) => {
    let set = edgeConceptsByAsset.get(assetId);
    if (!set) edgeConceptsByAsset.set(assetId, set = new Set());
    set.add(conceptId);
  };
  for (const row of snapshotRows) {
    if (row.type !== 'content.knowledgeEdge' || row.revoked) continue;
    const fromId = ((row.data.from as Record<string, unknown> | undefined)?.sourceUse as HostSourceUse | undefined)?.id as FactId | undefined;
    const toId = ((row.data.to as Record<string, unknown> | undefined)?.sourceUse as HostSourceUse | undefined)?.id as FactId | undefined;
    if (!fromId || !toId) continue;
    if (conceptIdSet.has(toId)) addAssetConcept(fromId, toId);
    if (conceptIdSet.has(fromId)) addAssetConcept(toId, fromId);
  }

  const entities: NonNullable<KbGardeningSnapshot['entities']>[number][] = [];
  const textbookPages: NonNullable<KbGardeningSnapshot['textbookPages']>[number][] = [];
  const questions: NonNullable<KbGardeningSnapshot['questions']>[number][] = [];
  const edges: NonNullable<KbGardeningSnapshot['edges']>[number][] = [];
  const mistakeNotes: NonNullable<KbGardeningSnapshot['mistakeNotes']>[number][] = [];
  const referenceCounts = new Map<FactId, number>();

  for (const row of snapshotRows) {
    const updatedAt = asIso(row.data.updatedAt) ??
      fallbackUpdatedAt(nowMs, clock - Number(row.changedTick ?? clock));
    if (row.type === 'content.asset') {
      const kind = row.data.kind;
      if (kind === 'concept' || kind === 'method' || kind === 'archetype') {
        const mergedInto = typeof row.data.merged_into === 'string' ? row.data.merged_into as FactId : null;
        entities.push({
          id: row.id, kind, canonicalName: row.revoked ? row.id : String(row.data.title ?? row.id),
          ...(row.revoked ? { revoked: true } : {}),
          ...(Array.isArray(row.data.aliases) && !row.revoked
            ? { aliases: row.data.aliases.filter((a): a is string => typeof a === 'string') } : {}),
          ...(mergedInto ? { merged_into: mergedInto } : {}),
          purpose: row.purpose, sticky: row.sticky, updatedAt,
        });
      } else if (kind === 'question') {
        const refIds = row.revoked ? [] : collectAssetReferencedIds(row.data);
        const cIds = row.revoked ? [] : [...new Set([...refIds.filter(id => conceptIdSet.has(id)), ...(edgeConceptsByAsset.get(row.id) ?? [])])];
        const isStopped = stoppedQuestionIds.has(row.id);
        questions.push({
          id: row.id, title: row.revoked ? row.id : String(row.data.title ?? row.id), rev: row.rev, updatedAt,
          purpose: row.purpose, sticky: row.sticky,
          status: isStopped || row.purpose.includes('teaching') || row.purpose.includes('all') ? 'active' : 'draft',
          attemptCount: attemptCounts.get(row.id) ?? 0,
          referenceCount: externalRefCounts.get(row.id) ?? 0,
          ...(refIds.length ? { referencedIds: refIds } : {}),
          ...(cIds.length ? { conceptIds: cIds } : {}),
        });
      }
      continue;
    }
    if (row.type === 'content.textbookPage') {
      if (row.data.archived === true) continue;
      const tags = Array.isArray(row.data.tags) ? row.data.tags : [];
      const userAuthored = row.anyLearnerRev === true && !tags.includes(COMPANION_GENERATED_TAG);
      const blocks = Array.isArray(row.data.blocks) ? row.data.blocks as Record<string, unknown>[] : [];
      const refIds = row.revoked ? [] : collectAssetReferencedIds(row.data);
      const cIds = row.revoked ? [] : [...new Set([...refIds.filter(id => conceptIdSet.has(id)), ...(edgeConceptsByAsset.get(row.id) ?? [])])];
      textbookPages.push({
        id: row.id, title: row.revoked ? row.id : String(row.data.title ?? row.id), rev: row.rev, updatedAt,
        purpose: row.purpose, sticky: row.sticky,
        status: userAuthored ? 'active' : 'draft',
        referenceCount: externalRefCounts.get(row.id) ?? 0,
        ...(refIds.length ? { referencedIds: refIds } : {}),
        ...(cIds.length ? { conceptIds: cIds } : {}),
        ...(userAuthored ? { userAuthoredBlockIds: blocks.map(block => String(block.id ?? '')) } : {}),
      });
      continue;
    }
    if (row.type === 'content.knowledgeEdge') {
      if (row.retracted) continue;
      const from = row.data.from as Record<string, unknown> | undefined;
      const to = row.data.to as Record<string, unknown> | undefined;
      const fromUse = from?.sourceUse as HostSourceUse | undefined;
      const toUse = to?.sourceUse as HostSourceUse | undefined;
      if (!fromUse?.id || !toUse?.id) continue;
      edges.push({
        id: row.id, kind: String(row.data.kind ?? ''), fromId: fromUse.id as FactId, toId: toUse.id as FactId,
        sticky: row.sticky, purpose: row.purpose,
      });
      for (const target of [fromUse.id, toUse.id] as FactId[])
        referenceCounts.set(target, (referenceCounts.get(target) ?? 0) + 1);
      continue;
    }
    const source = row.data.source as { id?: string; title?: string } | null | undefined;
    if (!source?.id) continue;
    const targetRow = entries.get(source.id as FactId);
    const targetKind: 'chapter' | 'concept' = targetRow?.type === 'content.textbookPage' ? 'chapter' : 'concept';
    mistakeNotes.push({
      id: row.id, targetId: source.id as FactId, targetKind,
      ...(!row.revoked && targetRow && !targetRow.revoked && targetRow.data?.title
        ? { targetTitle: String(targetRow.data.title) } : {}),
      summary: row.revoked ? row.id : String(row.data.markdown ?? row.data.title ?? row.id).slice(0, 240),
      createdAt: updatedAt, sticky: row.sticky, purpose: row.purpose,
    });
  }

  for (const entity of entities) {
    (entity as { referenceCount?: number }).referenceCount = referenceCounts.get(entity.id) ?? 0;
  }

  return {
    entries,
    clock,
    snapshot: {
      nowIso: new Date(nowMs).toISOString(),
      requiredPurpose: 'storage',
      revokedIds, knownLiveIds,
      entities, textbookPages, questions, edges, mistakeNotes,
    },
  };
}

export type GardeningDecisionRow = {
  readonly proposalId: string;
  readonly decision: 'accept' | 'dismiss';
  readonly result: Record<string, unknown>;
};
export type GardeningGreenRow = {
  readonly stepKey: string;
  readonly actionId: string;
  readonly undoToken: string;
  readonly result: Record<string, unknown>;
  readonly undone: boolean;
};

const decodeRow = (row: Record<string, unknown>): { stepKey: string; result: Record<string, unknown> } | null => {
  if (typeof row.step_key !== 'string' || row.state !== 'done') return null;
  const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
  return result && typeof result === 'object' ? { stepKey: row.step_key, result: result as Record<string, unknown> } : null;
};

export async function readGardeningEffects(tx: ReadTransaction) {
  const { rows } = await tx.query(
    `SELECT step_key, label, state, result FROM effects
      WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2
        AND label = ANY($3::text[]) ORDER BY ended_tick DESC, step_key DESC`,
    [tx.learner, gardeningOwnerId,
      [GARDENING_DECISION_LABEL, GARDENING_GREEN_LABEL, GARDENING_UNDO_LABEL]]);
  const decisions: GardeningDecisionRow[] = [];
  const green: GardeningGreenRow[] = [];
  const undoneTokens = new Set<string>();
  const undoneLegacyActionIds = new Set<string>();
  const decodedRows: { row: Record<string, unknown>; decoded: { stepKey: string; result: Record<string, unknown> } }[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const decoded = decodeRow(row);
    if (decoded) decodedRows.push({ row, decoded });
  }
  for (const { row, decoded } of decodedRows) {
    if (row.label !== GARDENING_UNDO_LABEL) continue;
    if (typeof decoded.result.undoToken === 'string' && decoded.result.undoToken) undoneTokens.add(decoded.result.undoToken);
    else if (typeof decoded.result.actionId === 'string') undoneLegacyActionIds.add(decoded.result.actionId);
  }
  for (const { row, decoded } of decodedRows) {
    const { stepKey, result } = decoded;
    if (row.label === GARDENING_DECISION_LABEL) {
      const proposalId = typeof result.proposalId === 'string' ? result.proposalId : stepKey.split(':').slice(2).join(':');
      if (proposalId && (result.decision === 'accept' || result.decision === 'dismiss')) {
        decisions.push({ proposalId, decision: result.decision, result });
      }
      continue;
    }
    if (row.label !== GARDENING_GREEN_LABEL) continue;
    const actionId = typeof result.actionId === 'string' ? result.actionId : undefined;
    const actionObj = result.action as Record<string, unknown> | undefined;
    const undoToken = typeof result.undoToken === 'string' ? result.undoToken
      : typeof actionObj?.undo_token === 'string' ? actionObj.undo_token : '';
    if (actionId && result.status === 'executed' && undoToken) {
      const undone = undoneTokens.has(undoToken) || undoneLegacyActionIds.has(actionId);
      green.push({ stepKey, actionId, undoToken, result, undone });
    }
  }
  return { decisions, green, undoneTokens };
}

function isGreenExecutionAuthorized(row: GardeningGreenRow, entries: ReadonlyMap<string, HostContentRow>): boolean {
  const action = row.result.action as Record<string, unknown> | undefined;
  const undo = row.result.undo as Record<string, unknown> | undefined;
  if (!action || !undo) return false;
  const checkLive = (id: unknown, allowArchived = false): boolean => {
    if (typeof id !== 'string' || !id) return false;
    const found = entries.get(id);
    if (!found || found.revoked || found.retracted) return false;
    if (!allowArchived && found.type === 'content.textbookPage' && found.data.archived === true) return false;
    return true;
  };
  if (undo.kind === 'undo_page_archive') return checkLive(undo.pageId, true) && entries.get(String(undo.pageId))?.data.archived === true;
  if (undo.kind === 'undo_page_creation') return checkLive(undo.pageId, false);
  if (undo.kind === 'resume_question') return checkLive(undo.questionId, false);
  if (undo.kind === 'restore_edge') {
    if (!checkLive(undo.repointedEdgeId, false)) return false;
    const preview = action.preview as Record<string, unknown> | undefined;
    if (preview?.toTargetId && !checkLive(preview.toTargetId, false)) return false;
    const fromEntry = preview?.fromTargetId ? entries.get(String(preview.fromTargetId)) : undefined;
    if (fromEntry?.revoked) return false;
    return true;
  }
  return false;
}

export type PlaybookRetireProposal = {
  readonly proposalId: string;
  readonly playbookId: string;
  readonly expectedRev: number;
  readonly version: number;
  readonly liftId: string;
  readonly sticky: boolean;
  readonly title: string;
  readonly summary: string;
};

/** Merge persisted decisions/executions + playbook proposals into the freshly computed plan. */
export function mergeGardeningInbox(
  plan: GardeningInboxPlan,
  effects: { decisions: readonly GardeningDecisionRow[]; green: readonly GardeningGreenRow[] },
  entries: ReadonlyMap<string, HostContentRow>,
  playbookProposals: readonly PlaybookRetireProposal[] = [],
): GardeningInboxPlan {
  const resolved = new Set(effects.decisions.map(row => row.proposalId));
  const pbYellows: GardeningYellowProposal[] = playbookProposals
    .filter(item => !item.sticky && !resolved.has(item.proposalId))
    .map(item => ({
      proposalId: item.proposalId, tier: 'yellow',
      proposalKind: 'retire_playbook' as unknown as GardeningYellowProposal['proposalKind'],
      title: item.title, summary: item.summary, requiresApproval: true,
      suggestedCommand: 'learner.retirePlaybook' as unknown as GardeningYellowProposal['suggestedCommand'],
      targetIds: [item.playbookId as FactId],
      detail: {},
    }));
  const yellow = [...plan.yellow.filter(proposal => !resolved.has(proposal.proposalId)), ...pbYellows];
  const executed = effects.green
    .filter(row => !row.undone && isGreenExecutionAuthorized(row, entries))
    .map(row => ({ ...(row.result.action as Record<string, unknown>), executed: true }));
  // Unexecuted candidates carry an empty undo_token so UI disables the Undo button until actually applied.
  const pending = (plan.green as unknown as Record<string, unknown>[]).map(action => ({
    ...action, undo_token: '', executed: false,
  }));
  const seen = new Set<string>();
  const green: Record<string, unknown>[] = [];
  for (const action of [...executed, ...pending] as Record<string, unknown>[]) {
    const actionId = String(action.actionId ?? '');
    if (!actionId || seen.has(actionId)) continue;
    seen.add(actionId);
    green.push(action);
  }
  return {
    ...plan, yellow, green: green as never,
    summary: { ...plan.summary, greenCount: green.length, yellowCount: yellow.length },
  };
}

export class GardeningRejection extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}
const reject = (status: number, message: string, code: string): never => {
  throw new GardeningRejection(status, message, code);
};
const requireRow = <T>(value: T | undefined, status: number, message: string, code: string): T => {
  if (value === undefined) return reject(status, message, code);
  return value as T;
};

/** Classify expected kernel command errors & gardening rejections into HTTP status codes. */
export function classifyGardeningError(
  error: unknown,
  checks: { readonly isUnavailable: (e: unknown) => boolean; readonly isNotionUnconfirmed: (e: unknown) => boolean },
): { status: number; message: string; code?: string } | null {
  if (error instanceof GardeningRejection) return { status: error.status, message: error.message, code: error.code };
  if (checks.isNotionUnconfirmed(error)) return { status: 503, message: '暂时无法核对 Notion 来源，请稍后重试。', code: 'notion_unconfirmed' };
  if (checks.isUnavailable(error)) return { status: 403, message: '目标或依据当前不可读。', code: 'access_denied' };
  if (error instanceof Error) {
    const msg = error.message;
    if (/Fact revision conflict|Fact already exists|冲突|已变化|已归档|已有同名/.test(msg)) return { status: 409, message: msg, code: 'command_conflict' };
    if (/无效|缺少|不能|需要|仅能|不可|重复|超过|须与|重挂/.test(msg)) return { status: 400, message: msg, code: 'command_invalid' };
  }
  return null;
}

export type GardeningCommandSpec = {
  readonly type: string;
  readonly actor: 'learner' | 'companion';
  readonly input: Record<string, unknown>;
  readonly commandKey: string;
  readonly purpose?: 'storage' | 'teaching';
};
export type ExecutedGreenMeta = {
  readonly actionId: string;
  readonly actionKind: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly title: string;
  readonly reason: string;
  readonly preview: Record<string, unknown>;
  readonly priorRev: number;
  readonly undo: Record<string, unknown>;
};
export type GardeningExecutionPlan = {
  readonly commands: readonly GardeningCommandSpec[];
  readonly decision: { proposalId: string; decision: 'accept' | 'dismiss' | 'apply_green' };
  readonly green?: ExecutedGreenMeta;
};

type ClientRequest = {
  proposalId?: string;
  actionId?: string;
  proposalKind?: string;
  targetIds?: unknown;
  children?: unknown;
};
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const matchTargets = (expected: readonly string[], actual: unknown): boolean => {
  if (actual === undefined) return true;
  const given = asStringArray(actual);
  return given.length === expected.length && expected.every((id, index) => id === given[index]);
};

/** Red rails check only the matching action kind against the mutated target ids. */
const assertNotRed = (plan: GardeningInboxPlan, targetIds: readonly string[], actionKind: string) => {
  for (const guard of plan.red) {
    if (guard.blockedAction !== actionKind) continue;
    if (guard.blockedAction === 'overwrite_user_authored_textbook' || guard.blockedAction === 'overwrite_sticky_target') continue;
    if (targetIds.includes(guard.assetId))
      reject(403, `目标命中红灯护栏（${guard.rule}）：${guard.reason}`, 'red_guardrail');
  }
};

const evolveGraphCommand = 'content.evolveGraph';

/** Validate one client decision against the recomputed plan and emit the exact command specs. */
export async function planGardeningDecision(
  plan: GardeningInboxPlan,
  request: ClientRequest & { action: 'accept' | 'dismiss' | 'apply_green' },
  context: {
    entries: Map<string, HostContentRow>;
    playbookProposals?: readonly PlaybookRetireProposal[];
    stickyPlaybookIds?: ReadonlySet<string>;
    questionStateRev?: (questionId: string) => Promise<number | undefined>;
    nowIso: string;
  },
): Promise<GardeningExecutionPlan> {
  const { action } = request;
  if (action === 'dismiss' || action === 'accept') {
    const proposalId = typeof request.proposalId === 'string' ? request.proposalId : '';
    if (!proposalId) reject(400, '缺少提案标识。', 'invalid_request');
    if (action === 'accept' && proposalId.startsWith('yellow:retire_playbook:')) {
      for (const stickyId of context.stickyPlaybookIds ?? []) {
        if (proposalId.includes(`/${stickyId}/`)) reject(403, '该策略已设置 sticky 保护，严禁自动退场。', 'red_guardrail');
      }
    }
    const playbookProposal = context.playbookProposals?.find(item => item.proposalId === proposalId);
    if (playbookProposal) {
      if (action === 'dismiss') return { commands: [], decision: { proposalId, decision: 'dismiss' } };
      if (playbookProposal.sticky) reject(403, '该策略已设置 sticky 保护，严禁自动退场。', 'red_guardrail');
      return {
        commands: [{
          type: 'learner.retirePlaybook', actor: 'learner', commandKey: `retire:${proposalId}`,
          input: { id: playbookProposal.playbookId, expectedRev: playbookProposal.expectedRev,
            version: playbookProposal.version, liftId: playbookProposal.liftId },
        }],
        decision: { proposalId, decision: 'accept' },
      };
    }
    if (action === 'accept') {
      const requestedTargets = asStringArray(request.targetIds);
      if (requestedTargets.length && request.proposalKind) assertNotRed(plan, requestedTargets, request.proposalKind);
    }
    const foundProposal = plan.yellow.find(item => item.proposalId === proposalId);
    if (!foundProposal) reject(404, '该园艺提案不存在或已被处理。', 'proposal_not_found');
    const proposal = foundProposal!;
    if (request.proposalKind !== undefined && request.proposalKind !== proposal.proposalKind)
      reject(409, '提案类型与实时计划不匹配，请刷新后重试。', 'proposal_mismatch');
    if (!matchTargets(proposal.targetIds, request.targetIds))
      reject(409, '提案目标与实时计划不匹配，请刷新后重试。', 'proposal_mismatch');
    if (action === 'dismiss') return { commands: [], decision: { proposalId, decision: 'dismiss' } };
    return planAcceptCommands(plan, proposal, request, context);
  }
  const actionId = typeof request.actionId === 'string' ? request.actionId : '';
  if (!actionId) reject(400, '缺少绿灯动作标识。', 'invalid_request');
  const foundGreen = (plan.green as (GardeningGreenAction & { executed?: boolean })[])
    .find(item => item.actionId === actionId && item.executed !== true);
  if (!foundGreen) reject(404, '该绿灯动作不存在或已执行。', 'action_not_found');
  return planGreenCommands(foundGreen!, context);
}

async function planAcceptCommands(
  plan: GardeningInboxPlan,
  proposal: GardeningYellowProposal,
  request: ClientRequest,
  context: { entries: Map<string, HostContentRow>; nowIso: string },
): Promise<GardeningExecutionPlan> {
  const { entries } = context;
  const live = (id: string) => {
    const found = entries.get(id);
    return found && !found.retracted && !found.revoked ? found : undefined;
  };
  const decision = { proposalId: proposal.proposalId, decision: 'accept' as const };

  if (proposal.proposalKind === 'merge_duplicate_concepts') {
    const detail = proposal.detail;
    const mergeId = detail.mergeEntityId, keepId = detail.keepEntityId;
    if (!mergeId || !keepId) reject(409, '重复概念提案缺少合并目标。', 'proposal_mismatch');
    assertNotRed(plan, [mergeId as string], proposal.proposalKind);
    const merge = requireRow(live(mergeId as string), 409, '合并目标已变化，请刷新后重试。', 'proposal_mismatch');
    const keep = requireRow(live(keepId as string), 409, '合并目标已变化，请刷新后重试。', 'proposal_mismatch');
    if (merge.sticky) reject(403, '合出侧已设置 sticky 保护，严禁合并。', 'red_guardrail');
    if (typeof merge.data.merged_into === 'string') reject(409, '合出侧已是重定向实体。', 'proposal_mismatch');
    return {
      decision,
      commands: [{
        type: evolveGraphCommand, actor: 'learner', commandKey: `merge:${proposal.proposalId}`,
        input: { action: 'merge', id: mergeId, expectedRev: merge.rev, into: keepId, targetRev: keep.rev },
      }],
    };
  }

  if (proposal.proposalKind === 'propose_emergency_card') {
    const detail = proposal.detail;
    const targetId = detail.compressionTargetId ?? proposal.targetIds[0];
    if (!targetId) reject(409, '压缩目标已变化，请刷新后重试。', 'proposal_mismatch');
    const target = requireRow(live(targetId as string), 409, '压缩目标已变化，请刷新后重试。', 'proposal_mismatch');
    const noteIds = (detail.noteIds ?? []).filter(id => live(id as string));
    if (!noteIds.length) reject(409, '错题备注已不可用，请刷新后重试。', 'proposal_mismatch');
    const targetTitle = String(target.data.title ?? targetId);
    const notes = noteIds.map(id => ({
      title: String(entries.get(id)?.data.title ?? '错题备注'),
      markdown: String(entries.get(id)?.data.markdown ?? ''),
    }));
    const pageId = factId(stableId('kb-gardening-emergency-card', proposal.proposalId));
    const artifact = detail.recommendedArtifact === 'decision_tree' ? '易混决策树' : '考前 3 分钟急救卡';
    const summaryLines = notes.map(note => `- ${note.markdown.replace(/\s+/g, ' ').trim().slice(0, 160) || note.title}`);
    const blocks = [
      { id: 'b1', parentId: null, body: { kind: 'text', text: `伴生${artifact}：依据 ${notes.length} 条错题/避坑备注整理（仅追加伴生页，不改动原教材正文）。` } },
      { id: 'b2', parentId: null, body: { kind: 'text', text: `速查要点：\n${summaryLines.join('\n')}` } },
      { id: 'b3', parentId: null, body: { kind: 'text', text: `三分钟自检：\n${notes.map((note, index) => `${index + 1}. ${note.title}`).join('\n')}` } },
    ];
    return {
      decision,
      commands: [{
        type: 'content.createTextbookPage', actor: 'companion', commandKey: `emergency:${proposal.proposalId}`,
        input: {
          id: pageId, clientEditSeq: 1, purpose: ['storage'],
          page: {
            title: `${artifact} · ${targetTitle}`, blocks,
            tags: [COMPANION_GENERATED_TAG, 'kb-gardening-emergency-card'],
            basis: [{ id: target.id, rev: target.rev, epoch: target.accessEpoch, type: target.type }],
          },
        },
      }],
      green: {
        actionId: `green:emergency_card:${proposal.proposalId}`,
        actionKind: 'propose_emergency_card', targetKind: 'textbook_page', targetId: pageId,
        title: `伴生急救卡：${targetTitle}`,
        reason: '采纳急救卡提案生成的伴生教材页（append-only）。',
        preview: { previousStatus: 'draft', nextStatus: 'archived' },
        priorRev: 0,
        undo: { kind: 'undo_page_creation', pageId },
      },
    };
  }

  if (proposal.proposalKind === 'cleanup_dangling_reference') {
    const danglingId = proposal.detail.danglingReferenceId ?? '';
    const foundDangling = plan.radar.danglingReferences.find(item => item.id === danglingId);
    if (!foundDangling) reject(409, '悬空引用已变化，请刷新后重试。', 'proposal_mismatch');
    const dangling = foundDangling!;
    assertNotRed(plan, [dangling.holderId], proposal.proposalKind);
    if (dangling.holderKind === 'edge') {
      const edge = requireRow(live(dangling.holderId), 409, '悬空引用来源已不可用。', 'proposal_mismatch');
      if (edge.sticky) reject(403, '该知识边已设置 sticky 保护，严禁撤回。', 'red_guardrail');
      return {
        decision,
        commands: [{
          type: 'content.withdrawKnowledgeEdge', actor: 'learner', commandKey: `withdraw:${proposal.proposalId}`,
          input: { id: dangling.holderId, expectedRev: edge.rev },
        }],
      };
    }
    return { decision, commands: [] };
  }

  if (proposal.proposalKind === 'propose_split_coarse_concept') {
    const conceptId = proposal.targetIds[0] as string | undefined;
    const concept = conceptId === undefined ? undefined : live(conceptId);
    if (conceptId === undefined || concept === undefined) reject(409, '粗粒度概念已变化，请刷新后重试。', 'proposal_mismatch');
    assertNotRed(plan, [conceptId!], proposal.proposalKind);
    if (concept!.sticky) reject(403, '该概念已设置 sticky 保护，严禁拆分。', 'red_guardrail');
    const conceptRow = concept!;
    const children = Array.isArray(request.children) ? request.children : [];
    if (children.length < 2 || children.length > 16) {
      reject(400, '拆分粗粒度概念需要提供 2–16 个子概念名称（children），本次未写入。', 'split_children_required');
    }
    const entityKind = conceptRow.data.kind === 'method' || conceptRow.data.kind === 'archetype'
      ? conceptRow.data.kind : 'concept';
    const parentUse = { id: conceptRow.id, rev: conceptRow.rev, accessEpoch: conceptRow.accessEpoch };
    const parsedChildren = children.map((child, index) => {
      const input = child as Record<string, unknown>;
      const name = typeof input?.name === 'string' ? input.name.trim()
        : typeof input?.canonicalName === 'string' ? input.canonicalName.trim() : '';
      if (!name) reject(400, '拆分后的子概念需要名称。', 'invalid_request');
      return {
        id: factId(stableId('kb-gardening-split-child', proposal.proposalId, String(index), name)),
        entity: { kind: entityKind, canonicalName: name, aliases: [], merged_into: null },
        resolution: { decision: 'no-match', reason: '园艺拆分粗粒度概念', candidates: [], sourceUses: [parentUse] },
      };
    });
    return {
      decision,
      commands: [{
        type: evolveGraphCommand, actor: 'learner', commandKey: `split:${proposal.proposalId}`,
        input: {
          action: 'split', id: conceptRow.id, expectedRev: conceptRow.rev,
          purpose: conceptRow.purpose.includes('teaching') ? 'teaching' : 'storage',
          children: parsedChildren,
          reattachments: [], reason: `学习者采纳园艺拆分提案：${String(conceptRow.data.title ?? conceptRow.id)}`,
        },
        purpose: conceptRow.purpose.includes('teaching') ? 'teaching' : 'storage',
      }],
    };
  }
  return reject(409, '该提案类型暂不支持执行。', 'proposal_mismatch');
}

function stripEdgeVerification(edgeData: Record<string, unknown>): Record<string, unknown> {
  const { verification: _v, ...claim } = edgeData;
  return claim;
}

async function planGreenCommands(
  green: GardeningGreenAction,
  context: {
    entries: Map<string, HostContentRow>;
    questionStateRev?: (questionId: string) => Promise<number | undefined>;
    nowIso: string;
  },
): Promise<GardeningExecutionPlan> {
  const { entries } = context;
  const targetRow = entries.get(green.targetId);
  if (!targetRow || targetRow.retracted || targetRow.revoked) reject(409, '绿灯目标已不可用，请刷新后重试。', 'action_stale');
  const target = targetRow!;
  if (target.sticky) reject(403, '目标已设置 sticky 保护。', 'red_guardrail');
  const decision = { proposalId: green.actionId, decision: 'apply_green' as const };
  const base = {
    actionId: green.actionId, actionKind: green.actionKind, targetKind: green.targetKind,
    targetId: green.targetId, title: green.title, reason: green.reason,
    preview: green.preview as Record<string, unknown>, priorRev: target.rev,
  };

  if (green.actionKind === 'archive_stale_unused_draft') {
    if (green.targetKind === 'textbook_page') {
      if (target.anyLearnerRev && !(Array.isArray(target.data.tags) && target.data.tags.includes(COMPANION_GENERATED_TAG)))
        reject(403, '该教材页包含用户原创正文，严禁自动归档。', 'red_guardrail');
      return {
        decision,
        commands: [{
          type: 'content.archiveTextbookPage', actor: 'learner', commandKey: `archive:${green.actionId}`,
          input: { id: green.targetId, expectedRev: target.rev },
        }],
        green: { ...base, undo: { kind: 'undo_page_archive', pageId: green.targetId, priorRev: target.rev } },
      };
    }
    if (green.targetKind === 'question') {
      const stateRev = context.questionStateRev ? await context.questionStateRev(green.targetId) : undefined;
      if (!stateRev) reject(409, '题目处置基版不可用，请刷新后重试。', 'action_stale');
      return {
        decision,
        commands: [{
          type: 'content.disposeQuestion', actor: 'learner', commandKey: `dispose:${green.actionId}`,
          input: {
            id: green.targetId, expectedRev: target.rev, stateRev: stateRev!,
            disposition: { action: 'stop', scope: 'all', reason: '园艺归档闲置草稿题（可逆停用，非永久删除）。' },
          },
        }],
        green: { ...base, undo: { kind: 'resume_question', questionId: green.targetId } },
      };
    }
    return reject(409, '该绿灯目标类型不支持归档。', 'action_stale');
  }

  if (green.actionKind === 'repoint_redirected_reference') {
    if (green.targetKind !== 'edge') reject(409, '仅支持改指知识边引用。', 'action_stale');
    const toTargetId = green.preview.toTargetId;
    const fromTargetId = green.preview.fromTargetId;
    const toTarget = typeof toTargetId === 'string' ? entries.get(toTargetId) : undefined;
    if (typeof toTargetId !== 'string' || !toTarget || toTarget.retracted || toTarget.revoked)
      reject(409, '改指目标已不可用，请刷新后重试。', 'action_stale');
    const resolvedTarget = toTarget!;
    const claim = stripEdgeVerification(target.data);
    const endpointKey: 'from' | 'to' = green.actionId.includes(':fromId:') ? 'from' : 'to';
    const otherKey: 'from' | 'to' = endpointKey === 'from' ? 'to' : 'from';
    const endpoint = claim[endpointKey] as Record<string, unknown>;
    const otherEndpoint = claim[otherKey] as Record<string, unknown>;
    if (endpoint?.blockId !== undefined) reject(409, '带块定位的引用暂不支持自动改指。', 'repoint_block_unsupported');
    const otherId = (otherEndpoint?.sourceUse as { id?: string } | undefined)?.id;
    if (otherId === toTargetId) reject(409, '改指将产生自环边，已拒绝。', 'repoint_self_loop');
    const resolvedUse = { id: toTargetId, rev: resolvedTarget.rev, accessEpoch: resolvedTarget.accessEpoch };
    const existingUses = Array.isArray(claim.sourceUses) ? claim.sourceUses as { id?: string; rev?: number; accessEpoch?: string }[] : [];
    const prunedUses = existingUses.filter(use => use.id !== toTargetId && (use.id !== fromTargetId || otherId === fromTargetId));
    const mergedUses = [...prunedUses, resolvedUse];
    const hasTeaching = (p: readonly string[]) => p.includes('teaching') || p.includes('all');
    const allUsesTeach = mergedUses.every(use => {
      const row = use.id ? entries.get(use.id) : undefined;
      return !row || hasTeaching(row.purpose);
    });
    const preservedPurpose: 'storage' | 'teaching' = hasTeaching(target.purpose) && hasTeaching(resolvedTarget.purpose) && allUsesTeach
      ? 'teaching' : 'storage';
    const repointedEdgeId = factId(stableId('kb-gardening-repointed-edge', green.actionId, String(target.rev)));
    const newEdge = { ...claim, [endpointKey]: { ...endpoint, sourceUse: resolvedUse }, sourceUses: mergedUses };
    return {
      decision,
      commands: [
        {
          type: 'content.withdrawKnowledgeEdge', actor: 'learner', commandKey: `repoint-withdraw:${green.actionId}`,
          input: { id: green.targetId, expectedRev: target.rev },
        },
        {
          type: 'content.createKnowledgeEdge', actor: 'learner', commandKey: `repoint-create:${green.actionId}`,
          input: { id: repointedEdgeId, purpose: preservedPurpose, edge: newEdge },
          purpose: preservedPurpose,
        },
      ],
      green: {
        ...base,
        undo: {
          kind: 'restore_edge', originalEdge: claim, originalPurpose: hasTeaching(target.purpose) ? 'teaching' : 'storage',
          repointedEdgeId, withdrawnEdgeId: green.targetId, fromTargetId,
        },
      },
    };
  }
  return reject(409, '该绿灯动作类型不支持执行。', 'action_stale');
}

/** Plan the reversal of one executed green/accept record, verifying all targets remain authorized. */
export async function planGardeningUndo(
  record: { actionId: string; undoToken: string; result: Record<string, unknown> },
  context: {
    entries: Map<string, HostContentRow>;
    verifyContent?: VerifyContentUse;
    questionStateRev?: (questionId: string) => Promise<number | undefined>;
  },
): Promise<{ commands: readonly GardeningCommandSpec[] }> {
  const undoInput = record.result.undo as Record<string, unknown> | undefined;
  if (!undoInput) reject(409, '该执行记录缺少撤回凭据。', 'undo_unavailable');
  const undo = undoInput!;
  const entries = context.entries;
  const requireAuthorized = (id: string, { allowArchived = false } = {}) => {
    const entry = entries.get(id);
    if (!entry) reject(404, '撤回目标不存在。', 'undo_not_found');
    if (entry!.revoked) reject(403, '撤回目标已撤权或不可读，拒绝撤回写入。', 'target_revoked');
    if (entry!.retracted) reject(409, '撤回目标已撤回或删除。', 'undo_conflict');
    if (!allowArchived && entry!.type === 'content.textbookPage' && entry!.data.archived === true)
      reject(409, '教材页当前处于归档状态。', 'undo_conflict');
    return entry!;
  };

  if (undo.kind === 'undo_page_creation') {
    const pageId = String(undo.pageId);
    const page = requireAuthorized(pageId);
    return {
      commands: [{
        type: 'content.undoTextbookWrite', actor: 'learner', commandKey: `undo-create:${record.undoToken}`,
        input: { id: pageId, expectedRev: page.rev, priorRev: null },
      }],
    };
  }
  if (undo.kind === 'undo_page_archive') {
    const pageId = String(undo.pageId);
    const priorRev = Number(undo.priorRev);
    const page = requireAuthorized(pageId, { allowArchived: true });
    if (page.data.archived !== true) reject(409, '归档页已不在归档状态。', 'undo_conflict');
    return {
      commands: [{
        type: 'content.undoTextbookWrite', actor: 'learner', commandKey: `undo-archive:${record.undoToken}`,
        input: { id: pageId, expectedRev: page.rev, priorRev, appliedRev: page.rev },
      }],
    };
  }
  if (undo.kind === 'resume_question') {
    const questionId = String(undo.questionId);
    const question = requireAuthorized(questionId);
    const stateRev = context.questionStateRev ? await context.questionStateRev(questionId) : undefined;
    if (!stateRev) reject(409, '题目处置记录已不可用。', 'undo_conflict');
    return {
      commands: [{
        type: 'content.disposeQuestion', actor: 'learner', commandKey: `undo-dispose:${record.undoToken}`,
        input: {
          id: questionId, expectedRev: question.rev, stateRev: stateRev!,
          disposition: { action: 'resume', scope: 'all', reason: '学习者一键撤回园艺归档停用。' },
        },
      }],
    };
  }
  if (undo.kind === 'restore_edge') {
    const repointedId = String(undo.repointedEdgeId);
    const repointed = entries.get(repointedId);
    if (repointed?.revoked) reject(403, '改指后的边已撤权，拒绝撤回写入。', 'target_revoked');
    const original = undo.originalEdge as Record<string, unknown>;
    if (!original) reject(409, '原始边快照缺失。', 'undo_unavailable');
    for (const use of collectSourceUses(original)) {
      const peer = entries.get(use.id);
      if (peer?.revoked || peer?.retracted) reject(403, '原始边依据已撤权或不可用，拒绝重建。', 'target_revoked');
      if (context.verifyContent && !(await context.verifyContent(use, 'content.knowledgeEdge')))
        reject(403, '原始边依据已撤权或不可用，拒绝重建。', 'target_revoked');
    }
    const restoredId = factId(stableId('kb-gardening-restored-edge', record.undoToken));
    const commands: GardeningCommandSpec[] = [];
    if (repointed && !repointed.retracted) {
      if (repointed.sticky) reject(403, '改指后的边已设置 sticky 保护。', 'red_guardrail');
      commands.push({
        type: 'content.withdrawKnowledgeEdge', actor: 'learner', commandKey: `undo-repoint-withdraw:${record.undoToken}`,
        input: { id: repointed.id, expectedRev: repointed.rev },
      });
    }
    const restoredPurpose: 'storage' | 'teaching' = undo.originalPurpose === 'teaching' ? 'teaching' : 'storage';
    commands.push({
      type: 'content.createKnowledgeEdge', actor: 'learner', commandKey: `undo-repoint-create:${record.undoToken}`,
      input: { id: restoredId, purpose: restoredPurpose, edge: stripEdgeVerification(original) },
      purpose: restoredPurpose,
    });
    return { commands };
  }
  return reject(409, '未知的撤回凭据类型。', 'undo_unavailable');
}

export type InboxContext = {
  readonly plan: GardeningInboxPlan;
  readonly entries: Map<string, HostContentRow>;
  readonly playbookProposals: readonly PlaybookRetireProposal[];
  readonly stickyPlaybookIds: ReadonlySet<string>;
};

export type GardeningRunDeps = {
  readonly loadInbox?: (tx: ReadTransaction) => Promise<InboxContext>;
  readonly executeCommands: (
    tx: ReadTransaction,
    requestKey: string,
    specs: readonly GardeningCommandSpec[],
  ) => Promise<readonly { commandId?: string; wrote?: readonly { id: string; rev: number }[] }[]>;
  readonly questionStateRev?: (tx: ReadTransaction, questionId: string) => Promise<number | undefined>;
  readonly verifyContent?: VerifyContentUse;
};

type WriteTx = ReadTransaction & {
  withLearnerWrite: (write: (tick: never) => Promise<unknown>) => Promise<unknown>;
  query: ReadTransaction['query'];
};

const findEffectRow = async (tx: ReadTransaction, stepKey: string, label: string) => {
  const { rows: [saved] } = await tx.query<{ state: string; result: unknown; input_digest: string }>(
    `SELECT state, result, input_digest FROM effects
       WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2 AND step_key=$3 AND label=$4`,
    [tx.learner, gardeningOwnerId, stepKey, label]);
  return saved;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}';
};

const sha256Hex = async (text: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const recordEffect = async (tx: WriteTx, stepKey: string, label: string, input: unknown, result: unknown) =>
  tx.withLearnerWrite(async tick => {
    const inputCanonical = canonicalJson(input);
    await tx.query(
      `INSERT INTO effects (learner_id, owner_kind, owner_id, step_key, label, input_digest, input,
         provider_effect_id, state, result, started_tick, ended_tick,
         budget_route, reserved_usd_micros, actual_usd_micros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'done',$9,$10,$10,NULL,NULL,NULL)
       ON CONFLICT (learner_id, owner_kind, owner_id, step_key, label) DO NOTHING`,
      [tx.learner, 'session', gardeningOwnerId, stepKey, label,
        await sha256Hex(inputCanonical), inputCanonical, null, canonicalJson(result), String(tick)]);
    return undefined as never;
  });

export function parseGardeningActionRequest(raw: Record<string, unknown>, requestId: string) {
  const batch = raw.batch === true;
  const items: Record<string, unknown>[] = batch
    ? (Array.isArray(raw.proposals) ? raw.proposals as Record<string, unknown>[] : []) : [raw];
  if (!items.length || items.length > 64) reject(400, '批量园艺请求为空或超出上限 64。', 'invalid_request');
  const batchAction = typeof raw.action === 'string' ? raw.action : '';
  const effectInput = {
    batch,
    items: items.map(item => Object.fromEntries(Object.entries({
      action: batch ? batchAction : item.action, proposalId: item.proposalId, actionId: item.actionId,
      proposalKind: item.proposalKind, suggestedCommand: item.suggestedCommand, targetIds: item.targetIds,
      children: item.children,
    }).filter(([, value]) => value !== undefined))),
  };
  return { requestId, batch, batchAction, items, effectInput };
}

export function parseGardeningUndoRequest(raw: Record<string, unknown>, requestId: string) {
  const actionId = typeof raw.actionId === 'string' ? raw.actionId : '';
  const undoToken = typeof raw.undo_token === 'string' ? raw.undo_token : '';
  if (!actionId || !undoToken) reject(400, '缺少撤回动作标识或凭据。', 'invalid_request');
  return { requestId, actionId, undoToken, effectInput: { actionId, undoToken } };
}

export async function runGardeningActions(
  tx: WriteTx,
  deps: GardeningRunDeps,
  request: {
    requestId: string;
    effectDigest: string;
    effectInput: unknown;
    batch: boolean;
    batchAction: string;
    items: readonly Record<string, unknown>[];
  },
): Promise<unknown> {
  const { requestId, batch, batchAction } = request;
  const stepKey = `action:${requestId}`;
  const saved = await findEffectRow(tx, stepKey, GARDENING_ACTION_LABEL);
  if (saved) {
    if (saved.input_digest !== request.effectDigest || saved.state !== 'done')
      reject(409, '同一请求标识已用于不同园艺操作。', 'duplicate_request_conflict');
    return saved.result;
  }
  if (!deps.loadInbox) reject(500, '园艺执行缺少收件箱加载器。', 'host_misconfigured');
  let inbox = await deps.loadInbox!(tx);
  const nowIso = new Date().toISOString();
  const seenBatchKeys = new Set<string>();
  const questionStateRev = deps.questionStateRev
    ? (questionId: string) => deps.questionStateRev!(tx, questionId) : undefined;
  for (let i = 0; i < request.items.length; i += 1) {
    const item = request.items[i]!;
    const action = batch ? batchAction : item.action;
    if (action !== 'accept' && action !== 'dismiss' && action !== 'apply_green')
      reject(400, '园艺操作类型无效。', 'invalid_request');
    const itemKey = `${action}:${String(action === 'apply_green' ? item.actionId ?? '' : item.proposalId ?? '')}`;
    if (seenBatchKeys.has(itemKey)) reject(409, '批量园艺请求包含重复项。', 'duplicate_batch_item');
    seenBatchKeys.add(itemKey);
    const decision = await planGardeningDecision(inbox.plan, { ...item, action } as never, {
      entries: inbox.entries,
      playbookProposals: inbox.playbookProposals,
      stickyPlaybookIds: inbox.stickyPlaybookIds,
      ...(questionStateRev ? { questionStateRev } : {}),
      nowIso,
    });
    const receipts = await deps.executeCommands(tx, requestId, decision.commands);
    if (decision.green) {
      const meta = decision.green;
      const undo_token = `undo:${stableId('kb-gardening-undo-token', requestId, meta.actionId)}`;
      const executionStepKey = `green:${requestId}:${meta.actionId}`;
      const written = receipts.flatMap(receipt => receipt.wrote ?? []);
      const targetWrite = written.find(write => write.id === meta.targetId) ?? written[written.length - 1];
      await recordEffect(tx, executionStepKey, GARDENING_GREEN_LABEL,
        { requestId, actionId: meta.actionId },
        {
          status: 'executed', actionId: meta.actionId, undoToken: undo_token, executionStepKey,
          action: {
            actionId: meta.actionId, tier: 'green', actionKind: meta.actionKind,
            targetKind: meta.targetKind, targetId: meta.targetId, title: meta.title,
            reason: meta.reason, reversible: true, undo_token, preview: meta.preview,
            suggestedCommand: 'host.applied',
          },
          newRev: targetWrite?.rev ?? null,
          commandIds: receipts.map(receipt => receipt.commandId).filter((id): id is string => typeof id === 'string'),
          undo: meta.undo,
        });
    }
    if (decision.decision.decision !== 'apply_green') {
      await recordEffect(tx, `decision:${decision.decision.proposalId}`, GARDENING_DECISION_LABEL,
        { requestId, proposalId: decision.decision.proposalId, action },
        { proposalId: decision.decision.proposalId, decision: decision.decision.decision });
    }
    if (i + 1 < request.items.length && decision.commands.length > 0) inbox = await deps.loadInbox!(tx);
  }
  const receipt = { status: 'ok', processed: request.items.length };
  await recordEffect(tx, stepKey, GARDENING_ACTION_LABEL, request.effectInput, receipt);
  return receipt;
}

export async function runGardeningUndo(
  tx: WriteTx,
  deps: GardeningRunDeps,
  scanEntries: (tx: ReadTransaction) => Promise<Map<string, HostContentRow>>,
  request: { requestId: string; effectDigest: string; effectInput: unknown; actionId: string; undoToken: string },
): Promise<unknown> {
  const { requestId, actionId, undoToken } = request;
  const stepKey = `undo:${requestId}`;
  const saved = await findEffectRow(tx, stepKey, GARDENING_UNDO_LABEL);
  if (saved) {
    if (saved.input_digest !== request.effectDigest || saved.state !== 'done')
      reject(409, '同一请求标识已用于不同撤回操作。', 'duplicate_request_conflict');
    return saved.result;
  }
  const effects = await readGardeningEffects(tx);
  const greenRecord = effects.green.find(row => row.actionId === actionId && row.undoToken === undoToken);
  if (!greenRecord) reject(404, '未找到该执行记录或撤回凭据不匹配。', 'undo_not_found');
  if (greenRecord!.undone) reject(409, '该动作已被撤回。', 'already_undone');
  const entries = await scanEntries(tx);
  const plan = await planGardeningUndo({ actionId, undoToken, result: greenRecord!.result }, {
    entries,
    ...(deps.verifyContent ? { verifyContent: deps.verifyContent } : {}),
    questionStateRev: deps.questionStateRev
      ? (questionId: string) => deps.questionStateRev!(tx, questionId)
      : async () => undefined,
  });
  await deps.executeCommands(tx, requestId, plan.commands);
  const result = {
    status: 'undone', actionId,
    ref: plan.commands[plan.commands.length - 1]?.input.id as string | undefined,
  };
  await recordEffect(tx, stepKey, GARDENING_UNDO_LABEL, request.effectInput,
    { ...result, undoToken, executionStepKey: greenRecord!.stepKey });
  return result;
}

export type VerifyPrimitives = {
  readonly reopenCapture: (use: HostSourceUse) => Promise<unknown>;
  readonly isUnavailable: (error: unknown) => boolean;
  readonly isNotionUnconfirmed: (error: unknown) => boolean;
  readonly captureSourceType: string;
};

/**
 * Memoized per-transaction capture verifier. Definite revocations return false; transient
 * Notion unconfirmed errors propagate directly to the route boundary (HTTP 503).
 */
export function makeContentVerifier(tx: ReadTransaction, primitives: VerifyPrimitives): VerifyContentUse {
  const memo = new Map<string, Promise<boolean>>();
  return (use) => {
    const key = `${use.id}:${use.rev}:${use.accessEpoch ?? ''}`;
    if (!memo.has(key)) {
      memo.set(key, (async () => {
        const { rows: [row] } = await tx.query<{ type: string }>(
          'SELECT type FROM facts WHERE learner_id=$1 AND id=$2', [tx.learner, use.id]);
        if (row?.type !== primitives.captureSourceType) return true;
        try {
          await primitives.reopenCapture(use);
          return true;
        } catch (error) {
          if (primitives.isNotionUnconfirmed(error) || !primitives.isUnavailable(error)) throw error;
          return false;
        }
      })());
    }
    return memo.get(key)!;
  };
}

/** Scan + fresh plan + effects overlay + playbook proposals in one pass. */
export async function loadGardeningInbox(
  tx: ReadTransaction,
  verifyContent: VerifyContentUse,
  playbookProposals: readonly PlaybookRetireProposal[],
  stickyPlaybookIds: ReadonlySet<string>,
  buildPlan: (snapshot: KbGardeningSnapshot) => GardeningInboxPlan,
): Promise<InboxContext> {
  const scanned = await scanKbHostContent(tx, verifyContent);
  const effects = await readGardeningEffects(tx);
  const resolved = new Set(effects.decisions.map(d => d.proposalId));
  const activePlaybooks = playbookProposals.filter(item => !resolved.has(item.proposalId));
  const entries = new Map(scanned.entries);
  return {
    plan: mergeGardeningInbox(buildPlan(scanned.snapshot), effects, entries, activePlaybooks),
    entries,
    playbookProposals: activePlaybooks,
    stickyPlaybookIds,
  };
}

export async function executeGardeningCommands(
  handle: (request: { actor: 'learner' | 'companion'; purpose: string; type: string; id: string; input: unknown }) =>
    Promise<{ state: string; commandId?: string; wrote?: readonly { id: string; rev: number }[] }>,
  requestKey: string,
  specs: readonly GardeningCommandSpec[],
  onNotDone: () => never,
): Promise<{ commandId?: string; wrote?: readonly { id: string; rev: number }[] }[]> {
  const receipts = [];
  for (const spec of specs) {
    const commandId = stableId('kb-gardening-command', requestKey, spec.commandKey);
    const receipt = await handle({
      actor: spec.actor, purpose: spec.purpose ?? 'storage', type: spec.type, id: commandId, input: spec.input,
    });
    if (receipt.state !== 'done') onNotDone();
    receipts.push({ ...receipt, commandId });
  }
  return receipts;
}

export async function readQuestionStateRev(tx: ReadTransaction, questionId: string): Promise<number | undefined> {
  const { rows: [row] } = await tx.query<{ rev: number }>(
    'SELECT current_rev AS rev FROM facts WHERE learner_id=$1 AND id=$2',
    [tx.learner, await questionStateId(factId(questionId))]);
  return row?.rev;
}

export function bindEffectiveSlotRead<T extends { slot: unknown }>(tx: ReadTransaction, base: T): T {
  return { ...base,
    slot: async (ref: SlotRef) => {
      const row = await readEffectiveDerivation(tx, { slotType: ref.type, slotKey: ref.key, requireCurrent: true });
      if (!row) return { id: derivationId('0'.repeat(26)), slot: ref, outcome: { kind: 'unknown' as const, reason: '当前核验槽尚无落定结果。' } };
      const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      const outcome = value?.kind === 'unknown' ? { kind: 'unknown' as const, reason: String(value.reason ?? '') }
        : { kind: 'value' as const, value: value?.value ?? value };
      return { id: row.id, slot: ref, outcome };
    } };
}
