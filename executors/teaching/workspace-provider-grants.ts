import type { ProviderProfile, ProviderProtocol, ProviderSettings } from './provider-settings.ts';

export const providerIdentifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export type StoredRoute = {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly revision: string;
  readonly credentialRevision?: string;
};
type StoredAccess = {
  readonly version: 1;
  readonly routes: Record<string, StoredRoute>;
};

export type WorkspaceProviderView = {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly protocol: ProviderProtocol;
  readonly active: boolean;
  readonly authorized: boolean;
  readonly authorizationStale?: boolean;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function defaultStored(): StoredAccess {
  return { version: 1, routes: {} };
}

export function normalizeStored(value: unknown): StoredAccess {
  const input = object(value);
  if (!input) throw new Error('学习记录访问设置无效。');
  const rawRoutes = object(input.routes);
  const routes: Record<string, StoredRoute> = {};
  if (rawRoutes) {
    for (const [id, raw] of Object.entries(rawRoutes)) {
      if (!providerIdentifier.test(id)) continue;
      const route = object(raw);
      if (!route || typeof route.enabled !== 'boolean') continue;
      if (typeof route.baseUrl !== 'string' || route.baseUrl.length > 2000 || /[\u0000-\u001f\u007f]/.test(route.baseUrl)) continue;
      if (route.protocol !== 'openai' && route.protocol !== 'anthropic') continue;
      if (typeof route.revision !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(route.revision)) continue;
      routes[id] = {
        enabled: route.enabled,
        baseUrl: route.baseUrl,
        protocol: route.protocol,
        revision: route.revision,
        ...(typeof route.credentialRevision === 'string' && providerIdentifier.test(route.credentialRevision)
          ? {credentialRevision: route.credentialRevision} : {}),
      };
    }
  }
  return { version: 1, routes };
}

export function workspaceGrantRevision(routes: Readonly<Record<string, StoredRoute>>, provider: ProviderProfile) {
  const route = routes[provider.id];
  return route?.enabled && route.baseUrl === provider.baseUrl && route.protocol === provider.protocol &&
    provider.credentialRevision && route.credentialRevision === provider.credentialRevision ? route.revision : undefined;
}

export function providerViews(settings: ProviderSettings, stored: StoredAccess): WorkspaceProviderView[] {
  return settings.providers.map(provider => {
    const {id, label, model, baseUrl, protocol} = provider;
    const route = stored.routes[id];
    const matches = Boolean(workspaceGrantRevision(stored.routes, provider));
    return {
      id, label, model, baseUrl, protocol,
      active: id === settings.activeProviderId,
      authorized: matches,
      ...(route?.enabled && !matches ? { authorizationStale: true } : {}),
    };
  });
}

/**
 * Automatically authorize the active model provider when settings are saved,
 * unless the learner explicitly disabled the exact same endpoint/protocol/credential revision.
 */
export function autoAuthorizeActiveRoute(
  settings: ProviderSettings,
  stored: StoredAccess,
  revision: string,
): { readonly stored: StoredAccess; readonly changed: boolean } {
  const active = settings.providers.find(provider => provider.id === settings.activeProviderId);
  if (!active || !active.baseUrl || !active.credentialRevision) return { stored, changed: false };
  if (workspaceGrantRevision(stored.routes, active)) return { stored, changed: false };
  const existing = stored.routes[active.id];
  if (
    existing &&
    !existing.enabled &&
    existing.baseUrl === active.baseUrl &&
    existing.protocol === active.protocol &&
    existing.credentialRevision === active.credentialRevision
  ) {
    return { stored, changed: false };
  }
  const nextRoute: StoredRoute = {
    enabled: true,
    baseUrl: active.baseUrl,
    protocol: active.protocol,
    revision,
    credentialRevision: active.credentialRevision,
  };
  return {
    stored: { version: 1, routes: { ...stored.routes, [active.id]: nextRoute } },
    changed: true,
  };
}
