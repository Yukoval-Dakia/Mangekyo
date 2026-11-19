import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Settings } from "./api";
import { ResearchSettings } from "./research";
import { Icon } from "./icons";

export function SettingsDialog({ onClose, onSave }: {
  onClose: () => void;
  onSave: (settings: Settings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>();
  const [savedEndpoint, setSavedEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [exaKey, setExaKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [removeExaKey, setRemoveExaKey] = useState(false);
  const [replaceConfig, setReplaceConfig] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<Settings>("/settings", { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSettings(result);
      setSavedEndpoint(result.baseUrl);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setSettings({
        baseUrl: "",
        model: "",
        reasoningEffort: "",
        hasKey: false,
        hasExaKey: false,
        allowSearch: false,
      });
      setReplaceConfig(true);
      setError("无法读取原有配置。请填写完整的新设置。");
    });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || saving) return;
    setError("");
    setSaving(true);
    try {
      const newApiKey = key.trim();
      const newExaApiKey = exaKey.trim();
      const result = await api<Settings>("/settings", {
        method: "PUT",
        body: {
          baseUrl: settings.baseUrl.trim(),
          ...((newApiKey || removeKey || replaceConfig) ? { apiKey: removeKey ? "" : newApiKey } : {}),
          ...((newExaApiKey || removeExaKey || replaceConfig) ? { exaApiKey: removeExaKey ? "" : newExaApiKey } : {}),
          allowSearch: settings.allowSearch,
        },
      });
      setKey("");
      setExaKey("");
      onSave(result);
      dialog.current?.close();
    } catch {
      setError("无法保存设置，请检查服务地址和密钥后重试。");
    } finally {
      setSaving(false);
    }
  }

  const hasKey = settings?.hasKey && settings.baseUrl.trim().replace(/\/+$/, "") === savedEndpoint;
  const hasExaKey = Boolean(settings?.hasExaKey);

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onClose={onClose}
      onCancel={(event) => { if (saving) event.preventDefault(); }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id="settings-title">学习设置</h2>
        </div>
        <button type="button" className="icon-button" aria-label="关闭学习设置" disabled={saving} onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      <ResearchSettings />
      <h3>模型与搜索</h3>
      {settings ? (
        <form onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>模型端点</span>
            <input type="url" required maxLength={2000} value={settings.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} />
          </label>
          {settings.model && <p className="field-help">教学模型 · {settings.model}<br />思考强度 · {settings.reasoningEffort}</p>}
          <label className="field">
            <span>模型 API 密钥</span>
            <input type="password" maxLength={8192} autoComplete="new-password" aria-describedby="key-help" value={key} placeholder={hasKey ? "输入新密钥" : "输入 API 密钥（如需）"} onChange={(event) => { setKey(event.target.value); setRemoveKey(false); }} />
          </label>
          {hasKey && <button type="button" className="text-button" onClick={() => { setKey(""); setRemoveKey(!removeKey); }}>{removeKey ? "保留已有密钥" : "移除已有密钥"}</button>}
          {removeKey && <p role="status">保存设置后会移除密钥。</p>}
          <p className="field-help" id="key-help">{removeKey ? "可在保存前选择保留原密钥。" : hasKey ? "已配置密钥。留空可继续使用当前密钥。" : "端点需要鉴权时填写。保存后仅显示密钥配置状态。"}</p>
          <label className="workbook-check">
            <input
              type="checkbox"
              checked={settings.allowSearch}
              onChange={(event) => setSettings({ ...settings, allowSearch: event.target.checked })}
            />
            <span>允许 Exa 搜索公开参考</span>
          </label>
          <p className="field-help" id="search-help">
            开启后，Agent 可把公开检索词发送给 Exa。可直接使用 Exa 的公共额度，也可填写自己的密钥。Python 验算和临时文件在本次任务的独立工作区内运行。
          </p>
          <label className="field">
            <span>Exa API 密钥</span>
            <input
              type="password"
              maxLength={8192}
              autoComplete="new-password"
              aria-describedby="exa-key-help"
              value={exaKey}
              placeholder={hasExaKey ? "输入新密钥" : "输入 Exa 密钥（如需）"}
              onChange={(event) => { setExaKey(event.target.value); setRemoveExaKey(false); }}
            />
          </label>
          {hasExaKey && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setExaKey("");
                setRemoveExaKey(!removeExaKey);
                if (!removeExaKey) setSettings({ ...settings, allowSearch: false });
              }}
            >
              {removeExaKey ? "保留已有 Exa 密钥" : "移除 Exa 密钥并关闭搜索"}
            </button>
          )}
          {removeExaKey && <p role="status">保存设置后会移除 Exa 密钥并关闭搜索。</p>}
          <p className="field-help" id="exa-key-help">
            {removeExaKey
              ? "可在保存前选择保留原密钥。"
              : hasExaKey
                ? "已配置 Exa 密钥。留空可继续使用当前密钥；关闭搜索不会删除密钥。"
                : "留空使用公共额度，填写密钥可使用自己的 Exa 账户。"}
          </p>
          {error && <p role="alert" className="error-text">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="text-button" disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
          </div>
        </form>
      ) : (
        <div className="dialog-loading" role="status">
          正在读取模型设置…
        </div>
      )}
    </dialog>
  );
}
