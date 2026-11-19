import type {Settings} from './api';
export type McpGrant = { id: string; url: string; allowedTools: string[] };
export type Route = {providerId: string; model: string; protocol: string; baseUrl: string; reasoningEffort: string};
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
