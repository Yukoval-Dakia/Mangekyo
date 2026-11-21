import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api, ApiError} from '../api.ts';
import {Icon} from '../icons.tsx';
import {normalizeKnowledgeGraphResponse} from './normalize.ts';
import {
  basisDescription,
  buildGraphLayout,
  buildTreeForest,
  edgeKindLabel,
  matchesFilter,
  masteryHint,
  masteryLabel,
  masterySummary,
  nodeIdOfEdgeEndpoint,
  relatedEdges,
  type LayoutEdge,
  type LayoutNode,
  type TreeEntry,
} from './layout.ts';
import type {
  GraphViewMode,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
  KnowledgeGraphViewProps,
  MasteryFilter,
  MasteryStatus,
} from './types.ts';
import './knowledge-graph.css';

const FILTERS: {id: MasteryFilter; label: string}[] = [
  {id: 'all', label: '全部'},
  {id: 'steady', label: '已稳'},
  {id: 'needs-work', label: '待固与薄弱'},
  {id: 'unknown', label: '尚待核对'},
];

const STATUS_CLASS: Record<MasteryStatus, string> = {
  steady: 'kg-steady',
  fading: 'kg-fading',
  fragile: 'kg-fragile',
  unknown: 'kg-unknown',
};

function useGraphData(props: KnowledgeGraphViewProps) {
  const [remote, setRemote] = useState<KnowledgeGraphResponse | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const fetchOnMount = props.fetchOnMount === true || (props.fetchOnMount !== false && props.data === undefined);

  useEffect(() => {
    if (!fetchOnMount) return;
    let cancelled = false;
    setRemoteLoading(true);
    api<unknown>('/knowledge/graph')
      .then(result => {
        if (cancelled) return;
        setRemote(normalizeKnowledgeGraphResponse(result));
        setRemoteError(null);
        setNotFound(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setRemote(null);
          setNotFound(true);
          setRemoteError(null);
        } else {
          setRemoteError(error instanceof Error ? error.message : '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setRemoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchOnMount]);

  if (props.data !== undefined) {
    return {
      data: props.data === null ? null : normalizeKnowledgeGraphResponse(props.data),
      loading: props.loading === true,
      error: props.error ?? null,
      notFound: false,
    };
  }
  return {data: remote, loading: remoteLoading, error: remoteError, notFound};
}

function nodeToneClass(status: MasteryStatus): string {
  return STATUS_CLASS[status];
}

function EdgePath({edge, nodes}: {edge: LayoutEdge; nodes: Map<string, LayoutNode>}) {
  const from = nodes.get(edge.fromId);
  const to = nodes.get(edge.toId);
  if (!from || !to) return null;
  const midY = (from.y + to.y) / 2;
  const d = `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
  return (
    <path
      className={edge.pending ? 'kg-edge kg-edge-pending' : 'kg-edge'}
      d={d}
      markerEnd={edge.pending ? undefined : 'url(#kg-arrow)'}
    >
      {edge.pending && edge.summary ? <title>{edge.summary}</title> : <title>{edgeKindLabel(edge.kind)}</title>}
    </path>
  );
}

function GraphCanvas({
  layout,
  selectedId,
  onSelect,
}: {
  layout: ReturnType<typeof buildGraphLayout>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({x: 0, y: 0, scale: 1});
  const drag = useRef<{startX: number; startY: number; baseX: number; baseY: number} | null>(null);
  const nodeMap = useMemo(() => new Map(layout.nodes.map(item => [item.node.id, item])), [layout]);
  const [focusIndex, setFocusIndex] = useState(-1);

  const ordered = useMemo(() => [...layout.nodes].sort((a, b) => a.y - b.y || a.x - b.x), [layout]);

  const zoom = useCallback((delta: number) => {
    setView(current => ({...current, scale: Math.min(2.4, Math.max(0.4, current.scale + delta))}));
  }, []);

  const reset = useCallback(() => {
    setView({x: 0, y: 0, scale: 1});
    setFocusIndex(-1);
  }, []);

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('.kg-node')) return;
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    drag.current = {startX: event.clientX, startY: event.clientY, baseX: view.x, baseY: view.y};
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    setView(current => ({
      ...current,
      x: drag.current!.baseX + (event.clientX - drag.current!.startX) / current.scale,
      y: drag.current!.baseY + (event.clientY - drag.current!.startY) / current.scale,
    }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (ordered.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = Math.min(ordered.length - 1, focusIndex + 1);
      setFocusIndex(next);
      onSelect(ordered[next]!.node.id);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const next = Math.max(0, focusIndex - 1);
      setFocusIndex(next);
      onSelect(ordered[next]!.node.id);
    } else if (event.key === 'Enter' && focusIndex >= 0 && focusIndex < ordered.length) {
      onSelect(ordered[focusIndex]!.node.id);
    }
  };

  return (
    <div className="kg-canvas-wrap">
      <div className="kg-canvas-tools">
        <button type="button" className="kg-tool" onClick={() => zoom(0.2)} aria-label="放大">+</button>
        <button type="button" className="kg-tool" onClick={() => zoom(-0.2)} aria-label="缩小">−</button>
        <button type="button" className="kg-tool" onClick={reset} aria-label="重置视图">
          <Icon name="arrow" />
        </button>
      </div>
      <svg
        ref={svgRef}
        className="kg-canvas"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="list"
        aria-label="知识图谱"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="var(--kg-edge)" strokeWidth="1.6" strokeLinecap="round" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
          {layout.edges.map(edge => (
            <EdgePath key={edge.id} edge={edge} nodes={nodeMap} />
          ))}
          {layout.nodes.map(item => {
            const {node} = item;
            const selected = node.id === selectedId;
            const focused = ordered[focusIndex]?.node.id === node.id;
            return (
              <g
                key={node.id}
                className={`kg-node ${nodeToneClass(node.mastery.status)}${selected ? ' kg-node-selected' : ''}${focused ? ' kg-node-focused' : ''}`}
                transform={`translate(${item.x},${item.y})`}
                role="listitem"
                aria-label={`${node.title}，${masterySummary(node)}`}
                onClick={() => onSelect(node.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                tabIndex={-1}
              >
                <rect className="kg-node-card" x="-88" y="-34" width="176" height="68" rx="20" />
                <circle className="kg-node-dot" cx="-66" cy="-12" r="6" />
                <text className="kg-node-title" x="-52" y="-8" textAnchor="start">
                  {node.title.length > 10 ? `${node.title.slice(0, 10)}…` : node.title}
                </text>
                <text className="kg-node-meta" x="-52" y="14" textAnchor="start">
                  {masteryLabel(node.mastery.status)}
                </text>
                <text className="kg-node-count" x="66" y="14" textAnchor="end">
                  {node.counts.questions > 0 ? `${node.counts.questions} 题` : ''}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <p className="kg-canvas-hint">拖动平移 · 方向键遍历 · 点击节点看详情</p>
    </div>
  );
}

function TreeView({
  nodes,
  edges,
  pending,
  selectedId,
  onSelect,
}: {
  nodes: readonly KnowledgeGraphNode[];
  edges: KnowledgeGraphResponse['edges'];
  pending: KnowledgeGraphResponse['pendingProposals'];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const forest = useMemo(() => buildTreeForest(nodes, edges, pending), [nodes, edges, pending]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderRow = (entry: TreeEntry, depth: number): React.ReactNode => {
    const {node} = entry;
    const selected = node.id === selectedId;
    const isCollapsed = collapsed.has(node.id);
    const hasChildren = entry.children.length > 0;
    const row = (
      <button
        key={node.id}
        type="button"
        className={`kg-tree-row${selected ? ' kg-tree-row-selected' : ''}${entry.pending ? ' kg-tree-row-pending' : ''}`}
        style={{paddingLeft: 14 + depth * 22}}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <span
            className="kg-tree-caret"
            role="button"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? '展开' : '折叠'}
            onClick={event => {
              event.stopPropagation();
              toggle(node.id);
            }}
          >
            <Icon name="chevron" />
          </span>
        ) : (
          <span className="kg-tree-caret kg-tree-caret-empty" />
        )}
        <span className={`kg-pill ${nodeToneClass(node.mastery.status)}`}>{masteryLabel(node.mastery.status)}</span>
        <span className="kg-tree-title">{node.title}</span>
        {entry.edgeKind ? (
          <span className="kg-tree-rel">{entry.pending ? '待核对 · ' : ''}{edgeKindLabel(entry.edgeKind)}</span>
        ) : null}
        <span className="kg-tree-counts">
          {node.counts.questions > 0 ? `${node.counts.questions} 题` : ''}
          {node.counts.textbooks > 0 ? ` ${node.counts.textbooks} 教材` : ''}
          {node.counts.notes > 0 ? ` ${node.counts.notes} 笔记` : ''}
          {node.counts.notionBlocks > 0 ? ` ${node.counts.notionBlocks} Notion` : ''}
        </span>
      </button>
    );
    if (!hasChildren) return row;
    return (
      <div key={node.id} className="kg-tree-group">
        <div className="kg-tree-root">{row}</div>
        {!isCollapsed ? entry.children.map(child => renderRow(child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <div className="kg-tree" role="list">
      {forest.map(entry => renderRow(entry, 0))}
    </div>
  );
}

function DetailPanel({
  node,
  nodes,
  edges,
  pending,
  onClose,
  onSelectQuestion,
  onCiteToCompanion,
}: {
  node: KnowledgeGraphNode;
  nodes: readonly KnowledgeGraphNode[];
  edges: KnowledgeGraphResponse['edges'];
  pending: KnowledgeGraphResponse['pendingProposals'];
  onClose: () => void;
  onSelectQuestion?: (questionId: string) => void;
  onCiteToCompanion?: (node: KnowledgeGraphNode) => void;
}) {
  const relations = useMemo(() => relatedEdges(node.id, nodes, edges, pending), [node.id, nodes, edges, pending]);
  const [basisOpen, setBasisOpen] = useState(false);
  const basisRefs = node.mastery.basisRefs;

  return (
    <aside className="kg-detail" aria-label="节点详情">
      <div className="kg-detail-head">
        <div>
          <p className={`kg-pill ${nodeToneClass(node.mastery.status)}`}>{masterySummary(node)}</p>
          <h3 className="kg-detail-title">{node.title}</h3>
          <p className="kg-detail-hint">{masteryHint(node.mastery.status)}</p>
        </div>
        <button type="button" className="kg-detail-close" onClick={onClose} aria-label="关闭详情">
          <Icon name="close" />
        </button>
      </div>

      <dl className="kg-detail-stats">
        {node.counts.questions > 0 ? <div><dt>关联题</dt><dd>{node.counts.questions}</dd></div> : null}
        {node.counts.textbooks > 0 ? <div><dt>教材块</dt><dd>{node.counts.textbooks}</dd></div> : null}
        {node.counts.notes > 0 ? <div><dt>笔记</dt><dd>{node.counts.notes}</dd></div> : null}
        {node.counts.notionBlocks > 0 ? <div><dt>Notion 块</dt><dd>{node.counts.notionBlocks}</dd></div> : null}
        {Object.values(node.counts).every(value => value === 0) ? <p className="kg-detail-empty">暂无关联材料。</p> : null}
      </dl>

      <div className="kg-detail-section">
        <button type="button" className="kg-detail-basis" onClick={() => setBasisOpen(open => !open)} aria-expanded={basisOpen}>
          {basisDescription(basisRefs)}
          <Icon name="chevron" />
        </button>
        {basisOpen ? (
          basisRefs.length > 0 ? (
            <ul className="kg-basis-list">
              {basisRefs.map((ref, index) => (
                <li key={index}>依据 {index + 1}</li>
              ))}
            </ul>
          ) : (
            <p className="kg-detail-empty">尚无依据记录。</p>
          )
        ) : null}
      </div>

      {relations.upstream.length > 0 ? (
        <div className="kg-detail-section">
          <p className="kg-detail-label">先修与来源</p>
          <ul className="kg-rel-list">
            {relations.upstream.map(ref => (
              <li key={`${ref.id}-up`}>
                <span className="kg-rel-kind">{edgeKindLabel(ref.kind)}</span>
                <span className="kg-rel-title">{ref.title}</span>
                {ref.pending ? <span className="kg-rel-pending">待核对</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {relations.downstream.length > 0 ? (
        <div className="kg-detail-section">
          <p className="kg-detail-label">后继与去向</p>
          <ul className="kg-rel-list">
            {relations.downstream.map(ref => (
              <li key={`${ref.id}-down`}>
                <span className="kg-rel-kind">{edgeKindLabel(ref.kind)}</span>
                <span className="kg-rel-title">{ref.title}</span>
                {ref.pending ? <span className="kg-rel-pending">待核对</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="kg-detail-actions">
        {onSelectQuestion && node.counts.questions > 0 ? (
          <button type="button" className="tonal-button" onClick={() => onSelectQuestion(node.id)}>
            查看关联题
          </button>
        ) : null}
        {onCiteToCompanion ? (
          <button type="button" className="text-button" onClick={() => onCiteToCompanion(node)}>
            引用到学习同伴
          </button>
        ) : null}
      </div>
    </aside>
  );
}

export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const {data, loading, error, notFound} = useGraphData(props);
  const [mode, setMode] = useState<GraphViewMode>('graph');
  const [filter, setFilter] = useState<MasteryFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const pending = useMemo(() => data?.pendingProposals ?? [], [data]);

  const visibleNodes = useMemo(() => nodes.filter(node => matchesFilter(node, filter)), [nodes, filter]);

  const layout = useMemo(
    () => buildGraphLayout(visibleNodes, edges, pending),
    [visibleNodes, edges, pending],
  );

  const selected = selectedId ? nodes.find(node => node.id === selectedId) ?? null : null;

  const selectNode = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);

  if (loading) {
    return (
      <section className="kg-shell" aria-busy="true">
        <div className="kg-empty">
          <p>正在整理知识图谱…</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="kg-shell">
        <div className="kg-empty">
          <p>知识图谱暂时不可用：{error}</p>
          <p className="kg-empty-sub">稍后再试，或先从教材与题目积累学习记录。</p>
        </div>
      </section>
    );
  }

  if (notFound || nodes.length === 0) {
    return (
      <section className="kg-shell">
        <div className="kg-empty">
          <p>知识图谱还在生长中。</p>
          <p className="kg-empty-sub">先从教材、题目或笔记开始学习，系统会逐步整理出概念之间的关系。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="kg-shell">
      <header className="kg-toolbar">
        <div className="kg-segment" role="tablist" aria-label="视图切换">
          {(['tree', 'graph'] as const).map(item => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={`kg-segment-btn${mode === item ? ' kg-segment-active' : ''}`}
              onClick={() => setMode(item)}
            >
              {item === 'tree' ? '树状视图' : '图谱视图'}
            </button>
          ))}
        </div>
        <div className="kg-filters" role="group" aria-label="掌握状态筛选">
          {FILTERS.map(item => (
            <button
              key={item.id}
              type="button"
              className={`kg-filter${filter === item.id ? ' kg-filter-active' : ''}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="kg-body">
        <div className="kg-main">
          {mode === 'graph' ? (
            <GraphCanvas layout={layout} selectedId={selectedId} onSelect={selectNode} />
          ) : (
            <TreeView nodes={visibleNodes} edges={edges} pending={pending} selectedId={selectedId} onSelect={selectNode} />
          )}
        </div>
        {selected ? (
          <DetailPanel
            node={selected}
            nodes={nodes}
            edges={edges}
            pending={pending}
            onClose={clearSelection}
            {...(props.onSelectQuestion ? {onSelectQuestion: props.onSelectQuestion} : {})}
            {...(props.onCiteToCompanion ? {onCiteToCompanion: props.onCiteToCompanion} : {})}
          />
        ) : null}
      </div>
    </section>
  );
}

export function KnowledgeGraphPanel(props: KnowledgeGraphViewProps) {
  return <KnowledgeGraphView {...props} />;
}
