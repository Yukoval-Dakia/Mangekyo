import type { IncomingMessage, ServerResponse } from 'node:http';
import { isFactUnavailable, type Db, type DbTransaction, type FactSnapshot, type Json, type ReadTransaction } from '../../kernel/src/index.ts';
import { EffectIdentityMismatch, runEffect } from '../../kernel/src/work/effects.ts';
import { AuthoringError } from '../../executors/teaching/background-llm.ts';
import type { ModelTask } from '../../executors/teaching/model-routes.ts';
import { TeachingError } from '../../executors/teaching/provider.ts';
import { workspaceGrantRevision } from '../../executors/teaching/workspace-provider-grants.ts';
import { AssetBasisError } from '../../modules/content/asset.ts';
import { QuestionAuthoringError } from '../../modules/content/question-authoring.ts';
import { TextbookAuthoringNotFoundError, TextbookAuthoringValidationError } from '../../modules/content/textbook-authoring.ts';
import { captureSourceType } from '../../modules/capture/source.ts';
import { submittedWatermark } from '../../modules/capture/request.ts';
import { modelRecipientId, stableId, studioHost, studioLearner } from './identity.ts';
import { confirmNotionDispatch, notionRecipient, notionSendBasis, type NotionRecipient } from './notion.ts';
import { loadSettings, readWorkspaceAccess } from './settings.ts';
import { RequestError } from './sessions.ts';
export type Settings = Awaited<ReturnType<typeof loadSettings>>;
export type ProviderResolution = { readonly provider: Settings; readonly workspaceRevision: string; readonly maySend: NotionRecipient };
/**
 * The production default path (no injected `loadProvider`) always requires the active provider route to be
 * explicitly authorized in `workspace-access.json`: foreground callers get a fail-closed 403, background
 * maintenance silently skips the paid send. Test-injected providers keep their historical shape and never
 * widen authorization; they still receive a structured (but grant-less) `maySend` recipient.
 */
export async function resolveAuthorizedProvider(options: {
  task?: ModelTask; background?: boolean; loadProvider?: (() => Promise<Settings | null>) | undefined;
} = {}): Promise<ProviderResolution | undefined> {
  const missing = () => new RequestError(503, '尚未配置可用的 AI 模型，请先前往设置配置模型。', 'model_unavailable');
  if (options.loadProvider) {
    const injected = await options.loadProvider().catch(() => undefined);
    if (!injected?.baseUrl?.trim()) {
      if (options.background) return undefined;
      throw missing();
    }
    return { provider: injected, workspaceRevision: '', maySend: notionRecipient(undefined) };
  }
  const settings = await loadSettings(options.task).catch(() => undefined);
  const active = settings?.providers.find(profile => profile.id === settings.activeProviderId);
  if (!settings || !active?.baseUrl?.trim()) {
    if (options.background) return undefined;
    throw missing();
  }
  let revision: string | undefined;
  try { revision = workspaceGrantRevision((await readWorkspaceAccess()).routes, active); } catch { revision = undefined; }
  if (!revision) {
    if (options.background) return undefined;
    throw new RequestError(403, '此模型尚未获准访问学习记录，请先在设置中授权。', 'provider_not_authorized');
  }
  return { provider: settings, workspaceRevision: revision, maySend: notionRecipient(modelRecipientId(settings, revision)) };
}
/** Fail-closed second verification plus remote confirmation before any snapshot leaves for an external model. */
export async function confirmAuthorizedNotionDispatch(
  db: Db, tx: ReadTransaction, facts: Iterable<FactSnapshot>, maySend: NotionRecipient, readPurpose = 'teaching',
  learner: typeof studioLearner = studioLearner, authorize?: (tx: DbTransaction) => Promise<void>,
) {
  const witnesses = [];
  for (const fact of facts)
    if (fact.type === captureSourceType) witnesses.push({ id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type });
  await confirmNotionDispatch(db, await notionSendBasis(tx, witnesses, maySend, undefined, readPurpose), learner);
}
export function endpointEffectIdentity(scope: string, requestId: string, input: Json) {
  return { ownerId: stableId('studio-endpoint-effects'), stepKey: `${scope}:${requestId}`, label: scope, input };
}
/**
 * Idempotent pre-dispatch gate for expensive external model calls: a repeated `requestId` replays the durable
 * receipt, a conflicting payload is 409, an in-flight or unresolvable outcome never re-sends.
 */
export async function runEndpointEffect(
  db: Db,
  identity: { ownerId: string; stepKey: string; label: string; input: Json; learner?: typeof studioLearner },
  invoke: (providerEffectId: string, checkDispatch: (tx: DbTransaction) => Promise<void>) => Promise<Json>,
): Promise<Json> {
  const { learner = studioLearner, ...rest } = identity;
  const effect = await runEffect(db, { learner, ownerKind: 'session', ...rest }, invoke)
    .catch(error => {
      if (error instanceof EffectIdentityMismatch) throw new RequestError(409, '同一请求标识已用于不同的参数。', 'duplicate_request_conflict');
      throw error;
    });
  if (effect.kind === 'done') return effect.result;
  throw new RequestError(409, '上次请求结果未能确认，为避免重复扣费请更换请求标识。', 'effect_outcome_unknown');
}
/** Decode the durable endpoint result: a recorded failure sentinel becomes the stored client error. */
export function finishEndpointResult<T extends Record<string, unknown>>(result: Json): T {
  const outcome = result as { failed?: EndpointFailure } & T;
  if (outcome.failed) throw new RequestError(outcome.failed.status, outcome.failed.message, outcome.failed.code);
  return outcome;
}

/** Start the expensive call only after the dispatch claim is confirmed inside the learner lock. */
export function dispatchInLock<T, R>(
  db: Db,
  checkDispatch: (tx: DbTransaction) => Promise<void>,
  authorize: (tx: DbTransaction) => Promise<void>,
  invoke: () => Promise<T>,
  settle: (started: Promise<T>) => Promise<R>,
  learner?: typeof studioLearner,
): Promise<R> {
  return studioHost(db, learner ? { learner } : {}).startLockedEffect(async tx => {
    await checkDispatch(tx);
    await authorize(tx);
    const started = invoke();
    void started.catch(() => {});
    return { started };
  }, ({ started }) => settle(started as Promise<T>));
}
/**
 * The canonical paid-endpoint call shape: claim the dispatch inside the learner lock, re-confirm every Notion
 * witness of the snapshot before the transport starts, then run the model call with endpoint failure capture.
 */
export function confirmedEndpointCall<T>(
  db: Db, checkDispatch: (tx: DbTransaction) => Promise<void>, facts: Iterable<FactSnapshot>, maySend: NotionRecipient,
  invoke: () => Promise<T | undefined>, failure: { current?: EndpointFailure }, learner: typeof studioLearner = studioLearner,
  readPurpose = 'teaching', authorize?: (tx: DbTransaction) => Promise<void>,
): Promise<T | undefined> {
  const witnesses = [...facts].filter(fact => fact.type === captureSourceType)
    .map(fact => ({ id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type }));
  return studioHost(db, { learner }).snapshot(tx => notionSendBasis(tx, witnesses, maySend, undefined, readPurpose))
    .then(pages => confirmNotionDispatch(db, pages, learner))
    .then(() => dispatchInLock(db, checkDispatch, async tx => {
      await notionSendBasis(tx, witnesses, maySend, undefined, readPurpose);
      await authorize?.(tx);
    }, () => invokeEndpointModel(invoke, failure), async outcome => outcome, learner));
}
/** Common domain error mapping shared by the authoring endpoints. */
export function endpointError(error: unknown): RequestError | undefined {
  if (error instanceof AuthoringError) return new RequestError(error.status, error.message, error.code);
  if (error instanceof TeachingError) return new RequestError(error.code === 'provider_unavailable' ? 503 : 502, error.message, error.code);
  if (error instanceof TextbookAuthoringNotFoundError || error instanceof TextbookAuthoringValidationError)
    return new RequestError(error.status, error.message, error.code);
  if (error instanceof QuestionAuthoringError) return new RequestError(400, error.message, error.code);
  if (error instanceof AssetBasisError || isFactUnavailable(error)) return new RequestError(409, '引用的学习材料依据已变更或不可用。', 'basis_stale');
  return undefined;
}
/** Promise catch handler: rethrow the mapped endpoint error, or the original. */
export function rethrowEndpointError(error: unknown): never {
  const mapped = endpointError(error);
  if (mapped) throw mapped;
  throw error;
}
export type EndpointFailure = { status: number; message: string; code?: string };
/**
 * Run one external model call inside the dispatch lock: mapped endpoint errors become a structured failure
 * (replayable, never re-billed) instead of an exception; every other error still propagates as a crash.
 */
export async function invokeEndpointModel<T>(
  invoke: () => Promise<T | undefined>, failure: { current?: EndpointFailure },
): Promise<T | undefined> {
  try {
    return await invoke();
  } catch (error) {
    if (error instanceof TeachingError && ['model_unavailable', 'provider_unavailable', 'provider_configuration',
      'provider_timeout'].includes(error.code)) throw error;
    const mapped = endpointError(error);
    if (!mapped) throw error;
    if (['model_unavailable', 'provider_unavailable', 'provider_configuration', 'provider_timeout'].includes(mapped.responseCode ?? '')) throw mapped;
    failure.current = { status: mapped.status, message: mapped.message, ...(mapped.responseCode ? { code: mapped.responseCode } : {}) };
    return undefined;
  }
}
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new RequestError(415, '需要 JSON 请求。');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) { req.resume(); throw new RequestError(413, '请求内容过长。'); }
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new RequestError(400, '请求格式无效。'); }
}
export function sendJson(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}
export async function runAbortable(res: ServerResponse, run: (signal: AbortSignal) => Promise<unknown>, status = 200) {
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    const result = await run(controller.signal);
    if (!controller.signal.aborted) sendJson(res, status, result);
  } catch (error) { if (!controller.signal.aborted) throw error; }
}
const patternTypes: Record<string, string> = {
  ':ulid': '([0-9A-HJKMNP-TV-Z]{26})', ':slug': '([A-Za-z0-9][A-Za-z0-9_-]{0,79})',
  ':item': '([A-Za-z0-9_.-]{1,128})', ':seg': '([^/]+)',
};
export function compilePattern(path: string) {
  const regex = new RegExp(`^${path.replaceAll('/', '\\/').replaceAll(/:(ulid|slug|item|seg)/g, t => patternTypes[t]!)}$`);
  return { regex, match: (value: string) => regex.exec(value)?.slice(1) };
}
export type RouteAction = (req: IncomingMessage, res: ServerResponse, params: readonly string[], url: URL) => Promise<void>;
export type CompiledRoute = { readonly method: string; readonly match: (path: string) => string[] | undefined; readonly action: RouteAction };
export type StudioRouteKit = ReturnType<typeof createStudioRouteKit>;
export type RoutePack = (kit: StudioRouteKit) => void;
export const mountRoutePack = (kit: StudioRouteKit, pack: RoutePack) => pack(kit);
export function createStudioRouteKit(routes: CompiledRoute[]) {
  const raw = (method: string, path: string, action: RouteAction) => {
    routes.push({ method, match: compilePattern(path).match, action });
  };
  const json = (method: string, path: string, run: (params: readonly string[], url: URL) => Promise<unknown> | unknown) =>
    raw(method, path, async (_req, res, params, url) => sendJson(res, 200, await run(params, url)));
  const get = (path: string, run: (params: readonly string[], url: URL) => Promise<unknown> | unknown) => json('GET', path, run);
  type PostHandler = (input: Record<string, unknown>, params: readonly string[], req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  const post = (path: string, run: PostHandler, status: number | ((result: unknown) => number) = 200) =>
    raw('POST', path, async (req, res, params) => {
      const result = await run(await readJsonBody(req), params, req, res);
      sendJson(res, typeof status === 'function' ? status(result) : status, result);
    });
  const put = (path: string, run: (input: Record<string, unknown>, params: readonly string[]) => Promise<unknown>) =>
    raw('PUT', path, async (req, res, params) => sendJson(res, 200, await run(await readJsonBody(req), params)));
  const offline = (path: string,
    run: (input: Record<string, unknown>, watermark: string, params: readonly string[]) => Promise<unknown>, status = 200) =>
    post(path, async (input, params, _req, res) => {
      const watermark = submittedWatermark(input);
      res.setHeader('X-Deletion-Watermark', watermark);
      return run(input, watermark, params);
    }, status);
  const pendingStatus = (result: unknown) => (result as { state?: string }).state === 'pending' ? 202 : 200;
  const getOne = (path: string, read: (id: string) => Promise<unknown>) => get(path, ([id]) => read(id!));
  const putOne = (path: string, writeOne: (id: string, input: Record<string, unknown>) => Promise<unknown>) =>
    put(path, (input, [id]) => writeOne(id!, input));
  const postOne = (path: string, writeOne: (id: string, input: Record<string, unknown>) => Promise<unknown>,
    status: number | ((result: unknown) => number) = 200) => post(path, (input, [id]) => writeOne(id!, input), status);
  return { raw, json, get, post, put, offline, getOne, putOne, postOne, runAbortable, pendingStatus, routes };
}
