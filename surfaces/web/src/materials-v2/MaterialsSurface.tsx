import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../icons';
import { QuestionBankTab } from './QuestionBankTab';
import type { MaterialsSurfaceProps, MaterialsTabId, MaterialsTabMeta } from './types';
import './materials-v2.css';

export const MATERIALS_TABS: readonly MaterialsTabMeta[] = [
  {
    id: 'graph',
    label: '知识图谱',
    description: '概念掌握态、薄弱前置关系与跨源知识连边',
  },
  {
    id: 'bank',
    label: '题库与错题',
    description: '按母题折叠变式题簇，追踪待固题与历史错题',
  },
  {
    id: 'textbooks',
    label: '个人教材',
    description: '活教材章节、原位微探针与蒸馏急救卡',
  },
  {
    id: 'papers',
    label: '试卷与课堂',
    description: '试卷练习、清洁打印与学习型课堂统一入口',
  },
  {
    id: 'originals',
    label: '原件与笔记',
    description: '原件库、拍卷切片、Notion 只读来源与个人笔记',
  },
];

const TAB_ID_SET = new Set<string>(MATERIALS_TABS.map(tab => tab.id));

export function isMaterialsTabId(value: string | null | undefined): value is MaterialsTabId {
  return typeof value === 'string' && TAB_ID_SET.has(value);
}

export function readMaterialsTabFromSearch(search: string): MaterialsTabId | null {
  const params = new URLSearchParams(search);
  const tabParam = params.get('tab');
  if (isMaterialsTabId(tabParam)) return tabParam;
  if (params.get('view') === 'iqdb') return 'bank';
  return null;
}

export function writeMaterialsTabToUrl(tab: MaterialsTabId, mode: 'replace' | 'push' = 'replace'): void {
  if (typeof window === 'undefined' || !window.history) return;
  const current = new URL(window.location.href);
  current.searchParams.set('tab', tab);
  if (current.searchParams.get('view') === 'iqdb' && tab !== 'bank') {
    current.searchParams.delete('view');
  }
  const nextUrl = `${current.pathname}${current.search}${current.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextUrl === currentUrl) return;
  if (mode === 'push') window.history.pushState(window.history.state, '', nextUrl);
  else window.history.replaceState(window.history.state, '', nextUrl);
}

function TabIcon({ tab }: { readonly tab: MaterialsTabId }) {
  if (tab === 'graph') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="18" cy="6.5" r="2.5" />
        <circle cx="18" cy="17.5" r="2.5" />
        <path d="M8.3 10.9 15.7 7.6M8.3 13.1l7.4 3.3" />
      </svg>
    );
  }
  if (tab === 'bank') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z" />
        <path d="m3.5 12 8.5 4.5 8.5-4.5" />
        <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
      </svg>
    );
  }
  if (tab === 'textbooks') {
    return <Icon name="book" />;
  }
  if (tab === 'papers') {
    return <Icon name="practice" />;
  }
  return <Icon name="document" />;
}

function SectionIntro({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="mv2-slot-header">
      <div className="mv2-slot-copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action && <div className="mv2-slot-action">{action}</div>}
    </div>
  );
}

function DefaultGraphPlaceholder() {
  return (
    <div className="mv2-placeholder-card">
      <div className="mv2-placeholder-icon" aria-hidden="true">
        <TabIcon tab="graph" />
      </div>
      <h3>知识图谱视图待挂载</h3>
      <p>
        此处将呈现按学科概念聚合的掌握度图谱、薄弱前置提醒以及题目与笔记之间的跨源连边。
      </p>
    </div>
  );
}

export function MaterialsSurface({
  activeTab: controlledTab,
  defaultTab = 'bank',
  onTabChange,
  syncUrl = true,
  historyMode = 'replace',
  title = '材料',
  subtitle = '图谱、题库错题、教材、试卷课堂与原件笔记统一收束于此',
  headerAction,
  theme,
  renderGraph,
  renderBank,
  renderTextbooks,
  renderPapers,
  renderOriginals,
  bankProps,
  onCaptureMaterial,
  onNavigate,
}: MaterialsSurfaceProps) {
  const isControlled = controlledTab !== undefined;
  const [internalTab, setInternalTab] = useState<MaterialsTabId>(() => {
    if (controlledTab) return controlledTab;
    if (syncUrl && typeof window !== 'undefined') {
      const fromUrl = readMaterialsTabFromSearch(window.location.search);
      if (fromUrl) return fromUrl;
    }
    return defaultTab;
  });
  const tabRefs = useRef<Partial<Record<MaterialsTabId, HTMLButtonElement | null>>>({});
  const currentTab: MaterialsTabId = isControlled ? controlledTab : internalTab;

  useEffect(() => {
    if (!syncUrl || typeof window === 'undefined') return;
    const onPopState = () => {
      const fromUrl = readMaterialsTabFromSearch(window.location.search);
      if (!fromUrl) return;
      if (!isControlled) setInternalTab(fromUrl);
      onTabChange?.(fromUrl);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [isControlled, onTabChange, syncUrl]);

  const selectTab = useCallback(
    (nextTab: MaterialsTabId, shouldFocus = false) => {
      if (!isControlled) setInternalTab(nextTab);
      if (syncUrl) writeMaterialsTabToUrl(nextTab, historyMode);
      onTabChange?.(nextTab);
      if (shouldFocus) {
        const button = tabRefs.current[nextTab];
        button?.focus();
        button?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    },
    [historyMode, isControlled, onTabChange, syncUrl],
  );

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % MATERIALS_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + MATERIALS_TABS.length) % MATERIALS_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = MATERIALS_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const target = MATERIALS_TABS[nextIndex];
    if (target) selectTab(target.id, true);
  };

  const mergedBankProps = {
    ...(onNavigate ? { onNavigate } : {}),
    ...bankProps,
  };
  const defaultBankNode = <QuestionBankTab {...mergedBankProps} />;

  const renderPanelContent = (tab: MaterialsTabId): ReactNode => {
    if (tab === 'graph') {
      return renderGraph ? (
        renderGraph()
      ) : (
        <div className="mv2-slot-section">
          <SectionIntro title="知识图谱" description="从概念网络出发，一眼看清掌握态分布与待补前置。" />
          <DefaultGraphPlaceholder />
        </div>
      );
    }
    if (tab === 'bank') {
      return renderBank ? renderBank(defaultBankNode) : defaultBankNode;
    }
    if (tab === 'textbooks') {
      return renderTextbooks ? renderTextbooks() : null;
    }
    if (tab === 'papers') {
      return renderPapers ? renderPapers() : null;
    }
    return renderOriginals ? renderOriginals() : null;
  };

  return (
    <div className="mv2-root" {...(theme ? { 'data-theme': theme } : {})}>
      <header className="mv2-hero">
        <div className="mv2-hero-copy">
          <h1>{title}</h1>
          {subtitle && <p className="mv2-hero-subtitle">{subtitle}</p>}
        </div>
        <div className="mv2-hero-action">
          {headerAction ??
            (onCaptureMaterial ? (
              <button type="button" className="mv2-btn mv2-btn-tonal" onClick={onCaptureMaterial}>
                <Icon name="plus" />
                <span>交入材料</span>
              </button>
            ) : (
              <a
                className="mv2-btn mv2-btn-tonal"
                href="/intake"
                onClick={event => {
                  if (!onNavigate) return;
                  event.preventDefault();
                  onNavigate('/intake');
                }}
              >
                <Icon name="plus" />
                <span>导入文件</span>
              </a>
            ))}
        </div>
      </header>

      <div className="mv2-tabs-shell">
        <div className="mv2-tabs-track" role="tablist" aria-label="材料分区">
          {MATERIALS_TABS.map((tab, index) => {
            const selected = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={node => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={`mv2-tab-${tab.id}`}
                className="mv2-tab-capsule"
                aria-selected={selected}
                aria-controls={`mv2-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={event => handleTabKeyDown(event, index)}
              >
                <span className="mv2-tab-icon">
                  <TabIcon tab={tab.id} />
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <section
        role="tabpanel"
        id={`mv2-panel-${currentTab}`}
        aria-labelledby={`mv2-tab-${currentTab}`}
        className="mv2-tabpanel"
      >
        {renderPanelContent(currentTab)}
      </section>
    </div>
  );
}
