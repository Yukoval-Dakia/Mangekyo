import { RecordQuestionLink, teachingPage } from './current-record';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type RecordFlowMasteryLevel, type WorkspaceRecordFlowSummary } from './api';
import { Icon } from './icons';
import './workspace-access.css';

type EntryKind = 'question' | 'page' | 'concept' | 'relation' | 'observation' | 'annotation';

type AccessItem = {
  id: string;
  rev: number;
  type: string;
  category: string;
  kind?: EntryKind;
  title: string;
  excerpt: string;
  author: 'learner' | 'companion' | 'unknown';
  teaching: boolean;
  eligible: boolean;
  purposes: string[];
} & Partial<WorkspaceRecordFlowSummary>;

type AccessDetail = AccessItem & {
  text: string;
  offset: number;
  nextOffset: number | null;
};

type Provider = {
  id: string;
  label: string;
  model: string;
  baseUrl: string;
  protocol: 'openai' | 'anthropic';
  active: boolean;
  authorized: boolean;
  authorizationStale?: boolean;
};

type AccessPage = {
  items: AccessItem[];
  nextCursor: string | null;
  categories: { id: string; label: string }[];
  activeProviderId: string;
  providers: Provider[];
};

const entryLabels: Record<EntryKind, string> = {
  question: '问题',
  page: '页面',
  concept: '概念',
  relation: '关系',
  observation: '观察',
  annotation: '批注',
};

const categoryLabels: Record<string, string> = {
  practice: '练习',
  paper: '试卷',
  attempt: '作答',
  note: '笔记',
  textbook: '个人教材',
  material: '材料',
  record: '学习记录',
  entry: '生成条目',
};

const masteryLabels: Record<RecordFlowMasteryLevel, string> = {
  unknown: '待摸底',
  fragile: '待巩固',
  developing: '进阶中',
  solid: '稳固',
};

function authorLabel(author: AccessItem['author']) {
  if (author === 'companion') return '学习同伴生成';
  if (author === 'learner') return '本人保存';
  return '来源未标注';
}

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof ApiError && failure.message && !failure.message.startsWith('HTTP ')
    ? failure.message
    : fallback;
}

function MasteryBadge({ level }: { level: RecordFlowMasteryLevel | undefined }) {
  const resolved = level ?? 'unknown';
  return <span className={'access-mastery access-mastery--' + resolved} title={masteryLabels[resolved]} aria-label={masteryLabels[resolved]} />;
}

function FlowCountChip({ label, count }: { label: string; count: number }) {
  if (!count) return null;
  return <span className="m3e-tonal-chip m3e-tonal-chip--quiet">{label} {count}</span>;
}

export function WorkspaceAccessPanel({ disabled = false, textbookAccess = false }: { disabled?: boolean; textbookAccess?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (textbookAccess) heading.current?.focus();
  }, [textbookAccess]);
  const [page, setPage] = useState<AccessPage>();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [categories, setCategories] = useState<{ id: string; label: string }[]>([]);
  const [view, setView] = useState<{ category: string; query: string; cursor: string | undefined }>({
    category: textbookAccess ? 'textbook' : 'all',
    query: '',
    cursor: undefined,
  });
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const [search, setSearch] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailBusy, setDetailBusy] = useState<string>();
  const [openId, setOpenId] = useState<string>();
  const [details, setDetails] = useState<Record<string, AccessDetail>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (view.category !== 'all') params.set('category', view.category);
    if (view.query) params.set('query', view.query);
    if (view.cursor) params.set('cursor', view.cursor);
    api<AccessPage>('/workspace/access' + (params.size ? '?' + params.toString() : ''), {
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted) return;
      setPage(result);
      setProviders(result.providers);
      setCategories(result.categories);
    }).catch((failure) => {
      if (controller.signal.aborted) return;
      setError(failureMessage(failure, '无法读取学习记录访问设置。'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [view, version]);

  function applyView(category: string, query: string) {
    setStack([undefined]);
    setView({ category, query, cursor: undefined });
    setOpenId(undefined);
    setNotice('');
  }

  function searchRecords() {
    applyView(view.category, search.trim());
  }

  function nextPage() {
    if (!page?.nextCursor || loading) return;
    setStack((current) => [...current, page.nextCursor!]);
    setView((current) => ({ ...current, cursor: page.nextCursor! }));
  }

  function previousPage() {
    if (loading || stack.length <= 1) return;
    const next = stack.slice(0, -1);
    setStack(next);
    setView((current) => ({ ...current, cursor: next.at(-1) }));
  }

  async function loadDetail(id: string, offset: number) {
    setDetailBusy(id);
    setError('');
    try {
      const result = await api<AccessDetail>(
        '/workspace/access/records/' + encodeURIComponent(id) +
        '?offset=' + String(offset) + '&limit=6000',
      );
      setDetails((current) => {
        const previous = current[id];
        return {
          ...current,
          [id]: previous && offset > 0
            ? { ...result, text: previous.text + result.text }
            : result,
        };
      });
    } catch (failure) {
      setError(failureMessage(failure, '无法读取这条学习记录。'));
    } finally {
      setDetailBusy((current) => current === id ? undefined : current);
    }
  }

  function toggleDetail(item: AccessItem) {
    if (openId === item.id) {
      setOpenId(undefined);
      return;
    }
    setOpenId(item.id);
    if (!details[item.id]) void loadDetail(item.id, 0);
  }

  const authorized = providers.filter((provider) => provider.authorized);
  const categoryOptions = [{ id: 'all', label: '全部' }, ...categories];
  const currentPage = Math.max(1, stack.length);

  return (
    <section className="settings-section access-panel" aria-labelledby="workspace-access-title">
      <div className="settings-section-heading">
        <h3 id="workspace-access-title" ref={heading} tabIndex={-1}>学习记录访问</h3>
        <span className="settings-meta">{loading ? '读取中…' : currentPage + ' / 分页'}</span>
      </div>
      <p className="field-help">
        这里汇总你已有的练习、试卷、作答、笔记、材料和模型生成的学习条目。
        学习同伴生成的内容会标明作者，不会显示成你的话。
      </p>

      <div className="access-providers" aria-label="模型配置授权">
        <div className="access-subhead">
          <strong>允许哪些模型配置读取</strong>
          <span className={authorized.length ? 'access-status open' : 'access-status'}>
            {authorized.length ? authorized.length + ' 个已授权' : '尚未授权任何模型'}
          </span>
        </div>
        <p className="field-help">
          授权由后台按活跃模型配置统一处理。新增配置、修改地址或协议后，无需逐条点选。
        </p>
        {providers.length === 0 && <p className="settings-empty">还没有模型配置。</p>}
        <div className="access-provider-list">
          {providers.map((provider) => (
            <div className={'access-provider' + (provider.authorized ? ' authorized' : '')} key={provider.id}>
              <span>
                <strong>{provider.label}</strong>
                <small>{provider.model} · {provider.protocol}</small>
              </span>
              <div className="access-provider-meta">
                {provider.active && <span className="access-chip">当前</span>}
                <span className={provider.authorized ? 'access-state open' : 'access-state'}>
                  {provider.authorized
                    ? '已授权'
                    : provider.authorizationStale
                      ? '配置已变化，待自动同步'
                      : '未授权'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="access-records-head">
        <div>
          <strong>我的学习记录</strong>
          <p className="field-help">列表按最新记录分页；展开可查看纯文本全文，不执行网页或脚本。</p>
        </div>
      </div>

      <div className="access-controls">
        <label className="access-search">
          <Icon name="search" />
          <input
            aria-label="搜索学习记录"
            value={search}
            maxLength={120}
            placeholder="搜索标题或正文"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              searchRecords();
            }}
          />
        </label>
        <button type="button" className="tonal-button" disabled={loading} onClick={searchRecords}>
          搜索
        </button>
        {view.query && (
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => {
              setSearch('');
              applyView(view.category, '');
            }}
          >
            清除搜索
          </button>
        )}
      </div>
      <div className="filter-row access-filters" role="group" aria-label="学习记录分类">
        {categoryOptions.map((category) => (
          <button
            key={category.id}
            type="button"
            aria-pressed={view.category === category.id}
            disabled={loading}
            onClick={() => applyView(category.id, view.query)}
          >
            {category.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="error-text">{error}</p>}
      {notice && <p role="status" className="access-notice">{notice}</p>}
      {loading && !page && <p className="settings-empty" role="status">正在读取学习记录…</p>}
      {!loading && page?.items.length === 0 && (
        <p className="settings-empty">
          {view.query ? '没有匹配的学习记录。' : '还没有可在这里管理的学习记录。'}
        </p>
      )}

      <ul className="m3e-seg-list" aria-busy={loading}>
        {page?.items.map((item) => {
          const detail = details[item.id];
          const expanded = openId === item.id;
          const hasFlow = typeof item.attemptCount === 'number' || typeof item.errorStageCount === 'number';
          return (
            <li className="m3e-seg-item access-record" key={item.id}>
              <div className="access-record-head">
                <div className="access-record-copy">
                  <div className="access-record-labels">
                    <span className="access-kind">
                      {item.kind ? entryLabels[item.kind] : categoryLabels[item.category] ?? '记录'}
                    </span>
                    <span>{authorLabel(item.author)}</span>
                  </div>
                  <div className="access-record-title-row">
                    <MasteryBadge level={item.masteryLevel} />
                    <strong>{item.title}</strong>
                  </div>
                  <p>{item.excerpt}</p>
                  {hasFlow && (
                    <div className="access-flow-chips" aria-label="结构化流动摘要">
                      <FlowCountChip label="错因" count={item.errorStageCount ?? 0} />
                      <FlowCountChip label="做题" count={item.attemptCount ?? 0} />
                      <FlowCountChip label="对话" count={item.discussionCount ?? 0} />
                      <FlowCountChip label="关联" count={item.neighborCount ?? 0} />
                      {(item.conceptTags ?? []).slice(0, 3).map((tag) => (
                        <span className="m3e-tonal-chip" key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                  <small className={item.teaching ? 'access-state open' : 'access-state'}>
                    {item.teaching
                      ? '已开放，可被获授权模型读取'
                      : item.purposes.includes('background-research') ? '允许后台使用 · 未开放同伴访问' : '仅本人可见'}
                  </small>
                </div>
                <div className="access-record-actions">
                  {teachingPage(item) && <RecordQuestionLink kind="page" record={item} />}
                  <a className="text-button" href={'/materials/records/' + item.id}>查看工作台</a>
                  <button type="button" className="text-button" onClick={() => toggleDetail(item)}>
                    {expanded ? '收起' : '查看'}
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="access-detail">
                  {detail ? (
                    <>
                      <pre className="access-record-text">{detail.text}</pre>
                      {detail.nextOffset !== null && (
                        <button
                          type="button"
                          className="text-button"
                          disabled={detailBusy === item.id}
                          onClick={() => void loadDetail(item.id, detail.nextOffset!)}
                        >
                          {detailBusy === item.id ? '读取中…' : '继续读取全文'}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="settings-empty" role="status">
                      {detailBusy === item.id ? '正在读取全文…' : '未能读取全文。'}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {(stack.length > 1 || page?.nextCursor) && (
        <div className="access-pagination">
          <button
            type="button"
            className="text-button"
            disabled={loading || stack.length <= 1}
            onClick={previousPage}
          >
            上一页
          </button>
          <span className="settings-meta">第 {currentPage} 页</span>
          <button
            type="button"
            className="text-button"
            disabled={loading || !page?.nextCursor}
            onClick={nextPage}
          >
            下一页
          </button>
        </div>
      )}
    </section>
  );
}
