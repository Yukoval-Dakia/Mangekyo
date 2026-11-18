import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, remember, remembered, requestId } from './api';
import { Icon } from './icons';
import { PageTitle, materialPath } from './workspace';
import './intake.css';

export type IntakeMetadata = {
  revision: number;
  id: string;
  title: string;
  text: string;
  characterCount: number;
  truncated: boolean;
  fullText: string | null;
  extraction: {
    status: 'ok' | 'partial' | 'failed' | 'corrected';
    method: string;
    error: string | null;
    warnings: string[];
    pages: number | null;
    truncated: boolean;
    characterCount: number;
  };
  original: { name: string; mediaType: string; size: number; sha256: string };
  corrected: boolean;
};

const intakeLimit = 25 * 1024 * 1024;

function fingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function statusLabel(status: IntakeMetadata['extraction']['status']) {
  return status === 'ok' ? '已抽取文字' : status === 'partial' ? '部分抽取' : status === 'corrected' ? '已手动更正' : '抽取失败';
}

function typeLabel(mediaType: string) {
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType.startsWith('image/')) return '照片';
  return mediaType === 'text/markdown' ? 'Markdown' : '文本';
}

export function Intake({}: Record<string, never>) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [request, setRequest] = useState(() => requestId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<IntakeMetadata | null>(null);
  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    if (!selected) return;
    let stored: { fingerprint: string; requestId: string } | null = null;
    try {
      stored = JSON.parse(remembered('intake-pending') ?? 'null');
    } catch {
      stored = null;
    }
    const value = fingerprint(selected);
    const next = stored?.fingerprint === value && typeof stored.requestId === 'string' ? stored.requestId : requestId();
    setFile(selected);
    setRequest(next);
    remember('intake-pending', JSON.stringify({ fingerprint: value, requestId: next }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !file) return;
    if (file.size === 0) {
      setError('这个文件是空的，请换一个。');
      return;
    }
    if (file.size > intakeLimit) {
      setError('文件超过 25 MB，请换一个文件。');
      return;
    }
    const form = new FormData();
    form.set('requestId', request);
    form.set('title', title);
    form.set('file', file);
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/intake', { method: 'POST', body: form });
      const value = (await response.json().catch(() => ({}))) as { error?: string } & Partial<IntakeMetadata>;
      if (!response.ok) throw new Error(value.error ?? '交入失败，文件还在，请再试一次。');
      setResult(value as IntakeMetadata);
      if (remembered('intake-pending') === JSON.stringify({fingerprint: fingerprint(file), requestId: request})) remember('intake-pending', null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '交入失败，文件还在，请再试一次。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle title="交入材料" meta="文件只保存在这台电脑的私人数据目录，不会上传到外部服务。" />
      <section className="intake-panel">
        <form onSubmit={(event) => void submit(event)}>
          <label className="intake-drop">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,.avif,.tif,.tiff,.txt,.md,.markdown"
              disabled={busy}
              onChange={onFile}
            />
            <span className="intake-drop-copy">
              <strong>选择文件</strong>
              <small>支持 PDF、照片、UTF-8 文本和 Markdown，单份不超过 25 MB。</small>
            </span>
          </label>
          <label className="field">
            <span>标题（可以留空）</span>
            <input
              value={title}
              disabled={busy}
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：第三章错题卷"
            />
          </label>
          {file && (
            <p className="intake-file-line">
              <Icon name="document" />
              {file.name} · {Math.round(file.size / 1024)} KB
            </p>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions intake-actions">
            <button type="button" className="text-button" disabled={busy || !file} onClick={() => {
              setFile(null);
              setError('');
            }}>
              重选
            </button>
            <button type="submit" className="primary-button" disabled={busy || !file}>
              {busy ? '正在保存…' : '保存并抽取'}
            </button>
          </div>
        </form>
        <p className="field-help">
          macOS 上 PDF 与照片由系统 PDFKit/Vision 在本机识别；其他系统只原样读取 UTF-8 文本。抽取失败会明确显示，不冒充成功。
        </p>
      </section>
      {result && (
        <section className="intake-result">
          <div className="intake-result-head">
            <div>
              <span className="intake-badge">{statusLabel(result.extraction.status)}</span>
              <h2>{result.title}</h2>
              <p>
                {typeLabel(result.original.mediaType)} · {result.original.size} 字节 · 共 {result.characterCount} 字
              </p>
            </div>
            <a className="tonal-button" href={materialPath(result.id)}>
              打开材料详情 <Icon name="arrow" />
            </a>
          </div>
          <MaterialOriginal id={result.id} />
        </section>
      )}
    </>
  );
}

export function MaterialOriginal({ id, changed }: { id: string; changed?: () => void }) {
  const [metadata, setMetadata] = useState<IntakeMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [plain, setPlain] = useState(false);
  const [error, setError] = useState('');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState('');
  const correctionIntent = useRef<{ text: string; requestId: string } | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setMetadata(await api<IntakeMetadata>('/materials/' + encodeURIComponent(id) + '/import'));
      setPlain(false);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) {
        setPlain(true);
        setMetadata(null);
      } else {
        setError('原件信息暂时无法读取。');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load().finally(() => controller.signal.aborted && undefined);
    return () => controller.abort();
  }, [id]);

  async function saveCorrection(event: FormEvent) {
    event.preventDefault();
    if (correctionBusy || !metadata) return;
    const text = correctionText;
    const next = correctionIntent.current?.text === text ? correctionIntent.current.requestId : requestId();
    correctionIntent.current = { text, requestId: next };
    setCorrectionBusy(true);
    setCorrectionError('');
    try {
      setMetadata(
        await api<IntakeMetadata>('/materials/' + encodeURIComponent(metadata.id) + '/correction', {
          method: 'POST',
          body: { requestId: next, text, expectedRev: metadata.revision },
        }),
      );
      correctionIntent.current = null;
      setCorrectionText(text);
      setCorrectionOpen(false);
      changed?.();
    } catch (correctionFailure) {
      if (correctionFailure instanceof ApiError && correctionFailure.status === 409) {
        setCorrectionError('原文已有新版本。请与上方最新文字核对后再保存，你的编辑还在。');
        void load();
      } else setCorrectionError('更正没有保存，文字还在，请再试一次。');
    } finally {
      setCorrectionBusy(false);
    }
  }

  if (plain) return null;
  if (loading) return <p className="muted" role="status">正在读取原件…</p>;
  if (!metadata)
    return (
      <p className="error-text" role="alert">
        {error} <button className="text-button" onClick={load}>重试</button>
      </p>
    );

  return (
    <section className="intake-original" aria-label="原件与完整抽取">
      <header className="intake-original-head">
        <div>
          <h2>原件与完整抽取</h2>
          <p>
            {metadata.original.name} · {typeLabel(metadata.original.mediaType)} · {metadata.original.size} 字节
          </p>
        </div>
        <a className="tonal-button" href={`/api/materials/${encodeURIComponent(metadata.id)}/original`} download={metadata.original.name}>
          <Icon name="document" /> 下载原件
        </a>
      </header>
      {metadata.extraction.status === 'failed' && (
        <p className="error-text" role="alert">
          没有自动抽取到文字：{metadata.extraction.error ?? '原因未记录。'} 原件仍然保存，可以在下面手动补充。
        </p>
      )}
      {metadata.extraction.warnings.map((warning) => (
        <p key={warning} className="intake-warning">
          {warning}
        </p>
      ))}
      {metadata.fullText !== null && (
        <details className="intake-details" open={metadata.characterCount <= 4000}>
          <summary>完整文字 · {metadata.characterCount} 字</summary>
          <pre className="intake-fulltext">{metadata.fullText}</pre>
        </details>
      )}
      {metadata.truncated && <p className="field-help">材料卡片只显示前 4000 字，完整文字和原件都在这里。</p>}
      <button className="text-button intake-correction-toggle" type="button" onClick={() => {
        if (!correctionOpen) setCorrectionText(metadata.fullText ?? '');
        setCorrectionOpen((open) => !open);
        setCorrectionError('');
      }}>
        {metadata.extraction.status === 'corrected' ? '再更正文字' : '手动补充或更正文字'}
      </button>
      {correctionOpen && (
        <form className="intake-correction" onSubmit={(event) => void saveCorrection(event)}>
          <textarea
            value={correctionText}
            disabled={correctionBusy}
            rows={8}
            onChange={(event) => setCorrectionText(event.target.value)}
            placeholder={metadata.extraction.status === 'failed' ? '在这里写下或粘贴可用文字。' : '改成你认为准确的文字。'}
          />
          {correctionError && <p className="error-text" role="alert">{correctionError}</p>}
          <div className="dialog-actions">
            <button type="button" className="text-button" disabled={correctionBusy} onClick={() => setCorrectionOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={correctionBusy || !correctionText.trim()}>
              {correctionBusy ? '保存中…' : '保存更正'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
