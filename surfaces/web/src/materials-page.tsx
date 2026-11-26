import {Suspense, lazy, useCallback, useEffect, useState} from 'react';
import type {Settings} from './api';
import {MaterialsSurface} from './materials-v2/MaterialsSurface';
import {RefreshIcon} from './materials-v2/ProvenanceWidgets';
import type {CompanionCitationPayload, NormalizedMasteryState, PracticeQuestionPayload} from './materials-v2/types';
import {KnowledgeGraphView} from './knowledge-graph/KnowledgeGraphView';
import type {KnowledgeGraphNode} from './knowledge-graph/types';
import IssuedPapers from './issued-papers';
import {Organizer} from './organizer';
import type {Material} from './workspace';
import type {CompanionCitation} from './today-v2';
import {Icon} from './icons';
import {latestKey} from './deletion-watermark';

const StudioTextbooks = lazy(() => import('./textbook/StudioTextbooks'));

export type CiteToCompanion = (citation: CompanionCitation) => void;

function masteryStatusLabel(status: KnowledgeGraphNode['mastery']['status'] | NormalizedMasteryState | 'solid' | 'fading'): string {
  switch (status) {
    case 'steady': case 'solid': return '已稳';
    case 'fading': case 'due': return '待固';
    case 'fragile': case 'weak': return '薄弱';
    default: return '尚待核对';
  }
}

function formatGraphCitation(node: KnowledgeGraphNode): CompanionCitation {
  const mastery = node.mastery;
  const lines = [
    `知识图谱节点：${node.title}`,
    `掌握状态：${masteryStatusLabel(mastery.status)}；独立作答 ${mastery.independentCount} 次；关联题 ${node.counts.questions}、教材 ${node.counts.textbooks}、笔记 ${node.counts.notes}`,
  ];
  if (mastery.retrievability !== null) lines.push(`可提取性估计：${Math.round(mastery.retrievability * 100)}%`);
  return { title: node.title, text: lines.join('\n'), topic: '知识图谱' };
}

function formatBankCitation(payload: CompanionCitationPayload): CompanionCitation {
  const kindLabel = payload.kind === 'archetype' ? '母题' : payload.kind === 'mistake' ? '错题' : '题目';
  const lines = [`${kindLabel}：${payload.title}`];
  if (payload.archetypeTitle) lines.push(`所属母题：${payload.archetypeTitle}`);
  if (payload.sourceLabel) lines.push(`出处：${payload.sourceLabel}`);
  if (payload.mastery) lines.push(`掌握状态：${masteryStatusLabel(payload.mastery)}`);
  if (payload.prompt) lines.push(`题干：${payload.prompt.slice(0, 600)}`);
  if (payload.lastAnswer) lines.push(`上次作答：${payload.lastAnswer.slice(0, 300)}`);
  if (payload.expected) lines.push(`参考结果：${payload.expected.slice(0, 300)}`);
  return { title: payload.title, text: lines.join('\n'), topic: kindLabel };
}

function OriginalsOverview({
  materials,
  onNavigate,
}: {
  readonly materials: readonly Material[];
  readonly onNavigate: (href: string) => void;
}) {
  const [view, setView] = useState<'originals' | 'notes' | 'external'>('originals');
  const [refreshSignal, setRefreshSignal] = useState(0);

  const showOriginals = view === 'originals';
  const showNotes = view === 'notes';
  const showExternal = view === 'external';

  return (
    <section className="mv2-originals" aria-label="原件与笔记">
      <div className="mv2-originals-top">
        <div className="mv2-originals-title">
          <h2>原件与笔记</h2>
          <p>先看已交入原件，再切换到笔记或外部来源。</p>
        </div>
      </div>

      <section className="mv2-originals-list" aria-label="已交入原件">
        <div className="mv2-originals-list-head">
          <h3>已交入原件</h3>
          <button type="button" className="mv2-refresh" onClick={() => {
            window.dispatchEvent(new Event(latestKey));
            setRefreshSignal(value => value + 1);
          }}>
            <RefreshIcon />
            <span>刷新</span>
          </button>
        </div>
        {materials.length ? (
          <ul>
            {materials.map(material => (
              <li key={material.id}>
                <a href={`/materials/saved/${encodeURIComponent(material.id)}`} onClick={event => {event.preventDefault(); onNavigate(`/materials/saved/${encodeURIComponent(material.id)}`);}}>
                  <strong>{material.title || '未命名原件'}</strong>
                  <span>{material.text ? material.text.slice(0, 80) : '打开查看原件内容与出处。'}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mv2-empty-card mv2-originals-empty">
            <h3>还没有交入原件</h3>
            <p className="mv2-muted">导入 PDF、纸卷照片或一段文字后，这里会直接列出可打开的原件。</p>
            <button type="button" className="mv2-btn mv2-btn-tonal mv2-btn-sm" onClick={() => onNavigate('/intake')}>
              <Icon name="plus" />
              <span>交入材料</span>
            </button>
          </div>
        )}
      </section>

      <div className="mv2-originals-segments" role="group" aria-label="原件与笔记分段">
        {[
          {id: 'originals', label: '原件库'},
          {id: 'notes', label: '笔记'},
          {id: 'external', label: '外部来源'},
        ].map(item => (
          <button
            key={item.id}
            type="button"
            aria-pressed={view === item.id}
            className="mv2-originals-segment"
            onClick={() => setView(item.id as typeof view)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mv2-originals-content">
        {showExternal && (
          <section className="mv2-originals-block" aria-label="外部只读来源">
            <h3>外部只读来源</h3>
            <p>查看已授权的 Notion 与同伴工作区来源、引用范围与同步状态。</p>
            <a className="mv2-btn mv2-btn-ghost mv2-btn-sm" href="/materials/workspace" onClick={event => {event.preventDefault(); onNavigate('/materials/workspace');}}>
              <span>打开外部来源</span>
              <Icon name="chevron" />
            </a>
          </section>
        )}
        {showNotes && (
          <section className="mv2-originals-block mv2-originals-notes" aria-label="个人笔记">
            <Organizer section="notes" materials={materials} embedded refreshSignal={refreshSignal} />
          </section>
        )}
        {showOriginals && (
          <section className="mv2-originals-block" aria-label="原件库入口">
            <h3>原件库与拍卷切片</h3>
            <p>导入 PDF、纸卷照片与讲义原件，自动切分并追溯出处。</p>
            <a className="mv2-btn mv2-btn-ghost mv2-btn-sm" href="/intake" onClick={event => {event.preventDefault(); onNavigate('/intake');}}>
              <span>去原件库</span>
              <Icon name="chevron" />
            </a>
          </section>
        )}
      </div>
    </section>
  );
}

export function MaterialsPage({
  materials,
  onNavigate,
  onCaptureMaterial,
  onCiteToCompanion,
  onPracticeQuestion,
  settings,
}: {
  materials: readonly Material[];
  onNavigate: (href: string) => void;
  onCaptureMaterial: () => void;
  onCiteToCompanion?: CiteToCompanion;
  onPracticeQuestion?: (payload: PracticeQuestionPayload) => void | Promise<void>;
  settings?: Settings | undefined;
}) {
  const citeToCompanion = useCallback(
    (citation: CompanionCitation) => onCiteToCompanion?.(citation),
    [onCiteToCompanion],
  );

  const handleGraphCite = useCallback(
    (node: KnowledgeGraphNode) => citeToCompanion(formatGraphCitation(node)),
    [citeToCompanion],
  );

  const handleBankCite = useCallback(
    async (payload: CompanionCitationPayload) => {
      citeToCompanion(formatBankCitation(payload));
    },
    [citeToCompanion],
  );

  const handleSelectQuestion = useCallback(() => {
    onNavigate('/materials?tab=bank');
  }, [onNavigate]);

  const [focusNodeId, setFocusNodeId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('focus'),
  );

  useEffect(() => {
    const syncFocus = () => setFocusNodeId(new URLSearchParams(window.location.search).get('focus'));
    window.addEventListener('popstate', syncFocus);
    return () => window.removeEventListener('popstate', syncFocus);
  }, []);

  return (
    <MaterialsSurface
      syncUrl
      historyMode="push"
      onNavigate={onNavigate}
      onCaptureMaterial={onCaptureMaterial}
      bankProps={{
        onCiteToCompanion: handleBankCite,
        ...(onPracticeQuestion ? {onPracticeQuestion} : {}),
        onNavigate,
      }}
      renderGraph={() => (
        <KnowledgeGraphView
          settings={settings}
          onNavigate={onNavigate}
          onCaptureMaterial={onCaptureMaterial}
          onSelectQuestion={handleSelectQuestion}
          onCiteToCompanion={handleGraphCite}
          focusNodeId={focusNodeId}
        />
      )}
      renderTextbooks={() => (
        <Suspense fallback={<p role="status">正在打开教材…</p>}>
          <StudioTextbooks editor={false} openAccess={() => onNavigate('/textbooks/page')} embedded />
        </Suspense>
      )}
      renderPapers={() => (
        <div className="mv2-stack">
          <IssuedPapers embedded />
          <div className="mv2-entry-grid">
            <a className="mv2-entry-tile" href="/papers" onClick={event => {event.preventDefault(); onNavigate('/papers');}}>
              <span className="mv2-entry-badge">练习卷</span>
              <strong className="mv2-entry-title">我的试卷</strong>
              <span className="mv2-entry-detail">继续未完成练习、查看作答记录或手动编组新卷。</span>
            </a>
            <a className="mv2-entry-tile" href="/classroom" onClick={event => {event.preventDefault(); onNavigate('/classroom');}}>
              <span className="mv2-entry-badge">互动课堂</span>
              <strong className="mv2-entry-title">学习型课堂</strong>
              <span className="mv2-entry-detail">进入分步讲解与互动板书课堂，按节奏攻克薄弱环节。</span>
            </a>
          </div>
        </div>
      )}
      renderOriginals={() => (
        <OriginalsOverview materials={materials} onNavigate={onNavigate} />
      )}
    />
  );
}
