import { taskLabels, type ModelTask } from './model-route';
import { McpToolPicker } from './mcp-tool-picker';
import { WorkspaceAccessPanel } from './workspace-access';
import './settings.css';
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Settings } from "./api";
import { ResearchSettings } from "./research";
import { Icon } from "./icons";
import {
  draftFromSettings,
  keyConfigured,
  newMcpServer,
  newProvider,
  parseAllowedTools,
  sameEndpoint,
  settingsPayload,
  tokenConfigured,
  type McpDraft,
  type ProviderDraft,
  type SettingsDraft,
} from "./settings-draft";

const reasoningEfforts = ["default", "low", "medium", "high", "xhigh", "max"];

export function SettingsDialog({ onClose, onSave, textbookAccess = false }: {
  textbookAccess?: boolean;
  onClose: () => void;
  onSave: (settings: Settings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<SettingsDraft>();
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [replaceConfig, setReplaceConfig] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<Settings>("/settings", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setDraft(draftFromSettings(result));
      setEditing(result.activeProviderId);
    }).catch(() => {
      if (controller.signal.aborted) return;
      const provider = newProvider("auto/deepseek-v4.1-flash", "high");
      setDraft({
        activeProviderId: provider.id,
        providers: [provider],
        mcpServers: [],
        exaKey: "",
        hasExaKey: false,
        removeExaKey: false,
        allowSearch: false,
      });
      setEditing(provider.id);
      setReplaceConfig(true);
      setError("无法读取原有配置。请填写完整的新设置。");
    });
    return () => controller.abort();
  }, []);

  function changeProvider(id: string, update: Partial<ProviderDraft>) {
    setDraft((current) => current && {
      ...current,
      providers: current.providers.map((provider) => provider.id === id ? { ...provider, ...update } : provider),
    });
  }

  function changeMcp(id: string, update: Partial<McpDraft>) {
    setDraft((current) => current && {
      ...current,
      mcpServers: current.mcpServers.map((server) => server.id === id ? { ...server, ...update } : server),
    });
  }

  function addProvider() {
    if (!draft || draft.providers.length >= 100) return;
    const provider = newProvider("", "default");
    setDraft({ ...draft, providers: [...draft.providers, provider] });
    setEditing(provider.id);
  }

  function removeProvider(id: string) {
    if (!draft || draft.providers.length === 1) return;
    const providers = draft.providers.filter((provider) => provider.id !== id);
    const activeProviderId = draft.activeProviderId === id ? providers[0]!.id : draft.activeProviderId;
    setDraft({ ...draft, providers, activeProviderId });
    if (editing === id) setEditing(activeProviderId);
  }

  function addMcp() {
    if (!draft || draft.mcpServers.length >= 100) return;
    setDraft({ ...draft, mcpServers: [...draft.mcpServers, newMcpServer()] });
  }

  function removeMcp(id: string) {
    setDraft((current) => current && {
      ...current,
      mcpServers: current.mcpServers.filter((server) => server.id !== id),
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving) return;
    setError("");
    if (draft.providers.some((provider) => !provider.baseUrl.trim())) {
      setError("每个模型配置都需要服务地址。");
      return;
    }
    if (draft.providers.some((provider) => !provider.model.trim())) {
      setError("每个模型配置都需要模型名称。");
      return;
    }
    if (draft.mcpServers.some((server) => !server.url.trim())) {
      setError("每个 MCP 服务都需要地址。");
      return;
    }
    setSaving(true);
    try {
      const result = await api<Settings>("/settings", {
        method: "PUT",
        body: settingsPayload(draft),
      });
      onSave(result);
      dialog.current?.close();
    } catch (failure) {
      setError(failure instanceof ApiError && failure.message !== `HTTP ${failure.status}`
        ? failure.message
        : "无法保存设置，请检查服务地址和密钥后重试。");
    } finally {
      setSaving(false);
    }
  }

  const activeProvider = draft?.providers.find((provider) => provider.id === draft.activeProviderId);

  return (
    <dialog
      ref={dialog}
      className="settings-dialog settings-dialog--structured"
      aria-labelledby="settings-title"
      onClose={onClose}
      onCancel={(event) => { if (saving) event.preventDefault(); }}
    >
      <div className="dialog-heading settings-dialog-header">
        <div>
          <h2 id="settings-title">学习设置</h2>
          <p>管理模型、学习记录访问、外部工具连接与公开参考搜索。</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭学习设置" disabled={saving} onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <div className="settings-dialog-body">
        <ResearchSettings />
        {draft ? (
          <form id="settings-dialog-form" onSubmit={(event) => void save(event)}>
            <section className="settings-section" aria-labelledby="providers-title">
              <div className="settings-section-heading">
                <h3 id="providers-title">模型配置</h3>
                <button type="button" className="text-button" disabled={draft.providers.length >= 100} onClick={addProvider}>添加配置</button>
              </div>
              <p className="field-help">当前使用：{activeProvider?.label || "未命名"} · {activeProvider?.model || "未填写模型"}</p>
              <div className="settings-list">
                {draft.providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    active={provider.id === draft.activeProviderId}
                    open={provider.id === editing}
                    canRemove={draft.providers.length > 1}
                    disabled={saving}
                    onActivate={() => setDraft({ ...draft, activeProviderId: provider.id })}
                    onToggle={() => setEditing(editing === provider.id ? undefined : provider.id)}
                    onRemove={() => removeProvider(provider.id)}
                    onChange={(update) => changeProvider(provider.id, update)}
                  />
                ))}
              </div>
            </section>

            <section className="settings-section" aria-label="按用途选择模型">
              <h3>按用途选择模型</h3>
              {Object.entries(taskLabels).map(([task, label]) => <label key={task} className="field">
                <span>{label}</span>
                <select value={draft.routes?.[task as ModelTask] ?? ''} onChange={e => {
                  const routes = {...draft.routes};
                  if (e.target.value) routes[task as ModelTask] = e.target.value;
                  else delete routes[task as ModelTask];
                  setDraft({...draft, routes});
                }}>
                  <option value="">跟随当前模型</option>
                  {draft.providers.map(p => <option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}
                </select>
              </label>)}
            </section>
            <WorkspaceAccessPanel disabled={saving} textbookAccess={textbookAccess} />
            <section className="settings-section" aria-labelledby="mcp-title">
              <div className="settings-section-heading">
                <h3 id="mcp-title">外部工具连接</h3>
                <button type="button" className="text-button" disabled={draft.mcpServers.length >= 100} onClick={addMcp}>添加连接</button>
              </div>
              <p className="field-help">只开放清单内的工具名称。未列出的工具不会提供给模型。</p>
              {draft.mcpServers.length === 0 && <p className="settings-empty">尚未添加外部工具连接。</p>}
              <div className="settings-list">
                {draft.mcpServers.map((server) => (
                  <McpCard
                    key={server.id}
                    server={server}
                    disabled={saving}
                    onChange={(update) => changeMcp(server.id, update)}
                    onRemove={() => removeMcp(server.id)}
                  />
                ))}
              </div>
            </section>

            <section className="settings-section" aria-labelledby="search-title">
              <h3 id="search-title">公开参考搜索</h3>
              <label className="workbook-check">
                <input
                  type="checkbox"
                  checked={draft.allowSearch}
                  disabled={draft.removeExaKey}
                  onChange={(event) => setDraft({ ...draft, allowSearch: event.target.checked })}
                />
                <span>允许 Exa 搜索公开参考</span>
              </label>
              <p className="field-help" id="search-help">
                开启后，学习助手可把公开检索词发送给 Exa。可直接使用 Exa 的公共额度，也可填写自己的密钥。
              </p>
              <label className="field">
                <span>Exa API 密钥</span>
                <input
                  type="password"
                  maxLength={8192}
                  autoComplete="new-password"
                  aria-describedby="exa-key-help"
                  value={draft.exaKey}
                  placeholder={draft.hasExaKey ? "输入新密钥" : "输入 Exa 密钥（如需）"}
                  disabled={draft.removeExaKey}
                  onChange={(event) => setDraft({ ...draft, exaKey: event.target.value, removeExaKey: false })}
                />
              </label>
              {draft.hasExaKey && (
                <button
                  type="button"
                  className="text-button"
                  disabled={saving}
                  onClick={() => setDraft({
                    ...draft,
                    exaKey: "",
                    removeExaKey: !draft.removeExaKey,
                    allowSearch: draft.removeExaKey ? draft.allowSearch : false,
                  })}
                >
                  {draft.removeExaKey ? "保留已有 Exa 密钥" : "移除 Exa 密钥并关闭搜索"}
                </button>
              )}
              {draft.removeExaKey && <p role="status">保存设置后会移除 Exa 密钥并关闭搜索。</p>}
              <p className="field-help" id="exa-key-help">
                {draft.removeExaKey
                  ? "可在保存前选择保留原密钥。"
                  : draft.hasExaKey
                    ? "已配置 Exa 密钥。留空可继续使用当前密钥；关闭搜索不会删除密钥。"
                    : "留空使用公共额度，填写密钥可使用自己的 Exa 账户。"}
              </p>
            </section>

            {replaceConfig && <p role="status" className="field-help">将写入一份全新的设置。</p>}
            {error && <p role="alert" className="error-text">{error}</p>}
          </form>
        ) : (
          <div className="dialog-loading" role="status">
            正在读取设置…
          </div>
        )}
      </div>
      {draft && (
        <div className="dialog-actions settings-dialog-actions">
          <button type="button" className="text-button" disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" form="settings-dialog-form" className="primary-button" disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
        </div>
      )}
    </dialog>
  );
}

function ProviderCard({ provider, active, open, canRemove, disabled, onActivate, onToggle, onRemove, onChange }: {
  provider: ProviderDraft;
  active: boolean;
  open: boolean;
  canRemove: boolean;
  disabled: boolean;
  onActivate: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onChange: (update: Partial<ProviderDraft>) => void;
}) {
  const destinationChanged = provider.hasKey && (provider.protocol !== provider.savedProtocol || !sameEndpoint(provider.baseUrl, provider.savedBaseUrl));
  const configured = keyConfigured(provider);
  return (
    <div className={`settings-card${active ? " active" : ""}`}>
      <div className="settings-card-head">
        <label className="settings-choice">
          <input type="radio" name="active-provider" checked={active} disabled={disabled} onChange={onActivate} />
          <span>{provider.label || "未命名配置"}</span>
        </label>
        <div className="settings-card-actions">
          <span className="settings-meta">{provider.model || "未填写模型"}</span>
          <button type="button" className="text-button" aria-expanded={open} disabled={disabled} onClick={onToggle}>{open ? "收起" : "编辑"}</button>
          {canRemove && <button type="button" className="text-button danger" disabled={disabled} onClick={onRemove}>删除</button>}
        </div>
      </div>
      {open && (
        <div className="settings-card-body">
          <label className="field">
            <span>名称</span>
            <input type="text" maxLength={120} value={provider.label} disabled={disabled} onChange={(event) => onChange({ label: event.target.value })} />
          </label>
          <label className="field">
            <span>服务地址</span>
            <input type="url" required maxLength={2000} value={provider.baseUrl} placeholder="https://api.example.com/v1" disabled={disabled} onChange={(event) => onChange({ baseUrl: event.target.value })} />
          </label>
          <div className="settings-grid">
            <label className="field">
              <span>协议</span>
              <select value={provider.protocol} disabled={disabled} onChange={(event) => onChange({ protocol: event.target.value === "anthropic" ? "anthropic" : "openai" })}>
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label className="field">
              <span>思考强度</span>
              <select value={provider.reasoningEffort} disabled={disabled} onChange={(event) => onChange({ reasoningEffort: event.target.value })}>
                {!reasoningEfforts.includes(provider.reasoningEffort) && provider.reasoningEffort && (
                  <option value={provider.reasoningEffort}>{provider.reasoningEffort}</option>
                )}
                {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort === "default" ? "跟随服务默认值" : effort}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            <span>模型</span>
            <input type="text" required maxLength={200} value={provider.model} placeholder="auto/deepseek-v4.1-flash" disabled={disabled} onChange={(event) => onChange({ model: event.target.value })} />
          </label>
          <label className="field">
            <span>模型 API 密钥</span>
            <input
              type="password"
              maxLength={8192}
              autoComplete="new-password"
              aria-describedby={`${provider.id}-key-help`}
              value={provider.apiKey}
              disabled={disabled || provider.removeKey}
              placeholder={configured ? "输入新密钥" : "输入 API 密钥（如需）"}
              onChange={(event) => onChange({ apiKey: event.target.value, removeKey: false })}
            />
          </label>
          {(configured || provider.removeKey) && (
            <button type="button" className="text-button" disabled={disabled} onClick={() => onChange({ apiKey: "", removeKey: !provider.removeKey })}>
              {provider.removeKey ? "保留已有密钥" : "移除已有密钥"}
            </button>
          )}
          {provider.removeKey && <p role="status">保存设置后会移除密钥。</p>}
          <p className="field-help" id={`${provider.id}-key-help`}>
            {provider.removeKey
              ? "可在保存前选择保留原密钥。"
              : destinationChanged
                ? "服务地址或协议已变更，保存时请为新服务填写密钥。"
                : configured
                  ? "已配置密钥。留空可继续使用当前密钥。"
                  : "端点需要鉴权时填写。保存后仅显示密钥配置状态。"}
          </p>
        </div>
      )}
    </div>
  );
}

function McpCard({ server, disabled, onChange, onRemove }: {
  server: McpDraft;
  disabled: boolean;
  onChange: (update: Partial<McpDraft>) => void;
  onRemove: () => void;
}) {
  const destinationChanged = !sameEndpoint(server.url, server.savedUrl);
  const configured = tokenConfigured(server);
  const tools = parseAllowedTools(server.allowedToolsText);
  return (
    <div className={`settings-card${server.enabled ? "" : " inactive"}`}>
      <div className="settings-card-head">
        <label className="settings-choice">
          <input type="checkbox" checked={server.enabled} disabled={disabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
          <span>{server.label || "未命名 MCP 服务"}</span>
        </label>
        <div className="settings-card-actions">
          <span className="settings-meta">{tools.length ? `${tools.length} 个工具` : "未开放工具"}</span>
          <button type="button" className="text-button danger" disabled={disabled} onClick={onRemove}>删除</button>
        </div>
      </div>
      <div className="settings-card-body">
        <label className="field">
          <span>名称</span>
          <input type="text" maxLength={120} value={server.label ?? ""} placeholder="可选" disabled={disabled} onChange={(event) => onChange({ label: event.target.value })} />
        </label>
        <label className="field">
          <span>服务地址</span>
          <input type="url" required maxLength={2000} value={server.url} placeholder="https://example.com/mcp" disabled={disabled} onChange={(event) => onChange({ url: event.target.value })} />
        </label>
        <label className="field">
          <span>访问令牌</span>
          <input
            type="password"
            maxLength={8192}
            autoComplete="new-password"
            aria-describedby={`${server.id}-token-help`}
            value={server.token}
            disabled={disabled || server.removeToken}
            placeholder={configured ? "输入新令牌" : "输入访问令牌（如需）"}
            onChange={(event) => onChange({ token: event.target.value, removeToken: false })}
          />
        </label>
        {(configured || server.removeToken) && (
          <button type="button" className="text-button" disabled={disabled} onClick={() => onChange({ token: "", removeToken: !server.removeToken })}>
            {server.removeToken ? "保留已有令牌" : "移除已有令牌"}
          </button>
        )}
        {server.removeToken && <p role="status">保存设置后会移除令牌。</p>}
        <p className="field-help" id={`${server.id}-token-help`}>
          {server.removeToken
            ? "可在保存前选择保留原令牌。"
            : destinationChanged
              ? "地址已变更：保存后会清除此服务原有的令牌，需要重新填写。"
              : configured
                ? "已配置令牌。留空可继续使用当前令牌。"
                : "服务需要鉴权时填写。保存后仅显示令牌配置状态。"}
        </p>
        <label className="field">
          <span>允许的工具名称</span>
          <textarea
            rows={3}
            maxLength={4000}
            value={server.allowedToolsText}
            placeholder="search, fetch_page（逗号或换行分隔）"
            disabled={disabled}
            onChange={(event) => onChange({ allowedToolsText: event.target.value, allowedTools: parseAllowedTools(event.target.value) })}
          />
        </label>
        <McpToolPicker key={JSON.stringify([server.url,server.token,server.removeToken])} server={server} disabled={disabled} onChange={onChange} />
        <p className="field-help">模型只能调用这里列出的工具；清单为空时不开放任何工具。</p>
      </div>
    </div>
  );
}
