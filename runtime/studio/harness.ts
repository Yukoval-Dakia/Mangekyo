import {loadWorkspaceAccessRoutes, workspaceGrantRevision} from './workspace-access.ts';
import { createHash } from 'node:crypto';
import { TeachingError } from '../../executors/teaching/provider.ts';
import type { studyTurn, studyMcpGrants } from '../../modules/activity/values.ts';
import { loadSettings } from './settings.ts';

type Settings = Awaited<ReturnType<typeof loadSettings>>;
type StoredTurn = ReturnType<typeof studyTurn>;
type Grants = ReturnType<typeof studyMcpGrants>;

export function sameRoute(turn: StoredTurn, settings: Settings) {
  return turn.baseUrl === settings.baseUrl && turn.model === settings.model &&
    (turn.reasoningEffort ?? 'high') === settings.reasoningEffort && (turn.protocol ?? 'openai') === settings.protocol &&
    (turn.providerId ?? 'default') === settings.activeProviderId;
}

export function sameActiveProvider(left: Settings, right: Settings) {
  return left.activeProviderId === right.activeProviderId && left.baseUrl === right.baseUrl &&
    left.protocol === right.protocol && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

// Only connect to destinations from saved settings. The request supplies the student's approved snapshot.
export function resolveMcpGrants(grants: Grants, settings: Settings) {
  return grants.map(grant => {
    const server = settings.mcpServers.find(item => item.id === grant.id && item.enabled);
    if (!server || server.url !== grant.url || grant.allowedTools.some(name => !server.allowedTools.includes(name)))
      throw new TeachingError('provider_configuration', '本轮所选的 MCP 服务或工具已变更，请重新选择。');
    return { id: server.id, url: server.url, ...(server.token ? {token: server.token} : {}), allowedTools: grant.allowedTools };
  });
}

// This marker uses rotation IDs, so student records never contain a token or a hash of a token.
export function mcpRevision(grants: Grants, settings: Settings) {
  const versions = grants.map(({id}) => [id, settings.mcpServers.find(server => server.id === id)?.credentialRevision]);
  return createHash('sha256').update(JSON.stringify(versions)).digest('hex');
}

export function routeMatchesInput(input: unknown, settings: Pick<Settings, 'activeProviderId' | 'protocol' | 'baseUrl' | 'model' | 'reasoningEffort'>) {
  if (input === undefined) return true; // Clients from before profiles authorized the endpoint alone.
  if (!input || typeof input !== 'object') return false;
  const route = input as Record<string, unknown>;
  return route.providerId === settings.activeProviderId && route.protocol === settings.protocol &&
    route.baseUrl === settings.baseUrl && route.model === settings.model && route.reasoningEffort === settings.reasoningEffort;
}

type WorkspaceRoutes = Awaited<ReturnType<typeof loadWorkspaceAccessRoutes>>;

export async function workspaceRouteRevision(settings: Settings) {
  const provider = settings.providers.find(profile => profile.id === settings.activeProviderId);
  return provider && workspaceGrantRevision(await loadWorkspaceAccessRoutes(), provider);
}

export function workspaceGrantChecker() {
  let current: Promise<[Settings, WorkspaceRoutes]> | undefined;
  return async (turn: StoredTurn) => {
    if (!turn.workspaceRevision) return true;
    const [settings, routes] = await (current ??= Promise.all([loadSettings(), loadWorkspaceAccessRoutes()]));
    const provider = settings.providers.find(profile => profile.id === (turn.providerId ?? 'default'));
    if (!provider || provider.baseUrl !== turn.baseUrl || provider.protocol !== (turn.protocol ?? 'openai')) return false;
    return workspaceGrantRevision(routes, provider) === turn.workspaceRevision;
  };
}
