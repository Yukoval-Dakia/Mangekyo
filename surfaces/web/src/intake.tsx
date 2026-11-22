import { useDraftWatermark } from './draft-watermark';
import { EraseOriginal } from './erasure';
import { latestKey, bindDeletionWatermark, synchronizeDeletion, verifyGenerationReceipt } from './deletion-watermark';
import { enqueue } from './offline-queue';
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, remember, remembered, requestId, submissionId } from './api';
import { Icon } from './icons';
import { IntakeQuestionCards, type IntakeQuestionCard } from './IntakeQuestionCards';
import type { Settings } from './api';
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
    method: 'mineru' | 'pdfkit' | 'vision' | 'vision_llm' | 'vision_fallback' | 'pdfkit+vision' | 'utf8' | 'learner';
    error: string | null;
    warnings: string[];
    pages: number | null;
    truncated: boolean;
    characterCount: number;
    stage?: 'queued' | 'extracting' | 'ready' | 'fallback' | 'failed';
    drafts?: {
      questions: readonly {
        draftId: string;
        index: number;
        questionNumber: string;
        questionType: IntakeQuestionCard['kind'];
        stem: string;
        options: readonly { label: string; text: string }[];
        studentAnswer: IntakeQuestionCard['studentAnswer'];
        redInk: IntakeQuestionCard['redPenMark'];
        unclearSegments: readonly string[];
        conceptTags?: readonly string[];
        pageNumber?: number;
      }[];
    };
  };
  questionCards?: readonly IntakeQuestionCard[];
  original: { name: string; mediaType: string; size: number; sha256: string };
  originals?: readonly { readonly page: number; readonly name: string; readonly mediaType: string; readonly size: number; readonly sha256: string }[];
  pageCount?: number | null;
  pageExtractions?: readonly {
    readonly page: number;
    readonly status: 'pending' | 'ready' | 'fallback' | 'failed';
    readonly method: 'vision_llm' | 'vision_fallback';
    readonly text: string;
    readonly error: string | null;
    readonly warnings: readonly string[];
    readonly questionCount: number;
  }[];
  retryableVisionPages?: readonly number[];
  corrected: boolean;
  backgroundResearch?: 'allowed' | 'private' | 'all';
  requestedExtraction?: 'mineru' | 'vision_llm';
  intakeStatus: 'queued' | 'extracting' | 'ready' | 'fallback' | 'failed';
  canRetryVision: boolean;
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
  pending: '等待识别',
  ok: '已抽取文字',
  partial: '部分抽取',
  corrected: '已手动更正',
  failed: '抽取失败',
};

function extractionStatusLabel(metadata: IntakeMetadata) {
  if (metadata.extraction.status !== 'pending') return statusLabels[metadata.extraction.status];
  return metadata.requestedExtraction === 'mineru' ? '等待 MinerU 识别' : '等待视觉模型识别';
}

function typeLabel(mediaType: string) {
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType.startsWith('image/')) return '照片';
  return mediaType === 'text/markdown' ? 'Markdown' : '文本';
}

function pageStatusLabel(
  status: 'pending' | 'ready' | 'fallback' | 'failed',
  questionCount: number | undefined,
) {
  if (status === 'pending') return '识别中';
  if (status === 'ready') return `已识别${typeof questionCount === 'number' && questionCount > 0 ? ` · ${questionCount} 题` : ''}`;
  if (status === 'fallback') return '基础回退';
  return '识别失败';
}

const maxConceptTags = 6;

function normalizeConceptTags(tags: readonly string[] | undefined) {
  return [...new Set(tags?.map(tag => tag.trim()).filter(Boolean) ?? [])].slice(0, maxConceptTags);
}

function questionCardsFromMetadata(metadata: IntakeMetadata): readonly IntakeQuestionCard[] {
  if (metadata.questionCards) return metadata.questionCards;
  return (metadata.extraction.drafts?.questions ?? []).map(question => {
    const redPenMark = question.redInk;
    const isRedPenError = redPenMark.verdict === 'wrong' || redPenMark.verdict === 'partial' ||
      redPenMark.correction !== null;
    const unclearParts = [
      question.studentAnswer.status === 'unclear'
        ? `学生作答看不清${question.studentAnswer.note ? `（${question.studentAnswer.note}）` : ''}`
        : null,
      redPenMark.verdict === 'unclear' ? '红笔批改看不清' : null,
      question.unclearSegments.length > 0 ? `模糊位置：${question.unclearSegments.join('；')}` : null,
    ].filter((part): part is string => part !== null);
    return {
      draftId: question.draftId,
      index: question.index,
      number: question.questionNumber,
      kind: question.questionType,
      stem: question.stem,
      options: question.options,
      studentAnswer: question.studentAnswer,
      redPenMark,
      conceptTags: normalizeConceptTags(question.conceptTags),
      isRedPenError,
      unclearNotice: unclearParts.length > 0 ? unclearParts.join('；') : null,
      ...(question.pageNumber !== undefined ? { pageNumber: question.pageNumber } : {}),
      defaultSelected: isRedPenError,
    };
  });
}

export function Intake({}: Record<string, never>) {
  const watermark = useDraftWatermark();
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

  useEffect(() => {
    const clear = () => setResult(null);
    const stored = (e:StorageEvent) => {if (e.key === latestKey) clear();};
    window.addEventListener(latestKey,clear);
    window.addEventListener('storage',stored);
    return () => {window.removeEventListener(latestKey,clear);window.removeEventListener('storage',stored);};
  },[]);
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
    if (busy || !file || !watermark.ready) return;
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
    const request = (!startNew && existing?.requestId) || submissionId();
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
      if (!navigator.onLine) {
        if (extraction !== 'local') throw new Error('请在联网后确认云识别。');
        await enqueue({kind:'file',id:request,title,file});
        remember(intentKey,null);
        pending.current.delete(intentKey);
        selectFile(null);
        setTitle('');
        setResult(null);
        return;
      }
      const watermark = bindDeletionWatermark(request);
      await synchronizeDeletion();
      form.set('deletionWatermark',watermark);
      const response = await fetch('/api/intake', { method: 'POST', body: form });
      verifyGenerationReceipt(response,watermark);
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        if (response.status === 410 || failure?.code === 'deletion_watermark_stale') {
          pending.current.delete(intentKey);
          remember(intentKey,null);
          if (storedRequest('intake-pending')?.requestId === request) remember('intake-pending', null);
          selectFile(null);
          setTitle('');
          throw new Error('删除状态已变化，旧提交已清除。需要时请重新选择文件。');
        }
        if (response.status === 409) {
          const conflict = { requestId: request, conflict: true };
          pending.current.set(intentKey, conflict);
          remember(intentKey, JSON.stringify(conflict));
        }
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
          {watermark.notice}
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
            {previous?.conflict && <button type="button" className="primary-button" disabled={busy || !watermark.ready} onClick={() => void submit(true)}>
              {extraction === 'mineru' ? '另开一次并发送给 MinerU' : '另开一次本机交入'}
            </button>}
            {!previous?.conflict && <button type="submit" className="primary-button" disabled={busy || !file || !watermark.ready}>
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

type OriginalProps = {
  id: string;
  receipt?: IntakeMetadata;
  previewText?: string;
  changed?: () => void;
  erase?: () => void;
  settings?: Settings | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  questionCardsFirst?: boolean | undefined;
  onQuestionCardCountChange?: ((materialId: string, count: number) => void) | undefined;
};

export function MaterialOriginal(props: OriginalProps) {
  return <OriginalDetails key={props.id} {...props} />;
}

function OriginalDetails({
  id,
  receipt,
  previewText,
  changed,
  erase,
  settings,
  onNavigate,
  questionCardsFirst,
  onQuestionCardCountChange,
}: OriginalProps) {
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
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [retryVisionBusy, setRetryVisionBusy] = useState(false);
  const [retryVisionError, setRetryVisionError] = useState('');
  const [pageRetryError, setPageRetryError] = useState('');
  const [retryingPage, setRetryingPage] = useState<number | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [pageImageFailed, setPageImageFailed] = useState<ReadonlySet<number>>(new Set());
  const [appendBusy, setAppendBusy] = useState(false);
  const [appendError, setAppendError] = useState('');
  const appendInput = useRef<HTMLInputElement>(null);
  const correctionIntent = useRef<{ text: string; revision: number; requestId: string } | null>(null);
  const reportedQuestionCards = useRef<string | null>(null);
  const questionCardCount = metadata ? questionCardsFromMetadata(metadata).length : 0;

  useEffect(() => {
    if (!metadata) return;
    const reportKey = `${metadata.id}:${questionCardCount}`;
    if (reportedQuestionCards.current === reportKey) return;
    reportedQuestionCards.current = reportKey;
    onQuestionCardCountChange?.(metadata.id, questionCardCount);
  }, [metadata, onQuestionCardCountChange, questionCardCount]);

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

  function adoptMetadata(value: IntakeMetadata) {
    if (latest.current && latest.current.revision > value.revision) return;
    readGeneration.current += 1;
    latest.current = value;
    setMetadata(value);
    setError('');
    setPollPaused(false);
  }

  async function changeResearch(enabled: boolean) {
    if (!metadata || researchBusy || correctionBusy) return;
    setResearchBusy(true);
    setResearchError('');
    try {
      adoptMetadata(await api<IntakeMetadata>('/materials/' + encodeURIComponent(id) + '/research-permission', {
        method: 'PUT', body: {expectedRev: metadata.revision, enabled},
      }));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setResearchError('原件版本已更新。请核对最新状态后重试。');
        setRefresh(n => n + 1);
      } else setResearchError('后台用途未更新，请重试。');
    } finally {
      setResearchBusy(false);
    }
  }

  async function retryVision() {
    if (!metadata || retryVisionBusy) return;
    setRetryVisionBusy(true);
    setRetryVisionError('');
    try {
      const value = await api<IntakeMetadata>(`/materials/${encodeURIComponent(metadata.id)}/retry-vision`, {
        method: 'POST',
        body: { requestId: requestId(), expectedRev: metadata.revision },
      });
      adoptMetadata(value);
      setRefresh(count => count + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setRetryVisionError('这份材料已更新或当前状态不能重识别，正在为你刷新最新状态。');
        setRefresh(count => count + 1);
      } else {
        setRetryVisionError('视觉重识别暂时没有排队，请稍后重试。');
      }
    } finally {
      setRetryVisionBusy(false);
    }
  }

  async function retryVisionPage(page: number) {
    if (!metadata || retryingPage !== null || retryVisionBusy) return;
    setRetryingPage(page);
    setPageRetryError('');
    try {
      const value = await api<IntakeMetadata>(`/materials/${encodeURIComponent(metadata.id)}/retry-vision`, {
        method: 'POST',
        body: { requestId: requestId(), expectedRev: metadata.revision, pages: [page] },
      });
      adoptMetadata(value);
      setRefresh(count => count + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setPageRetryError('这份材料已更新或当前状态不能重识别，正在为你刷新最新状态。');
        setRefresh(count => count + 1);
      } else {
        setPageRetryError(`第 ${page} 页重识别暂时没有排队，请稍后重试。`);
      }
    } finally {
      setRetryingPage(null);
    }
  }

  async function appendPages(files: readonly File[]) {
    if (!metadata || appendBusy || files.length === 0) return;
    const images = files.filter(item => item.type.startsWith('image/'));
    if (images.length === 0) {
      setAppendError('续拍加页仅支持照片。');
      return;
    }
    const current = metadata.pageCount ?? metadata.originals?.length ?? 1;
    const room = 6 - current;
    if (room <= 0) {
      setAppendError('这份试卷已满 6 页，无法再加页。');
      return;
    }
    const accepted = images.slice(0, room);
    if (images.length > room) {
      setAppendError(`最多还能加 ${room} 页，已先收前 ${room} 张。`);
    }
    const oversize = accepted.filter(item => item.size > intakeLimit);
    const usable = accepted.filter(item => item.size <= intakeLimit && item.size > 0);
    if (oversize.length > 0) {
      setAppendError(`「${oversize[0]!.name}」超过 25 MB，请先压缩后再加页。`);
    }
    if (usable.length === 0) return;
    setAppendBusy(true);
    setAppendError('');
    try {
      const form = new FormData();
      form.set('requestId', requestId());
      form.set('expectedRev', String(metadata.revision));
      for (const file of usable) form.append('files', file);
      const response = await fetch(`/api/materials/${encodeURIComponent(metadata.id)}/pages`, {
        method: 'POST',
        body: form,
      });
      if (response.status === 404) {
        setAppendError('这台后端还没有上线续拍加页，请更新后再试。');
        return;
      }
      if (response.status === 409) {
        setAppendError('原件版本已更新，正在为你刷新最新状态。');
        setRefresh(count => count + 1);
        return;
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        setAppendError(typeof failure?.error === 'string' ? failure.error : '续拍加页未能完成，请再试一次。');
        return;
      }
      const value = (await response.json()) as IntakeMetadata;
      if (!value?.id) {
        setAppendError('续拍回执不完整，请刷新查看。');
        return;
      }
      adoptMetadata(value);
      setRefresh(count => count + 1);
    } catch {
      setAppendError('续拍加页未能完成，请再试一次。');
    } finally {
      setAppendBusy(false);
      if (appendInput.current) appendInput.current.value = '';
    }
  }

  async function saveCorrection(event: FormEvent) {
    event.preventDefault();
    if (correctionBusy || researchBusy || !metadata) return;
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
      adoptMetadata(value);
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

  const pageCount = metadata.pageCount ?? metadata.originals?.length ??
    (metadata.original.mediaType.startsWith('image/') ? 1 : null);
  const pageExtractions = metadata.pageExtractions ?? [];
  const retryablePages = new Set(metadata.retryableVisionPages ?? []);
  const isPhotoMaterial = metadata.original.mediaType.startsWith('image/');
  const currentPage = Math.min(Math.max(1, activePage), pageCount ?? 1);

  const questionCards = (
    <IntakeQuestionCards
      materialId={metadata.id}
      materialTitle={metadata.title}
      materialRev={metadata.revision}
      extractionStatus={metadata.extraction.status}
      initialCards={questionCardsFromMetadata(metadata)}
      settings={settings}
      onNavigate={onNavigate}
    />
  );

  return (
    <section className={`intake-original${questionCardsFirst ? ' intake-original-cards-first' : ''}`} aria-label="原件与完整抽取">
      {erase && <EraseOriginal id={id} revision={metadata.revision} onConfirmed={erase}/>}
      {questionCardsFirst ? questionCards : null}
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
      {isPhotoMaterial && pageCount !== null && pageCount >= 1 && (
        <div className="intake-pages" aria-label="分页原图">
          <div className="intake-pages-strip" role="group" aria-label="切换页面">
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => {
              const extraction = pageExtractions.find(item => item.page === page);
              const status = extraction?.status ?? 'pending';
              const label = pageCount > 1 ? `第 ${page} 页` : '原图';
              return (
                <button
                  key={page}
                  type="button"
                  className={`intake-page-tab${page === currentPage ? ' is-active' : ''}`}
                  aria-pressed={page === currentPage}
                  aria-label={`${label}（${pageStatusLabel(status, extraction?.questionCount)}）`}
                  onClick={() => setActivePage(page)}
                >
                  <span className="intake-page-tab-no">{label}</span>
                  <span className={`intake-page-status is-${status}`}>{pageStatusLabel(status, extraction?.questionCount)}</span>
                </button>
              );
            })}
          </div>
          <div className="intake-page-preview">
            {!pageImageFailed.has(currentPage) ? (
              <img
                key={currentPage}
                src={
                  pageCount > 1
                    ? `/api/materials/${encodeURIComponent(metadata.id)}/pages/${currentPage}/original`
                    : `/api/materials/${encodeURIComponent(metadata.id)}/original`
                }
                alt={`试卷第 ${currentPage} 页原图`}
                onError={() => setPageImageFailed(current => new Set(current).add(currentPage))}
              />
            ) : (
              <p className="intake-page-fallback">第 {currentPage} 页原图暂时无法预览，可点右上角「下载原件」查看。</p>
            )}
          </div>
          <div className="intake-page-meta">
            {retryablePages.has(currentPage) && (
              <button
                type="button"
                className="tonal-button"
                disabled={retryingPage !== null || retryVisionBusy}
                onClick={() => void retryVisionPage(currentPage)}
              >
                {retryingPage === currentPage ? `正在重试第 ${currentPage} 页…` : `重试第 ${currentPage} 页`}
              </button>
            )}
            {isPhotoMaterial && (pageCount ?? 1) < 6 && (
              <>
                <input
                  ref={appendInput}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.heic,.heif,.avif,.tif,.tiff"
                  multiple
                  hidden
                  onChange={event => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void appendPages(files);
                  }}
                />
                <button
                  type="button"
                  className="text-button"
                  disabled={appendBusy}
                  onClick={() => appendInput.current?.click()}
                >
                  {appendBusy ? '正在加页…' : `继续拍下一页（还可加 ${6 - (pageCount ?? 1)} 页）`}
                </button>
              </>
            )}
          </div>
          {appendError && <p className="error-text" role="alert">{appendError}</p>}
          {pageRetryError && (
            <p className="error-text" role="alert">{pageRetryError}</p>
          )}
        </div>
      )}
      <p className="intake-extraction-status" role="status">
        <span className="intake-badge">{extractionStatusLabel(metadata)}</span>
        {metadata.extraction.status === 'pending' && (
          <span>{pollPaused ? '自动更新已暂停。' : '识别结果会在这里更新。'}也可稍后从<a href="/materials">材料列表</a>回来查看。</span>
        )}
      </p>
      {metadata.canRetryVision && (
        <div className="intake-retry-vision">
          <button className="tonal-button" type="button" disabled={retryVisionBusy} onClick={() => void retryVision()}>
            {retryVisionBusy ? '正在重新排队…' : '重新用视觉模型识别'}
          </button>
          {retryVisionError && <p className="error-text" role="alert">{retryVisionError}</p>}
        </div>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      {(pollPaused || error) && <button className="text-button" onClick={() => setRefresh(n => n + 1)}>刷新状态</button>}
      {questionCardsFirst ? null : questionCards}
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
      {metadata.backgroundResearch && <div className="intake-research">
        <label>
          <input type="checkbox" checked={metadata.backgroundResearch !== 'private'}
            disabled={researchBusy || correctionBusy || metadata.backgroundResearch === 'all'}
            onChange={event => void changeResearch(event.target.checked)} /> 允许后台使用更正文字
        </label>
        <p className="field-help">{metadata.backgroundResearch === 'all'
          ? '这份原件已设置为全部用途。'
          : '后台可用你保存的更正文字整理学习观察。'}</p>
        {researchBusy && <p className="field-help" role="status">正在更新用途…</p>}
        {researchError && <p className="error-text" role="alert">{researchError}</p>}
      </div>}
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
            <button className="primary-button" disabled={correctionBusy || researchBusy || !correctionText.trim()}>
              {correctionBusy ? '保存中…' : '保存更正'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
