import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { api, submissionId } from "../api";
import { Icon } from "../icons";
import { materialFetchHelpers } from "../quick-capture-api";
import { chatPath, materialPath, type ChatLink, type Material } from "../workspace";

export type QuickModalMode = "capture" | "search";

const staticTargets = [
  { label: "今天", detail: "今日安排与节奏", href: "/today" },
  { label: "材料", detail: "来源、试卷、错题与教材", href: "/materials" },
  { label: "同伴", detail: "学习同伴完整对话页", href: "/companion" },
  { label: "我", detail: "学习目标、记忆与设置", href: "/me" },
  { label: "完整交入页", detail: "批量导入文件或拍照", href: "/intake" },
  { label: "教材", detail: "自建与阅读教材", href: "/textbooks" },
  { label: "错题回看", detail: "历史错题复盘", href: "/review" },
  { label: "笔记", detail: "整理过的学习笔记", href: "/notes" },
];

export function QuickCaptureModal({
  initialMode,
  materials,
  chats,
  onClose,
  onSaved,
  onNavigate,
}: {
  initialMode: QuickModalMode;
  materials: Material[];
  chats: ChatLink[];
  onClose: () => void;
  onSaved: (href: string) => void;
  onNavigate: (href: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<QuickModalMode>(initialMode);
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const searchItems = useMemo(() => {
    const dynamicItems = [
      ...materials.slice(0, 12).map(item => ({
        label: item.title,
        detail: "材料",
        href: materialPath(item.id),
      })),
      ...chats.slice(0, 8).map(item => ({
        label: item.title,
        detail: "对话",
        href: chatPath(item.id),
      })),
    ];
    const all = [...staticTargets, ...dynamicItems];
    const needle = query.trim().toLowerCase();
    if (!needle) return all.slice(0, 10);
    return all.filter(item =>
      item.label.toLowerCase().includes(needle) || item.detail.toLowerCase().includes(needle),
    ).slice(0, 12);
  }, [materials, chats, query]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (!text.trim() && !file)) return;
    setBusy(true);
    setError("");
    try {
      if (file) {
        const result = await materialFetchHelpers.submitIntake(file, file.name.replace(/\.[^.]+$/, "") || "快速交入");
        onSaved(`/materials/saved/${encodeURIComponent(result.id!)}`);
      } else {
        const result = await api<{ id?: string }>("/materials", {
          method: "POST",
          body: { title: "快速交入", text: text.trim(), requestId: submissionId() },
        });
        if (!result.id) throw new Error("服务端没有返回材料编号。");
        onSaved(`/materials/saved/${encodeURIComponent(result.id)}`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "交入尚未确认，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function handleBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === ref.current) onClose();
  }

  return (
    <dialog
      ref={ref}
      className="quick-capture-dialog"
      aria-labelledby="quick-capture-title"
      onClose={onClose}
      onClick={handleBackdrop}
    >
      <header className="dialog-heading">
        <div>
          <h2 id="quick-capture-title">{mode === "capture" ? "+ 交入" : "快速搜索与跳转"}</h2>
          <p>{mode === "capture" ? "一句话、拍照或 PDF，先不用选学科填表。" : "快速直达学习页面、材料或历史对话（⌘ / Ctrl + K）。"}</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" /></button>
      </header>
      <div className="quick-tabs" role="tablist" aria-label="快捷入口切换">
        <button type="button" role="tab" aria-selected={mode === "capture"} onClick={() => setMode("capture")}>
          快速交入
        </button>
        <button type="button" role="tab" aria-selected={mode === "search"} onClick={() => setMode("search")}>
          快速跳转
        </button>
      </div>
      {mode === "capture" ? (
        <form onSubmit={submit}>
          <label className="field">
            <span>一句话</span>
            <textarea
              rows={4}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="写下材料里的问题、你的想法，或直接选择拍照 / PDF。"
            />
          </label>
          <label className="quick-file">
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={event => setFile(event.target.files?.[0] ?? undefined)} />
            <span>{file ? file.name : "选择拍照或 PDF"}</span>
            <Icon name="document" />
          </label>
          {error && <p className="error-text" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button className="text-button" type="button" onClick={() => onNavigate("/intake")}>
              打开完整交入页
            </button>
            <button className="text-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || (!text.trim() && !file)}>
              {busy ? "正在交入…" : "交入"} <Icon name="plus" />
            </button>
          </div>
        </form>
      ) : (
        <div>
          <input
            className="quick-search-input"
            type="search"
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="输入页面名称、材料或对话关键词…"
            aria-label="搜索学习页面、材料或对话"
          />
          {searchItems.length > 0 ? (
            <ul className="quick-results">
              {searchItems.map(item => (
                <li key={item.href + item.label}>
                  <button type="button" onClick={() => onNavigate(item.href)}>
                    <span>{item.label}</span>
                    <small>{item.detail}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="drawer-empty" style={{ marginTop: 12 }}>没有匹配项，可以切换到「快速交入」直接记录新材料。</p>
          )}
        </div>
      )}
    </dialog>
  );
}
