import { stableId } from './identity.ts';
import { loadSettings } from './settings.ts';
import { loadWorkspaceAccessRoutes } from './workspace-access.ts';

export function notionModelRecipient(id: string, endpoint: string, protocol: string, model: string, revision: string) {
  return 'studio:model:' + stableId(id, endpoint, protocol, model, revision);
}

export async function notionTeachingRecipients() {
  const [settings, routes] = await Promise.all([loadSettings(), loadWorkspaceAccessRoutes()]);
  return settings.providers.flatMap(provider => {
    const route = routes[provider.id];
    if (!route?.enabled || route.baseUrl !== provider.baseUrl || route.protocol !== provider.protocol) return [];
    return [{id:notionModelRecipient(provider.id,provider.baseUrl,provider.protocol,provider.model,route.revision),
      purpose:'teaching', label:provider.label + ' · ' + provider.model + ' · ' + provider.baseUrl}];
  });
}
