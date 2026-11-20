import type {Settings} from './api';
export type McpGrant = { id: string; url: string; allowedTools: string[] };
export type Route = {accountRevision?: string; providerId: string; model: string; protocol: string; baseUrl: string; reasoningEffort: string};
export function selectedRoute(settings?: Settings): Route | undefined {
  return settings && {providerId: settings.activeProviderId, model: settings.model, protocol: settings.protocol,
    baseUrl: settings.baseUrl, reasoningEffort: settings.reasoningEffort};
}

export const taskLabels = {companion: '同伴对话', preparation: '材料备课', diagnostic: '诊断教学', assessment: '试卷批改'} as const;
export type ModelTask = keyof typeof taskLabels;
export function forTask(settings: Settings, task: ModelTask): Settings {
  const id = settings.routes?.[task];
  const profile = id && settings.providers.find(item => item.id === id);
  return profile ? {...settings, ...profile, activeProviderId: profile.id} : settings;
}

export function chatRoute(settings: Settings, task: 'preparation' | 'companion'): Route | undefined {
  const assigned = settings.routes?.[task];
  const profile = assigned ? settings.providers.find(item => item.id === assigned) : settings;
  if (!profile) return;
  const {protocol, baseUrl, model, reasoningEffort, accountRevision} = profile;
  const providerId = assigned || settings.activeProviderId;
  if (![providerId, protocol, baseUrl, model, reasoningEffort].every(value => typeof value === 'string' && value.trim())) return;
  const route = {providerId, protocol, baseUrl, model, reasoningEffort};
  if (accountRevision === undefined) {
    if (settings.accountRevision === undefined && settings.providers.every(item => item.accountRevision === undefined)) return route;
    return;
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountRevision)) return;
  return {...route, accountRevision};
}
