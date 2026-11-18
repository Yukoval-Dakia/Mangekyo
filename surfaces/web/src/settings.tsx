import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Settings } from "./api";
import { Icon } from "./icons";

export function SettingsDialog({ onClose, onSave }: {
  onClose: () => void;
  onSave: (settings: Settings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>();
  const [savedEndpoint, setSavedEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
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
      setSettings({ baseUrl: "", model: "", reasoningEffort: "", hasKey: false });
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
      const result = await api<Settings>("/settings", {
        method: "PUT",
        body: {
          baseUrl: settings.baseUrl.trim(),
          ...((key.trim() || removeKey || replaceConfig) ? { apiKey: removeKey ? "" : key.trim() } : {}),
        },
      });
      setKey("");
      onSave(result);
      dialog.current?.close();
    } catch {
      setError("无法保存设置，请检查服务地址和密钥后重试。");
    } finally {
      setSaving(false);
    }
  }

  const hasKey = settings?.hasKey && settings.baseUrl.trim().replace(/\/+$/, "") === savedEndpoint;

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
          <h2 id="settings-title">模型设置</h2>
          <p>选择教研同伴连接的模型端点。</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭模型设置" disabled={saving} onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </div>
      {settings ? (
        <form onSubmit={(event) => void save(event)}>
          <label className="field">
            <span>模型端点</span>
            <input type="url" required maxLength={2000} value={settings.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => { setSettings({ ...settings, baseUrl: event.target.value }); setKey(""); setRemoveKey(false); }} />
          </label>
          {settings.model && <p className="field-help">教学模型 · {settings.model}<br />思考强度 · {settings.reasoningEffort}</p>}
          <label className="field">
            <span>API 密钥</span>
            <input type="password" maxLength={8192} autoComplete="new-password" aria-describedby="key-help" value={key} placeholder={hasKey ? "输入新密钥" : "输入 API 密钥（如需）"} onChange={(event) => { setKey(event.target.value); setRemoveKey(false); }} />
          </label>
          {hasKey && <button type="button" className="text-button" onClick={() => { setKey(""); setRemoveKey(!removeKey); }}>{removeKey ? "保留已有密钥" : "移除已有密钥"}</button>}
          {removeKey && <p role="status">保存设置后会移除密钥。</p>}
          <p className="field-help" id="key-help">{removeKey ? "可在保存前选择保留原密钥。" : hasKey ? "已配置密钥。留空可继续使用当前密钥。" : "端点需要鉴权时填写。保存后仅显示密钥配置状态。"}</p>
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
