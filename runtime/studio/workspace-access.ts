import { randomUUID } from 'node:crypto';
import { defaultStored, normalizeStored, providerIdentifier, providerViews, type StoredRoute } from '../../executors/teaching/workspace-provider-grants.ts';
export { workspaceGrantRevision, type WorkspaceProviderView } from '../../executors/teaching/workspace-provider-grants.ts';
import type { SqlValue } from '../../kernel/src/db/types.ts';
import {
  commandId, createCommandReadContext, factId, isFactNotFound, isFactReadDenied, isFactUnavailable, mapKernelError,
  readFactCommandBirth, type CommandHooks, type Db, type FactId, type FactSnapshot, type Json, type ReadTransaction,
} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { carryRubricAssessments } from '../../modules/activity/learning-attempt-read.ts';
import { materialType } from '../../modules/activity/library-values.ts';
import { sourceRefV1 } from '../../modules/activity/source-values.ts';
import { studyRecordType } from '../../modules/activity/values.ts';
import { readFrozenWorkbookRecord } from '../../modules/activity/workbook-bank.ts';
import { workbookPresentationType } from '../../modules/activity/workbook-presentation.ts';
import { WorkbookSourceMismatch } from '../../modules/activity/workbook-values.ts';
import { allowedTypes, categories, encodeCursor, itemOf, purposesOf, workspaceCatalogPage, workspaceCatalogQuery, WorkspaceCatalogInputError, workspaceRecordPage, type AccessDisplay, type AccessRow } from '../../modules/activity/workspace-catalog.ts';
import { activityQuestions } from '../../modules/activity/workspace-projection.ts';
import { displayOf } from '../../modules/activity/workspace-source-projection.ts';
export { displayOf } from '../../modules/activity/workspace-source-projection.ts';
import { setWorkspaceTeachingCommand, validateWorkspaceTeachingRequest, workspaceEntryType, WorkspaceInputError, workspaceTeachingUse } from '../../modules/activity/workspace-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { knowledgeEdgeEvidenceType, knowledgeEdgeType } from '../../modules/content/knowledge-edge.ts';
import { textbookPageType } from '../../modules/content/textbook-page.ts';
import { assetType, buildUpdatedRouteEntry, buildWorkspaceTeachingCommand, isPlainObject, lookupTeachingFailure, parseAdvancedWorkspaceListParams, projectWorkspacePreview, ulidFactPattern, validateRouteGrantInput, type TeachingFailureReason } from '../../modules/content/workspace-slice.ts';
import { goalType } from '../../modules/plan/goal-values.ts';
import { organizerTaskType } from '../../modules/plan/organizer-task-values.ts';
import { summarizeRecordFlowForList } from '../../modules/learner/record-flow.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { modelRecipientId, sourceId, stableId, studioHost, studioLearner, ulidExact } from './identity.ts';
import { openKnowledgeEdge, openKnowledgeEdgeEvidence } from './knowledge-graph.ts';
import { confirmNotionRead, type CheckNotionRead } from './notion.ts';
import { materialIntakeLink } from './reading.ts';
import { loadRecordFlowSnapshot, readWorkspaceRecordFlow } from './record-flow.ts';
import { RequestError } from './sessions.ts';
import { loadSettings, readWorkspaceAccess, saveSettings, writeWorkspaceAccess } from './settings.ts';
import { resolveSource } from './source-read.ts';
import { workspaceQuery } from './workspace-read.ts';
import { lexicalWorkspaceSql, trigramFunction } from './workspace-search.ts';
export const syntheticStudyRecords = new Set<string>([
  sourceId('independent', 'work-01'), sourceId('independent', 'work-02'),
  sourceId('workedExample', 'work-01'), sourceId('workedExample', 'work-02'),
]);
const categoryList = categories.map(({ id, label }) => ({ id, label }));
const teachingFailure = (reason: TeachingFailureReason) => { const [status, message] = lookupTeachingFailure(reason); return new RequestError(status, message); };
const requireFactId = (value: string): FactId => { if (!ulidFactPattern.test(value)) throw new RequestError(404, '找不到这条学习记录。'); return factId(value); };
const catalogInput = <T>(parse: (params: URLSearchParams) => T, params: URLSearchParams): T => {
  try { return parse(params); } catch (error) { if (error instanceof WorkspaceCatalogInputError) throw new RequestError(400, error.message); throw error; }
};
async function resolveLearnerSources(
  tx: ReadTransaction, target: unknown, check: CheckNotionRead, track?: (fact: FactSnapshot) => void,
) {
  const sources: FactSnapshot[] = [];
  const res = await resolveSource(tx, target, { recipient: 'learner', track(fact) { sources.push(fact); track?.(fact); } });
  if (!res) return;
  for (const fact of sources) await check(fact);
  return res;
}
async function readDisplay(tx: ReadTransaction, row: AccessRow, check: CheckNotionRead): Promise<AccessDisplay | null> {
  const purposes = purposesOf(row.purpose), purpose = purposes[0];
  if (!purpose) return null;
  try {
    const read = createCommandReadContext(tx, purpose), snapshot = await read.fact(factId(row.id), { mode: 'following' }), inputs: FactSnapshot[] = [];
    await readFrozenWorkbookRecord(read, snapshot, fact => inputs.push(fact));
    for (const input of inputs) await check(input);
    if ((row.type === workspaceEntryType || row.type === textbookPageType) && !await resolveLearnerSources(tx, snapshot.ref.id, check)) return null;
    return { display: displayOf(row.type, snapshot.value), purposes, fact: snapshot };
  } catch (error) { if (isFactUnavailable(error) || error instanceof WorkbookSourceMismatch) return null; throw error; }
}
async function currentRow(tx: ReadTransaction, id: FactId): Promise<AccessRow | null> {
  const { rows: [row] } = await tx.query<AccessRow>(
    `SELECT f.id, f.type, f.current_rev, f.purpose, f.created_tick, born.author FROM facts f
     JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
     JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
     WHERE f.learner_id=$1 AND f.id=$2 AND f.retracted_rev IS NULL`, [tx.learner, id]);
  return row ?? null;
}
function translate(error: unknown): Error {
  if (error instanceof RequestError) return error;
  if (isFactNotFound(error)) return new RequestError(404, '找不到这条学习记录。');
  if (isFactReadDenied(error)) return new RequestError(403, '这条学习记录当前不可读取。');
  return mapKernelError<Error>(error, {
    unknown_command: () => new RequestError(503, '当前服务还不支持开放学习记录。'),
    duplicate_command: () => new RequestError(409, '同一个请求已经用于不同内容。'),
    revision_conflict: () => new RequestError(409, '这条记录已在别处更新。请刷新后再试。'),
    not_found: () => new RequestError(404, '找不到这条学习记录。'),
    retracted: () => new RequestError(409, '这条记录已经撤回。'),
    otherwise: () => new RequestError(400, '学习记录设置未能完成。'),
  });
}
export async function loadWorkspaceAccessRoutes(): Promise<Readonly<Record<string, StoredRoute>>> { return (await readWorkspaceAccess()).routes; }
export async function notionTeachingRecipients() {
  const [settings, stored] = await Promise.all([loadSettings(), readWorkspaceAccess()]);
  return providerViews(settings, stored).filter(view => view.authorized).map(p => ({
    id: modelRecipientId({ providerId: p.id, baseUrl: p.baseUrl, protocol: p.protocol, model: p.model }, stored.routes[p.id]!.revision),
    purpose: 'teaching', label: `${p.label} · ${p.model} · ${p.baseUrl}`,
  }));
}
export function openWorkspaceAccess(db: Db, activity: LoadedModule, content: LoadedModule,
  capture: LoadedModule, plan: LoadedModule, onResearchChanged?: CommandHooks['onFactsChanged']) {
  const host = studioHost(db);
  const handle = host.boundHandler([activity, content, capture, plan], createStudioCommandHooks({ async afterFactsChanged(tx, tick, changes) {
    await carryRubricAssessments(tx, tick, changes);
    await onResearchChanged?.(tx, tick, changes);
  } }), undefined, { crossModuleWrites: { [setWorkspaceTeachingCommand]: { set_purpose: [materialType, intakeFactType, goalType, organizerTaskType] } } });
  const providerList = async () => {
    const [settings, stored] = await Promise.all([loadSettings(), readWorkspaceAccess()]);
    return { activeProviderId: settings.activeProviderId, providers: providerViews(settings, stored) };
  };
  return {
    categories: categoryList,
    providers: providerList,
    async undoObservation(id: string, input: Record<string, unknown>) {
      const token = input.undo_token;
      if (typeof token !== 'string' || !ulidFactPattern.test(token)) throw new RequestError(400, '撤回凭据无效。');
      const born = ulidExact.test(id) && await readFactCommandBirth(db, studioLearner, factId(id), {
        rev: 1, commandId: commandId(token), commandTypes: ['activity.saveWorkspaceEntry'], author: 'companion',
      });
      if (!born || (born.data as { kind?: unknown })?.kind !== 'observation') throw new RequestError(404, '找不到可撤回的观察。');
      try {
        const ref = (await handle({ purpose: 'storage', id: commandId(stableId('withdraw-workspace-observation', token)), type: 'activity.withdrawWorkspaceObservation', input: { id } })).wrote[0];
        if (!ref) throw new RequestError(500, '撤回命令没有返回修订。');
        return { status: 'withdrawn', ref: { id: ref.id, rev: ref.rev } };
      } catch (error) { if (error instanceof WorkspaceInputError || isFactReadDenied(error)) throw new RequestError(409, '观察版本已变化。'); throw error; }
    },
    async list(params: URLSearchParams) {
      const advancedArgs = parseAdvancedWorkspaceListParams(params);
      if (advancedArgs) {
        const result = await host.snapshot(tx => workspaceQuery(tx, advancedArgs, { recipient: 'learner' }));
        if (!result) throw new RequestError(404, '找不到可读取的记录。');
        if ('error' in result) throw new RequestError(400, result.error);
        return { ...result, items: result.results };
      }
      const { limit, cursor, kind, query, types } = catalogInput(workspaceCatalogQuery, params);
      const [result, providers] = await Promise.all([
        confirmNotionRead(db, studioLearner, async (tx, check) => {
          const where = ['f.learner_id=$1', 'f.retracted_rev IS NULL', 'f.type = ANY($2::text[])', 'NOT (f.type=$3 AND f.id = ANY($4::text[]))'];
          const values: SqlValue[] = [tx.learner, types, studyRecordType, [...syntheticStudyRecords]];
          if (kind) { values.push([workspaceEntryType, assetType], kind); where.push(`f.type = ANY($5::text[]) AND r.data->>'kind'=$6`); }
          const trigram = query ? await trigramFunction(tx) : undefined;
          if (query) { values.push(query); const { fts, score } = lexicalWorkspaceSql(values.length, trigram); where.push(`(${fts} OR ${score}>=0.45)`); }
          if (cursor) { values.push(cursor.tick, cursor.id); where.push(`(f.created_tick, f.id) < ($${values.length - 1}::bigint, $${values.length}::text)`); }
          values.push(limit + 1);
          const { rows } = await tx.query<AccessRow>(
            `SELECT f.id, f.type, f.current_rev, f.purpose, f.created_tick, born.author FROM facts f
             JOIN fact_revs r ON r.learner_id=f.learner_id AND r.fact_id=f.id AND r.rev=f.current_rev
             JOIN fact_revs born ON born.learner_id=f.learner_id AND born.fact_id=f.id AND born.rev=1
             WHERE ${where.join(' AND ')} ORDER BY f.created_tick DESC, f.id DESC LIMIT $${values.length}`, values);
          const visible: { row: AccessRow; read: AccessDisplay }[] = [];
          for (const row of rows.slice(0, limit)) { const read = await readDisplay(tx, row, check); if (read) visible.push({ row, read }); }
          const flowSummaries = visible.length ? summarizeRecordFlowForList(visible.map(v => v.row.id), await loadRecordFlowSnapshot(tx, syntheticStudyRecords)) : {};
          return { rows: visible, flowSummaries, last: rows.slice(0, limit).at(-1), hasMore: rows.length > limit, trigramUnavailable: Boolean(query && !trigram) };
        }),
        providerList(),
      ]);
      return {
        items: result.rows.map(({ row, read }) => ({ ...itemOf(row, read), ...result.flowSummaries[row.id] })), unappliedFilters: [],
        ...(result.trigramUnavailable ? { retrievalWarnings: ['pg_trgm_unavailable'] } : {}),
        nextCursor: result.hasMore && result.last ? encodeCursor(result.last) : null, categories: categoryList, ...providers,
      };
    },
    async flow(id: string) {
      const flow = await host.snapshot(tx => readWorkspaceRecordFlow(tx, requireFactId(id), syntheticStudyRecords));
      if (!flow) throw new RequestError(404, '找不到这条学习记录。');
      return flow;
    },
    async record(id: string, params: URLSearchParams) {
      const itemId = requireFactId(id), rawRef = params.get('ref');
      if (rawRef !== null) {
        let input: unknown;
        try { input = JSON.parse(rawRef); } catch { throw new RequestError(400, '工作区版本引用无效。'); }
        const ref = sourceRefV1(input);
        if (ref?.fact.id !== itemId) throw new RequestError(400, '工作区版本引用无效。');
        const record = await confirmNotionRead(db, studioLearner, async (tx, check) => {
          if (ref.fact.type === knowledgeEdgeType) return (await openKnowledgeEdge(tx, ref, { recipient: 'learner' }))?.value;
          if (ref.fact.type === knowledgeEdgeEvidenceType) return openKnowledgeEdgeEvidence(tx, ref, { recipient: 'learner' });
          let root: FactSnapshot | undefined;
          const source = await resolveLearnerSources(tx, ref, check, fact => {
            if (fact.ref.id === ref.fact.id && fact.ref.rev === ref.fact.rev) root = fact;
          });
          if (!source) return;
          if (params.get('view') !== 'preview') return source;
          const prompt = root && ref.anchor.kind === 'whole' ? activityQuestions(root)?.map(({ prompt: p }) => p).join('\n\n') : undefined;
          return projectWorkspacePreview(source, ref.anchor.kind, prompt);
        }).catch(error => { if (!isFactReadDenied(error)) throw error; });
        if (!record) throw new RequestError(404, '找不到可读取的版本。');
        return record;
      }
      const { offset, limit } = catalogInput(workspaceCatalogPage, params);
      return confirmNotionRead(db, studioLearner, async (tx, check) => {
        const row = await currentRow(tx, itemId);
        if (!row || !allowedTypes.has(row.type) || (row.type === studyRecordType && syntheticStudyRecords.has(row.id))) throw new RequestError(404, '找不到这条学习记录。');
        const read = await readDisplay(tx, row, check);
        if (!read) throw new RequestError(403, '这条学习记录当前不可读取。');
        const page = workspaceRecordPage(row, read, offset, limit), related: { id: string; title: string }[] = [];
        for (const linkedId of read.display.links ?? []) {
          const linked = await currentRow(tx, factId(linkedId));
          if (!linked || !allowedTypes.has(linked.type) || syntheticStudyRecords.has(linkedId)) continue;
          const target = await readDisplay(tx, linked, check);
          if (target) related.push({ id: linkedId, title: target.display.title });
        }
        return { ...page, related };
      });
    },
    async setTeaching(id: string, input: unknown): Promise<{ id: string; rev: number; teaching: boolean; research?: boolean; changed: boolean }> {
      const itemId = requireFactId(id), requested = workspaceTeachingUse(input);
      if (!requested.ok) throw teachingFailure(requested.reason);
      const { use, expectedRev, enabled } = requested;
      const { row, link } = await host.snapshot(async tx => {
        const current = await currentRow(tx, itemId);
        return { row: current, link: use === 'teaching' && current?.type === materialType ? await materialIntakeLink(tx, itemId) : undefined };
      });
      if (!row) throw new RequestError(404, '找不到这条学习记录。');
      const checked = validateWorkspaceTeachingRequest({
        row, allowedType: (allowedTypes.has(row.type) && row.type !== assetType) || row.type === workbookPresentationType,
        synthetic: row.type === studyRecordType && syntheticStudyRecords.has(row.id), purposes: purposesOf(row.purpose), use, expectedRev, enabled, link,
      });
      if (!checked.ok) throw teachingFailure(checked.reason);
      if (!checked.changed) return { ...checked, changed: false };
      const { purpose, flags, row: current } = checked;
      const spec = buildWorkspaceTeachingCommand(current.type, use, itemId, expectedRev, enabled, setWorkspaceTeachingCommand, link?.id);
      try {
        const receipt = await handle({ purpose, type: spec.type, id: commandId(stableId('workspace-' + use, itemId, String(expectedRev), String(enabled))), input: spec.input as Json });
        const ref = receipt.wrote.find(written => written.id === current.id);
        if (!ref && !(link && receipt.wrote.some(written => written.id === link.id))) throw new RequestError(500, '这次设置没有返回记录。');
        return { id: current.id, rev: ref?.rev ?? current.current_rev, ...flags, changed: true };
      } catch (error) { throw translate(error); }
    },
    setProvider(id: string, input: unknown) {
      if (!providerIdentifier.test(id)) throw new RequestError(400, '模型配置无效。');
      return host.lockedTx(async () => {
        const parsed = validateRouteGrantInput({ ...(isPlainObject(input) ? input : {}), id }, providerIdentifier);
        if (!parsed.ok) throw new RequestError(400, parsed.message);
        let settings = await loadSettings(), provider = settings.providers.find(entry => entry.id === parsed.id);
        if (!provider) throw new RequestError(404, '找不到这个模型配置。');
        if (parsed.enabled && (parsed.baseUrl !== provider.baseUrl || parsed.protocol !== provider.protocol)) throw new RequestError(409, '模型端点或协议已变化，请重新确认授权。');
        if (parsed.enabled && !provider.credentialRevision) { await saveSettings({}); settings = await loadSettings(); provider = settings.providers.find(entry => entry.id === parsed.id)!; }
        const stored = await readWorkspaceAccess();
        stored.routes[provider.id] = buildUpdatedRouteEntry(stored.routes[provider.id], provider, parsed.enabled, randomUUID());
        await writeWorkspaceAccess(stored);
        return { providers: providerViews(settings, stored) };
      });
    },
  };
}
