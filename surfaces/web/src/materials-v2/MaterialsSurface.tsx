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

function EntryTile({
  title,
  detail,
  href,
  badge,
  onNavigate,
}: {
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly badge: string;
  readonly onNavigate?: (href: string) => void;
}) {
  return (
    <a
      className="mv2-entry-tile"
      href={href}
      onClick={event => {
        if (!onNavigate) return;
        event.preventDefault();
        onNavigate(href);
      }}
    >
      <span className="mv2-entry-badge">{badge}</span>
      <strong className="mv2-entry-title">{title}</strong>
      <span className="mv2-entry-detail">{detail}</span>
      <span className="mv2-entry-arrow" aria-hidden="true">
        <Icon name="chevron" />
      </span>
    </a>
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

function DefaultTextbooksPlaceholder({ onNavigate }: { readonly onNavigate?: (href: string) => void }) {
  return (
    <div className="mv2-entry-grid">
      <EntryTile
        badge="活教材"
        title="打开个人教材"
        detail="阅读已沉淀的概念章节、原位微探针与考前压缩急救卡。"
        href="/textbooks"
        {...(onNavigate ? { onNavigate } : {})}
      />
      <EntryTile
        badge="示例"
        title="起步材料阅读"
        detail="查看内置示例材料的结构化讲解与随堂练习。"
        href="/materials/riding"
        {...(onNavigate ? { onNavigate } : {})}
      />
    </div>
  );
}

function DefaultPapersPlaceholder({ onNavigate }: { readonly onNavigate?: (href: string) => void }) {
  return (
    <div className="mv2-entry-grid">
      <EntryTile
        badge="练习卷"
        title="我的试卷"
        detail="继续未完成练习、查看作答记录或手动编组新卷。"
        href="/papers"
        {...(onNavigate ? { onNavigate } : {})}
      />
      <EntryTile
        badge="纸面闭环"
        title="清洁打印与拍回"
        detail="导出清爽纸面试卷并拍照回传批改，形成完整复习闭环。"
        href="/papers/issued"
        {...(onNavigate ? { onNavigate } : {})}
      />
      <EntryTile
        badge="互动课堂"
        title="学习型课堂"
        detail="进入分步讲解与互动板书课堂，按节奏攻克薄弱环节。"
        href="/classroom"
        {...(onNavigate ? { onNavigate } : {})}
      />
    </div>
  );
}

function DefaultOriginalsPlaceholder({
  onCaptureMaterial,
  onNavigate,
}: {
  readonly onCaptureMaterial?: () => void;
  readonly onNavigate?: (href: string) => void;
}) {
  return (
    <div className="mv2-stack">
      <div className="mv2-entry-grid">
        <EntryTile
          badge="导入切片"
          title="原件库与拍卷切片"
          detail="导入 PDF、纸卷照片与讲义原件，自动切分并追溯出处。"
          href="/intake"
          {...(onNavigate ? { onNavigate } : {})}
        />
        <EntryTile
          badge="外部只读"
          title="同伴工作区与 Notion 来源"
          detail="查看已授权的只读外部笔记来源、引用范围与同步状态。"
          href="/materials/workspace"
          {...(onNavigate ? { onNavigate } : {})}
        />
        <EntryTile
          badge="个人整理"
          title="学习笔记"
          detail="整理自己的总结卡片、思路摘录与关联材料。"
          href="/notes"
          {...(onNavigate ? { onNavigate } : {})}
        />
      </div>
      {onCaptureMaterial && (
        <div className="mv2-inline-cta">
          <span>手边有一段文字或题目？可以直接交入保存为个人材料。</span>
          <button type="button" className="mv2-btn mv2-btn-tonal mv2-btn-sm" onClick={onCaptureMaterial}>
            <Icon name="plus" />
            <span>交入文字材料</span>
          </button>
        </div>
      )}
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
      return (
        <div className="mv2-slot-section">
          <SectionIntro
            title="个人教材"
            description="沉淀活教材章节、原位微探针与考前压缩急救卡，随时随地温故知新。"
          />
          {renderTextbooks ? renderTextbooks() : <DefaultTextbooksPlaceholder {...(onNavigate ? { onNavigate } : {})} />}
        </div>
      );
    }
    if (tab === 'papers') {
      return (
        <div className="mv2-slot-section">
          <SectionIntro
            title="试卷与课堂"
            description="集中管理练习卷、清洁打印拍回与互动学习课堂，告别零散入口。"
          />
          {renderPapers ? renderPapers() : <DefaultPapersPlaceholder {...(onNavigate ? { onNavigate } : {})} />}
        </div>
      );
    }
    return (
      <div className="mv2-slot-section">
        <SectionIntro
          title="原件与笔记"
          description="归档导入原件、拍卷切片、已授权的 Notion 只读来源以及个人笔记。"
        />
        {renderOriginals ? (
          renderOriginals()
        ) : (
          <DefaultOriginalsPlaceholder
            {...(onCaptureMaterial ? { onCaptureMaterial } : {})}
            {...(onNavigate ? { onNavigate } : {})}
          />
        )}
      </div>
    );
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
