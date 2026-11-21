import { useEffect, useMemo, useState } from 'react';
import type { MemoryCategoryKey, MemoryItem, MemoryOverviewPanelProps, MemoryOverviewState } from './types';
import { memoryOverviewDefaults } from './memory-overview-data';
import { CalibrationCard } from './CalibrationCard';
import { MemoryItemCard } from './MemoryItemCard';
import './memory-overview.css';

const categoryCards: { key: MemoryCategoryKey; title: string; copy: string }[] = [
  { key: 'preference', title: '学习偏好', copy: '你对讲解方式、节奏和例子偏好的长期选择' },
  { key: 'claim', title: '长期断言', copy: '已经被持续保留的稳定理解' },
  { key: 'state', title: '短期状态', copy: '当前阶段性目标、情境和临时限制' },
  { key: 'refusal', title: '明确拒绝', copy: '你明确不想继续或不想被使用的内容' },
];

const categoryKeys = new Set<MemoryCategoryKey>(categoryCards.map((card) => card.key));

function categoryOf(kind: string): MemoryCategoryKey {
  return categoryKeys.has(kind as MemoryCategoryKey) ? (kind as MemoryCategoryKey) : 'claim';
}

function filterFor(item: MemoryItem): MemoryCategoryKey {
  if (item.section === 'directive') return item.kind === 'directive' ? 'refusal' : categoryOf(item.kind);
  return categoryOf(item.kind);
}

export function MemoryOverviewPanel({
  fetchJson = memoryOverviewDefaults.fetchOverview,
  onUpdateItem = memoryOverviewDefaults.updateItem,
  onWithdrawItem = memoryOverviewDefaults.withdrawItem,
  initialOverview,
}: MemoryOverviewPanelProps) {
  const [state, setState] = useState<MemoryOverviewState>(
    initialOverview ? { status: 'ready', data: initialOverview } : { status: 'loading' },
  );
  const [category, setCategory] = useState<MemoryCategoryKey>('preference');

  useEffect(() => {
    if (initialOverview) return;
    let cancelled = false;
    setState({ status: 'loading' });
    fetchJson('/memory/overview')
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error) => {
        if (cancelled) return;
        const status = (error as Error & { status?: number }).status;
        setState({
          status: 'error',
          code: status === 404 ? 'not-found' : status === 0 ? 'parse' : 'network',
          message: status === 404 ? '记忆总览服务尚未就绪。' : '暂时无法读取记忆总览。',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchJson, initialOverview]);

  const items = useMemo(() => {
    if (state.status !== 'ready') return [] as MemoryItem[];
    const directives: MemoryItem[] = state.data.stickyDirectives.map((item) => ({ ...item, section: 'directive' as const }));
    const hypotheses: MemoryItem[] = state.data.hypotheses.map((item) => ({ ...item, section: 'hypothesis' as const }));
    return [...directives, ...hypotheses];
  }, [state]);

  const directiveItems = items.filter((item) => item.section === 'directive');
  const hypothesisItems = items.filter((item) => item.section === 'hypothesis');
  const visibleDirectives = directiveItems.filter((item) => filterFor(item) === category);
  const visibleHypotheses = hypothesisItems.filter((item) => filterFor(item) === category);

  return (
    <section className="memory-overview" aria-labelledby="memory-overview-title">
      <div className="subhead">
        <div>
          <h2 id="memory-overview-title">我的记忆与画像</h2>
          <p>看见系统如何记住你，也保留随时修改与撤回的权利。</p>
        </div>
      </div>

      {state.status === 'loading' && <p className="memory-panel-notice">正在读取你的记忆画像…</p>}

      {state.status === 'error' && (
        <div className="memory-panel-notice is-error" role="alert">
          <p>{state.message}</p>
          <p className="memory-muted">如果是首次启用或网络暂不可达，请稍后重试。</p>
          <button type="button" className="tonal-button" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="memory-category-grid" role="tablist" aria-label="记忆类别">
            {categoryCards.map((card) => {
              const active = category === card.key;
              const count = state.data.categories[card.key];
              return (
                <button
                  key={card.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`memory-category-card ${active ? 'is-active' : ''}`}
                  onClick={() => setCategory(card.key)}
                >
                  <span className="memory-count">{count}</span>
                  <strong>{card.title}</strong>
                  <small>{card.copy}</small>
                </button>
              );
            })}
          </div>

          <div className="memory-section-grid">
            <section className="memory-column" aria-labelledby="memory-directive-title">
              <div className="subhead compact">
                <h3 id="memory-directive-title">粘性指令</h3>
                <span>{state.data.stickyDirectives.length} 条</span>
              </div>
              <div className="memory-stack">
                {visibleDirectives.length ? (
                  visibleDirectives.map((item) => <MemoryItemCard key={item.id} item={item} onUpdateItem={onUpdateItem} onWithdrawItem={onWithdrawItem} />)
                ) : (
                  <p className="memory-empty">当前没有始终生效的记忆指令。</p>
                )}
              </div>
            </section>

            <section className="memory-column" aria-labelledby="memory-hypothesis-title">
              <div className="subhead compact">
                <h3 id="memory-hypothesis-title">学习理解</h3>
                <span>{state.data.hypotheses.length} 条</span>
              </div>
              <div className="memory-stack">
                {visibleHypotheses.length ? (
                  visibleHypotheses.map((item) => <MemoryItemCard key={item.id} item={item} onUpdateItem={onUpdateItem} onWithdrawItem={onWithdrawItem} />)
                ) : (
                  <p className="memory-empty">当前类别下没有学习理解记录。</p>
                )}
              </div>
            </section>
          </div>

          <CalibrationCard calibration={state.data.calibration} />
        </>
      )}
    </section>
  );
}
