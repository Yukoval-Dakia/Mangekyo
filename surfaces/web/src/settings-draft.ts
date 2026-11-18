import type {
  McpServerInput,
  McpServerSummary,
  ProviderProfileInput,
  ProviderProfileSummary,
  Settings,
  SettingsUpdate,
} from "./api";

export type ProviderDraft = ProviderProfileSummary & {
  apiKey: string;
  removeKey: boolean;
  savedBaseUrl: string;
  savedProtocol: ProviderProfileSummary["protocol"];
};

export type McpDraft = McpServerSummary & {
  token: string;
  removeToken: boolean;
  savedUrl: string;
  allowedToolsText: string;
};

export type SettingsDraft = {
  routes?: Settings["routes"];
  activeProviderId: string;
  providers: ProviderDraft[];
  mcpServers: McpDraft[];
  exaKey: string;
  hasExaKey: boolean;
  removeExaKey: boolean;
  allowSearch: boolean;
};

export function newLocalId(prefix: string) {
  const random =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  return `${prefix}-${random}`;
}

export function newProvider(
  model: string,
  reasoningEffort: string,
  id = newLocalId("provider"),
): ProviderDraft {
  return {
    id,
    label: "新模型",
    baseUrl: "",
    protocol: "openai",
    model,
    reasoningEffort,
    hasKey: false,
    apiKey: "",
    removeKey: false,
    savedBaseUrl: "",
    savedProtocol: "openai",
  };
}

export function newMcpServer(): McpDraft {
  return {
    id: newLocalId("mcp"),
    label: "",
    url: "",
    allowedTools: [],
    enabled: true,
    hasToken: false,
    token: "",
    removeToken: false,
    savedUrl: "",
    allowedToolsText: "",
  };
}

export function draftFromSettings(settings: Settings): SettingsDraft {
  return {
    routes: settings.routes,
    activeProviderId: settings.activeProviderId,
    providers: settings.providers.map((provider) => ({
      ...provider,
      apiKey: "",
      removeKey: false,
      savedBaseUrl: provider.baseUrl,
      savedProtocol: provider.protocol,
    })),
    mcpServers: settings.mcpServers.map((server) => ({
      ...server,
      token: "",
      removeToken: false,
      savedUrl: server.url,
      allowedToolsText: server.allowedTools.join(", "),
    })),
    exaKey: "",
    hasExaKey: settings.hasExaKey,
    removeExaKey: false,
    allowSearch: settings.allowSearch,
  };
}

export function sameEndpoint(left: string, right: string) {
  return left.trim().replace(/\/+$/, "") === right.trim().replace(/\/+$/, "");
}

export function keyConfigured(provider: ProviderDraft) {
  return provider.hasKey && provider.protocol === provider.savedProtocol && sameEndpoint(provider.baseUrl, provider.savedBaseUrl) && !provider.removeKey;
}

export function tokenConfigured(server: McpDraft) {
  return server.hasToken && sameEndpoint(server.url, server.savedUrl) && !server.removeToken;
}

export function parseAllowedTools(value: string) {
  return [...new Set(value.split(/[,\n]/).map((tool) => tool.trim()).filter(Boolean))];
}

function providerPayload(provider: ProviderDraft): ProviderProfileInput {
  const key = provider.removeKey ? "" : provider.apiKey.trim();
  const label = provider.label.trim();
  return {
    id: provider.id,
    ...(label ? { label } : {}),
    baseUrl: provider.baseUrl.trim(),
    protocol: provider.protocol,
    model: provider.model.trim(),
    reasoningEffort: provider.reasoningEffort.trim(),
    ...(provider.removeKey || key ? { apiKey: key } : {}),
  };
}

function mcpPayload(server: McpDraft): McpServerInput {
  const token = server.removeToken ? "" : server.token.trim();
  const label = server.label?.trim() ?? "";
  return {
    id: server.id,
    ...(label ? { label } : {}),
    url: server.url.trim(),
    allowedTools: parseAllowedTools(server.allowedToolsText),
    enabled: server.enabled,
    ...(server.removeToken || token ? { token } : {}),
  };
}

export function settingsPayload(draft: SettingsDraft): SettingsUpdate {
  const exaKey = draft.removeExaKey ? "" : draft.exaKey.trim();
  return {
    routes: Object.fromEntries(Object.entries(draft.routes ?? {}).filter(([, id]) => draft.providers.some(profile => profile.id === id))),
    activeProviderId: draft.activeProviderId,
    providers: draft.providers.map(providerPayload),
    mcpServers: draft.mcpServers.map(mcpPayload),
    allowSearch: draft.removeExaKey ? false : draft.allowSearch,
    ...(draft.removeExaKey || exaKey ? { exaApiKey: exaKey } : {}),
  };
}
