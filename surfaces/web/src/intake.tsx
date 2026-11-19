import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
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
    status: 'pending' | 'ok' | 'partial' | 'failed' | 'corrected';
    method: 'mineru' | 'pdfkit' | 'vision' | 'pdfkit+vision' | 'utf8' | 'learner';
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

type Extraction = 'local' | 'mineru';
type PendingRequest = { requestId: string; conflict?: boolean };

// Match the intake endpoint's title, including its filename fallback.
function intakeTitle(input: string, file: File) {
  const controls = /[\u0000-\u001f\u007f]/g;
  const title = input.trim().replace(controls, '').slice(0, 240);
  const name = file.name.replace(/\\/g, '/').split('/').pop()!.replace(controls, '').trim().slice(0, 180);
  return title && title.isWellFormed() ? title : name.replace(/\.[^.]+$/, '') || '材料原件';
}

type StoredRequest = PendingRequest & { fingerprint?: string; extraction?: Extraction };

function storedRequest(key: string): StoredRequest | null {
  try {
    const value = JSON.parse(remembered(key) ?? 'null');
    return value && typeof value.requestId === 'string' && value.requestId.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function legacyRequest(identity: string, extraction: Extraction): PendingRequest | null {
  const value = storedRequest('intake-pending');
  if (value?.fingerprint !== identity || (value.extraction ?? 'local') !== extraction) return null;
  return { requestId: value.requestId };
}

function supportsMineru(file: File) {
  const supportedType = ['application/pdf', 'image/png', 'image/jpeg'].includes(file.type);
  const unknownType = !file.type || file.type === 'application/octet-stream';
  return supportedType || (unknownType && /\.(pdf|png|jpe?g)$/i.test(file.name));
}

const statusLabels = {
  pending: '等待 MinerU 识别',
  ok: '已抽取文字',
  partial: '部分抽取',
  corrected: '已手动更正',
  failed: '抽取失败',
};

function typeLabel(mediaType: string) {
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType.startsWith('image/')) return '照片';
  return mediaType === 'text/markdown' ? 'Markdown' : '文本';
}

export function Intake({}: Record<string, never>) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [mineruAvailable, setMineruAvailable] = useState(false);
  const [extraction, setExtraction] = useState<Extraction>('local');
  const pending = useRef(new Map<string, PendingRequest>());
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<IntakeMetadata | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ mineru: boolean }>('/intake/options', { signal: controller.signal })
      .then(options => {
        if (!controller.signal.aborted) setMineruAvailable(options.mineru === true);
      })
      .catch(() => {}); // Local extraction remains available offline.
    return () => controller.abort();
  }, []);

  function selectFile(selected: File | null) {
    setFile(selected);
    setExtraction('local');
    setError('');
    if (!selected && fileInput.current) fileInput.current.value = '';
  }

  const identity = file ? fingerprint(file) : '';
  const normalizedTitle = file ? intakeTitle(title, file) : '';
  const intentKey = 'intake-pending:v2:' + JSON.stringify([identity, extraction, normalizedTitle]);
  const cloudAllowed = mineruAvailable && file !== null && supportsMineru(file);

  function matchingRequest(): PendingRequest | null {
    return storedRequest(intentKey) ?? pending.current.get(intentKey) ?? legacyRequest(identity, extraction);
  }

  const previous = file && matchingRequest();

  async function submit(startNew = false) {
    if (busy || !file) return;
    if (file.size === 0) {
      setError('这个文件是空的，请换一个。');
      return;
    }
    if (file.size > intakeLimit) {
      setError('文件超过 25 MB，请换一个文件。');
      return;
    }
    if (extraction === 'mineru' && !cloudAllowed) {
      setError('这份文件无法使用 MinerU，请选择本机抽取。');
      return;
    }
    const existing = matchingRequest();
    if (startNew !== (existing?.conflict === true)) return;
    const request = (!startNew && existing?.requestId) || requestId();
    const record: PendingRequest = { requestId: request };
    remember(intentKey, JSON.stringify(record));
    if (extraction === 'mineru' && storedRequest(intentKey)?.requestId !== request) {
      setError('浏览器无法保存重试标识。请允许本地存储后再发送给 MinerU。');
      return;
    }
    pending.current.set(intentKey, record);
    const form = new FormData();
    form.set('extraction', extraction);
    form.set('requestId', request);
    form.set('title', title);
    form.set('file', file);
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/intake', { method: 'POST', body: form });
      if (!response.ok) {
        if (response.status === 409) {
          const conflict = { requestId: request, conflict: true };
          pending.current.set(intentKey, conflict);
          remember(intentKey, JSON.stringify(conflict));
        }
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error ?? '交入未确认，请再试一次。');
      }
      const value: IntakeMetadata = await response.json();
      if (!value?.id || !value.original || !value.extraction) throw new Error('未收到完整回执，请继续原提交。');
      setResult(value);
      if (storedRequest(intentKey)?.requestId === request) remember(intentKey, null);
      if (storedRequest('intake-pending')?.requestId === request) remember('intake-pending', null);
      pending.current.delete(intentKey);
      selectFile(null);
      setTitle('');
    } catch (submitError) {
      setError(submitError instanceof Error && !(submitError instanceof TypeError || submitError instanceof SyntaxError)
        ? submitError.message : '交入结果尚未确认。请继续原提交以取回回执。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle title="交入材料" meta="原件保存在这台电脑的私人数据目录。" />
      <section className="intake-panel">
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <label className="intake-drop">
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,.avif,.tif,.tiff,.txt,.md,.markdown"
              disabled={busy}
              ref={fileInput}
              onChange={event => selectFile(event.target.files?.[0] ?? null)}
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
              onChange={event => { setTitle(event.target.value); setError(''); }}
              placeholder="例如：第三章错题卷"
            />
          </label>
          {file && (
            <p className="intake-file-line">
              <Icon name="document" />
              {file.name} · {Math.round(file.size / 1024)} KB
            </p>
          )}
          {cloudAllowed && (
            <fieldset className="intake-extraction" disabled={busy} aria-describedby="extraction-destination">
              <legend>文字抽取方式</legend>
              <div className="intake-methods">
                {(['local', 'mineru'] as const).map(method => (
                  <label key={method}>
                    <input type="radio" name="extraction" checked={extraction === method}
                      onChange={() => { setExtraction(method); setError(''); }} />
                    {method === 'local' ? '本机抽取' : 'MinerU 云识别'}
                  </label>
                ))}
              </div>
              <p className="field-help" id="extraction-destination">
                {extraction === 'mineru' ? '提交后会把这份原件发送给 MinerU 识别。' : '文件仅在本机处理。'}
              </p>
            </fieldset>
          )}
          {!cloudAllowed && <p className="field-help">文件仅在本机处理。macOS 支持 PDF 和照片识别，UTF-8 文本可直接读取。</p>}
          {file && <p className="field-help">
            {previous?.conflict ? <>原提交标识有冲突，请先到<a href="/materials">材料列表</a>核对。另开一次会创建新材料{extraction === 'mineru' ? '，并可能再次产生识别费用' : ''}。</>
              : previous ? '有尚未确认的提交。继续会沿用原请求标识。'
              : '本次将新建材料。更改标题或抽取方式会另开一次交入；切回原选项可继续未确认的提交。'}
          </p>}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions intake-actions">
            <button type="button" className="text-button" disabled={busy || !file} onClick={() => selectFile(null)}>
              重选
            </button>
            {previous?.conflict && <button type="button" className="primary-button" disabled={busy} onClick={() => void submit(true)}>
              {extraction === 'mineru' ? '另开一次并发送给 MinerU' : '另开一次本机交入'}
            </button>}
            {!previous?.conflict && <button type="submit" className="primary-button" disabled={busy || !file}>
              {busy ? '正在保存…' : extraction === 'mineru' ? (previous ? '继续原提交给 MinerU' : '保存并发送给 MinerU') : (previous ? '继续原提交' : '保存并抽取')}
            </button>}
          </div>
        </form>
      </section>
      {result && (
        <section className="intake-result">
          <div className="intake-result-head">
            <div>
              <span className="intake-badge">原件已保存</span>
              <h2>{result.title}</h2>
              <p>
                {typeLabel(result.original.mediaType)} · {result.original.size} 字节
              </p>
            </div>
            <a className="tonal-button" href={materialPath(result.id)}>
              打开材料详情 <Icon name="arrow" />
            </a>
          </div>
          <MaterialOriginal id={result.id} receipt={result} />
        </section>
      )}
    </>
  );
}

type OriginalProps = { id: string; receipt?: IntakeMetadata; previewText?: string; changed?: () => void };

export function MaterialOriginal(props: OriginalProps) {
  return <OriginalDetails key={props.id} {...props} />;
}

function OriginalDetails({ id, receipt, previewText, changed }: OriginalProps) {
  const [metadata, setMetadata] = useState<IntakeMetadata | null>(receipt ?? null);
  const latest = useRef(receipt);
  const readGeneration = useRef(0);
  const [refresh, setRefresh] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const currentIsPending = useEffectEvent(() => metadata?.extraction.status === 'pending');
  const syncPreview = useEffectEvent((text: string) => {
    if (previewText !== text) changed?.();
  });
  const [plain, setPlain] = useState(false);
  const [error, setError] = useState('');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionError, setCorrectionError] = useState('');
  const correctionIntent = useRef<{ text: string; revision: number; requestId: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const generation = readGeneration.current;
    const stale = () => signal.aborted || generation !== readGeneration.current;
    setPollPaused(false);
    setError('');

    async function read(wasPending: boolean) {
      if (stale()) return;
      try {
        const value = await api<IntakeMetadata>('/materials/' + encodeURIComponent(id), { signal });
        if (stale()) return;
        if (latest.current && latest.current.revision > value.revision) {
          if (latest.current.extraction.status === 'pending') schedule();
          return;
        }
        latest.current = value;
        setMetadata(value);
        setPlain(false);
        setError('');
        if (value.extraction.status === 'pending') schedule();
        else syncPreview(value.text);
      } catch (loadError) {
        if (stale()) return;
        if (wasPending) {
          setError('暂时无法更新识别状态。');
          schedule();
        } else if (loadError instanceof ApiError && loadError.status === 404) {
          setPlain(true);
        } else {
          setError('原件信息暂时无法读取。');
        }
      }
    }

    function schedule() {
      if (attempts >= 24) {
        setPollPaused(true);
        return;
      }
      attempts += 1;
      timer = setTimeout(() => void read(true), 5000);
    }

    if (refresh > 0 || !receipt) void read(currentIsPending());
    else if (receipt.extraction.status === 'pending') schedule();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, receipt, refresh]);

  async function saveCorrection(event: FormEvent) {
    event.preventDefault();
    if (correctionBusy || !metadata) return;
    const text = correctionText;
    const revision = metadata.revision;
    const previous = correctionIntent.current;
    const next = previous?.text === text && previous.revision === revision ? previous.requestId : requestId();
    correctionIntent.current = { text, revision, requestId: next };
    setCorrectionBusy(true);
    setCorrectionError('');
    try {
      const value = await api<IntakeMetadata>('/materials/' + encodeURIComponent(metadata.id) + '/correction', {
        method: 'POST',
        body: { requestId: next, text, expectedRev: revision },
      });
      if (!latest.current || value.revision >= latest.current.revision) {
        readGeneration.current += 1;
        latest.current = value;
        setMetadata(value);
        setError('');
        setPollPaused(false);
      }
      correctionIntent.current = null;
      setCorrectionText(text);
      setCorrectionOpen(false);
      changed?.();
    } catch (correctionFailure) {
      if (correctionFailure instanceof ApiError && correctionFailure.status === 409) {
        setCorrectionError('原文已有新版本。请与上方最新文字核对后再保存，你的编辑还在。');
        setRefresh(n => n + 1);
      } else setCorrectionError('更正没有保存，文字还在，请再试一次。');
    } finally {
      setCorrectionBusy(false);
    }
  }

  if (plain) return null;
  if (!metadata && !error) return <p className="muted" role="status">正在读取原件…</p>;
  if (!metadata)
    return (
      <p className="error-text" role="alert">
        {error} <button className="text-button" onClick={() => setRefresh(n => n + 1)}>重试</button>
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
      <p className="intake-extraction-status" role="status">
        <span className="intake-badge">{statusLabels[metadata.extraction.status]}</span>
        {metadata.extraction.status === 'pending' && (
          <span>{pollPaused ? '自动更新已暂停。' : '识别结果会在这里更新。'}也可稍后从<a href="/materials">材料列表</a>回来查看。</span>
        )}
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {(pollPaused || error) && <button className="text-button" onClick={() => setRefresh(n => n + 1)}>刷新状态</button>}
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
      {metadata.extraction.status !== 'pending' && metadata.fullText !== null && (
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
