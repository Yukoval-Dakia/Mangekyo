import {
  createCommandReadContext, derivationId, type DbTransaction, FactNotFoundError, FactReadDeniedError,
  parseManifest, revalidateManifest, type DerivationId, type FactId, type ReadTransaction, type Tick,
} from '@mangekyo/kernel';
import {
  readAnyRetentionMethod, type RetentionForecast, type RetentionObservation, type RetentionTarget,
} from '@mangekyo/module-learner/facts/retention';
import { posttestAttemptFor, posttestIdFor } from './retention-host-support.ts';
import {
  posttestOpensAt, posttestSubmissionType, workbookRetentionTarget, type RetentionWindow,
} from './retention-posttest.ts';
import {
  findWorkbookRetentionSlot as findSlot, listWorkbookPosttestSlots, recordedWorkbookForecast,
  validWorkbookMethod, verifiesOriginalSitting, verifyFrozenWorkbookClaims, workbookEvidenceWatermark,
  type PosttestListItem, type SlotRow,
} from './retention-history.ts';
import { throughTick, validatesWorkbookHistory } from './evidence-read.ts';
import { sameWorkbookJson, type WorkbookPaper } from './workbook-values.ts';
export type OpenedRetentionTarget = {
  paper: WorkbookPaper;
  target: ReturnType<typeof workbookRetentionTarget>;
  question: any;
  source: any;
  accessEpoch: Tick;
  sealed: boolean;
};
export type StudioRetentionFail = (status: number, message: string) => never;
export type ForecastScope = {
  target: RetentionTarget;
  method?: string;
  paperEpoch: Tick;
  evidenceThrough?: Tick;
  priorAttemptIds: FactId[];
  window: RetentionForecast['input']['window'];
  sourceReconciliationKey?: string;
};
export type StudioRetentionDeps = {
  readonly retentionPurpose: string;
  readonly forecastSlotType: string;
  readonly reconciliationSlotType: string;
  readonly forecastUnavailable: string;
  readonly fail: StudioRetentionFail;
  readonly isRequestError: (error: unknown) => boolean;
  readonly isFactNotFound: (error: unknown) => boolean;
  readonly isFactReadDenied: (error: unknown) => boolean;
  readonly stableId: (...parts: string[]) => string;
  readonly canonicalJsonString: (value: unknown) => string;
  readonly reconciliationSlotKey: (input: { reconciliationId: string }) => string;
  readonly openRetentionTarget: (tx: ReadTransaction, read: ReturnType<typeof createCommandReadContext>, paper: unknown, itemId: string) => Promise<OpenedRetentionTarget>;
  readonly readWorkbookObservation: (tx: ReadTransaction, read: ReturnType<typeof createCommandReadContext>, opened: any, attemptId: FactId, forecastId?: DerivationId) => Promise<any>;
  readonly readComparableWorkbookEvidence: (tx: ReadTransaction, read: ReturnType<typeof createCommandReadContext>, opened: any, attemptId: FactId, cutoff: Tick) => Promise<any>;
  readonly requireFreshVariant: (tx: ReadTransaction, target: RetentionTarget, cutoff: Tick, issuance?: FactId) => Promise<void>;
  readonly againstFrozenTarget: (observation: any, target: RetentionTarget) => RetentionObservation;
  readonly afterFreeze: (observation: any, window: RetentionWindow, effectiveTick: Tick, fail: StudioRetentionFail) => void;
  readonly enqueueWork: (tx: DbTransaction, slotType: string, slotKey: string, scopeKeys: unknown) => Promise<void>;
};
export async function retentionHistoryValid(deps: StudioRetentionDeps, tx: ReadTransaction, id: DerivationId,
  observation?: RetentionObservation) {
  const row = await recordedWorkbookForecast(tx, deps.forecastSlotType, id);
  if (!row || !validWorkbookMethod(row.forecast, readAnyRetentionMethod)) return false;
  const { input } = row.forecast;
  if (!await validatesWorkbookHistory(tx, input.target, observation?.admittedAt ?? row.effective_tick, posttestIdFor(id),
    observation?.exposure.kind === 'independent')) return false;
  const read = createCommandReadContext(tx, deps.retentionPurpose);
  const unavailable = (error: unknown) => deps.isRequestError(error) ||
    deps.isFactReadDenied(error) || deps.isFactNotFound(error) ||
    error instanceof FactReadDeniedError || error instanceof FactNotFoundError;
  if (observation?.exposure.kind === 'exposed') {
    try {
      const opened = await deps.openRetentionTarget(tx, read, input.target.paper.id, input.target.itemId);
      const actual = await deps.readWorkbookObservation(tx, read, opened, observation.submission.id, id);
      if (actual.submission.rev !== observation.submission.rev || actual.admittedAt !== observation.admittedAt ||
          actual.exposure.kind !== 'exposed' || !sameWorkbookJson(actual.exposure.refs, observation.exposure.refs)) return false;
    } catch (error) {
      if (unavailable(error)) return false;
      throw error;
    }
  }
  return verifyFrozenWorkbookClaims(tx, row, read, parseManifest(row.manifest).inputs,
    async (readInner, cutoff) => {
      const target = await deps.openRetentionTarget(tx, readInner, input.target.paper.id, input.target.itemId);
      if (target.target.paper.rev !== input.target.paper.rev || target.target.gradingVersion !== input.target.gradingVersion) return;
      return async (attemptId: FactId) => {
        const found = await deps.readComparableWorkbookEvidence(tx, readInner, target, attemptId, cutoff);
        const valid = await verifiesOriginalSitting(tx, deps.forecastSlotType, found.evidence,
          readAnyRetentionMethod, posttestIdFor, posttestAttemptFor);
        return valid ? found : undefined;
      };
    }, unavailable);
}
export async function projectRetentionSlot<T, S>(
  deps: StudioRetentionDeps, tx: ReadTransaction, key: string, row: SlotRow<T, S>) {
  if (row.current_id && row.effective_tick && row.value?.kind === 'value') {
    const manifest = parseManifest(row.manifest);
    const verdict = await revalidateManifest(tx, manifest, deps.retentionPurpose);
    const value = row.value.value as T;
    if (verdict.kind === 'valid' && (value && typeof value === 'object' && 'observation' in value
      ? await retentionHistoryValid(deps, tx, (value as unknown as { forecastId: DerivationId }).forecastId,
          (value as unknown as { observation?: RetentionObservation }).observation)
      : await retentionHistoryValid(deps, tx, derivationId(row.current_id)))) {
      return { key, state: 'current' as const, derivationId: derivationId(row.current_id),
        effectiveTick: row.effective_tick, freshness: verdict.freshness, value, basis: manifest };
    }
    return { key, state: 'stale' as const, reason: deps.forecastUnavailable };
  }
  if (row.last_id) return { key, state: 'stale' as const, reason: deps.forecastUnavailable };
  if (row.last_error) return { key, state: 'blocked' as const, reason: row.last_error.reason };
  return { key, state: 'pending' as const };
}
export function sameRetentionTarget(deps: StudioRetentionDeps,
  actual: { target: Record<string, unknown>; accessEpoch: unknown }, expected: { target: { condition?: unknown } & Record<string, unknown>; paperEpoch: unknown }) {
  if (deps.canonicalJsonString({ ...actual.target, condition: expected.target.condition }) !== deps.canonicalJsonString(expected.target) ||
      actual.accessEpoch !== expected.paperEpoch) {
    deps.fail(409, deps.forecastUnavailable);
  }
}
export function retentionReconciliationKeyFor(deps: StudioRetentionDeps, forecast: DerivationId, attempt: FactId) {
  return deps.reconciliationSlotKey({ reconciliationId: deps.stableId('retention-reconcile', forecast, attempt) });
}
export function isRetentionSlot(deps: StudioRetentionDeps, type: string) {
  return type === deps.forecastSlotType || type === deps.reconciliationSlotType;
}
export async function currentRetentionForecast(deps: StudioRetentionDeps, tx: ReadTransaction, key: string) {
  const row = await findSlot<RetentionForecast, ForecastScope>(tx, deps.forecastSlotType, key);
  if (!row) deps.fail(404, '找不到保持预测。');
  const frozen = await projectRetentionSlot(deps, tx, key, row!);
  if (frozen.state !== 'current') deps.fail(409, '预测当前没有可用的冻结版本。');
  const read = createCommandReadContext(tx, deps.retentionPurpose);
  const { target, window, sourceReconciliationKey } = row!.scope_keys;
  if (sourceReconciliationKey) await currentRetentionReconciliation(deps, tx, sourceReconciliationKey);
  const opened = await deps.openRetentionTarget(tx, read, target.paper.id, target.itemId);
  sameRetentionTarget(deps, opened, row!.scope_keys);
  return { frozen, read, window, opened, sourceReconciliationKey };
}
export async function currentRetentionReconciliation(deps: StudioRetentionDeps, tx: ReadTransaction, key: string) {
  const source = await findSlot<unknown, { forecastKey: string; forecastId: DerivationId; attemptId: FactId }>(
    tx, deps.reconciliationSlotType, key);
  if (!source) deps.fail(404, '找不到原后测对账记录。');
  const current = await projectRetentionSlot(deps, tx, key, source!);
  if (current.state !== 'current') deps.fail(409, '原后测当前没有可用的对账记录。');
  return source!.scope_keys;
}
export async function getRetentionSlot(deps: StudioRetentionDeps, tx: ReadTransaction, key: string) {
  const forecast = await findSlot<RetentionForecast, ForecastScope>(tx, deps.forecastSlotType, key);
  if (forecast) return { slot: deps.forecastSlotType, ...await projectRetentionSlot(deps, tx, key, forecast) };
  const reconciliation = await findSlot<unknown, { forecastKey: string; forecastId: DerivationId; attemptId: FactId }>(
    tx, deps.reconciliationSlotType, key);
  if (reconciliation) return { slot: deps.reconciliationSlotType, ...await projectRetentionSlot(deps, tx, key, reconciliation) };
  deps.fail(404, '找不到保持预测或对账记录。');
}
export async function listRetentionPosttests(deps: StudioRetentionDeps, tx: ReadTransaction, selected: string | null = null) {
  const readRows = (forecastKey: string | null, parent: string | null) =>
    listWorkbookPosttestSlots<ForecastScope>(tx, deps.forecastSlotType, forecastKey, parent);
  const initial = await readRows(selected, null);
  const rows = [...initial.rows];
  const now = new Date().toISOString();
  const items: PosttestListItem[] = [];
  for (const { slot_key: forecastKey, scope_keys: scheduled, current_id: currentId } of rows) {
    try {
      if (!currentId) {
        const { target, sourceReconciliationKey, window: { scheduledAt, through } } = scheduled;
        if (!sourceReconciliationKey || !scheduledAt || through <= now) continue;
        await currentRetentionReconciliation(deps, tx, sourceReconciliationKey);
        const read = createCommandReadContext(tx, deps.retentionPurpose);
        const opened = await deps.openRetentionTarget(tx, read, target.paper.id, target.itemId);
        sameRetentionTarget(deps, opened, scheduled);
        items.push({ forecastKey, title: opened.paper.title, through, scheduledAt, sourceReconciliationKey, state: 'preparing' });
        continue;
      }
      const { frozen, opened, window, sourceReconciliationKey } = await currentRetentionForecast(deps, tx, forecastKey);
      const read = createCommandReadContext(tx, deps.retentionPurpose);
      const { scheduledAt, through } = window;
      const entry = { forecastKey, title: opened.paper.title, through, ...(scheduledAt ? { scheduledAt } : {}),
        ...(sourceReconciliationKey ? { sourceReconciliationKey } : {}) };
      const attemptId = posttestAttemptFor(posttestIdFor(frozen.derivationId));
      try {
        const attempt = await read.fact(attemptId, { mode: 'following' });
        if (attempt.type === posttestSubmissionType) {
          const reconciliationKey = retentionReconciliationKeyFor(deps, frozen.derivationId, attemptId);
          items.push({ ...entry, state: 'submitted', reconciliationKey });
          if (forecastKey === selected) {
            const followups = await readRows(null, reconciliationKey);
            rows.push(...followups.rows.filter(child => child.slot_key !== selected));
          }
        }
      } catch (error) {
        if (!(deps.isFactNotFound(error) || error instanceof FactNotFoundError)) throw error;
        await deps.requireFreshVariant(tx, frozen.value.input.target, await workbookEvidenceWatermark(tx), posttestIdFor(frozen.derivationId));
        if (scheduledAt && now < scheduledAt) items.push({ ...entry, state: 'scheduled', scheduledAt });
        else if (posttestOpensAt(window) <= now && now < through) items.push({ ...entry, state: 'ready' });
      }
    } catch (error) {
      if (!(deps.isFactReadDenied(error) || deps.isFactNotFound(error) || deps.isRequestError(error) ||
          error instanceof FactReadDeniedError || error instanceof FactNotFoundError)) throw error;
    }
  }
  return { items };
}
export async function reconcileRetentionAttempt(deps: StudioRetentionDeps, tx: DbTransaction,
  current: Awaited<ReturnType<typeof currentRetentionForecast>>, attemptId: FactId) {
  const { frozen, read, window, opened } = current;
  if (frozen.state !== 'current') deps.fail(409, deps.forecastUnavailable);
  const observation = deps.againstFrozenTarget(
    await deps.readWorkbookObservation(tx, read, opened, attemptId, (frozen as { derivationId: DerivationId }).derivationId),
    (frozen as { value: RetentionForecast }).value.input.target);
  const frozenDerivation = frozen as { derivationId: DerivationId; effectiveTick: Tick; key: string };
  deps.afterFreeze(observation, window, frozen.effectiveTick, deps.fail);
  if (!await retentionHistoryValid(deps, tx, frozenDerivation.derivationId, observation)) deps.fail(409, deps.forecastUnavailable);
  const key = retentionReconciliationKeyFor(deps, frozenDerivation.derivationId, attemptId);
  const existing = await findSlot<unknown, { forecastKey: string; forecastId: DerivationId; attemptId: FactId }>(
    tx, deps.reconciliationSlotType, key);
  if (existing) {
    const latest = await projectRetentionSlot(deps, tx, key, existing);
    if (existing.pending !== 'none') return { key, state: 'pending' as const };
    if (latest.state === 'current' &&
        deps.canonicalJsonString((latest.value as { observation?: unknown }).observation) === deps.canonicalJsonString(observation)) return latest;
  }
  await deps.enqueueWork(tx, deps.reconciliationSlotType, key,
    { forecastKey: frozenDerivation.key, forecastId: frozenDerivation.derivationId, attemptId });
  return { key, state: 'pending' as const };
}
export async function authorizedRetention<T>(deps: StudioRetentionDeps, run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (deps.isFactNotFound(error) || error instanceof FactNotFoundError) deps.fail(404, '找不到保持预测的依据。');
    if (deps.isFactReadDenied(error) || error instanceof FactReadDeniedError) deps.fail(403, '保持预测的依据当前未开放教学用途。');
    throw error;
  }
}
