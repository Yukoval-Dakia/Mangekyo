import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {api, ApiError, requestId, workspaceRecordFlow, type RecordFlowView, type Settings} from '../api.ts';
import {rememberRoom, rejected, roomPath, writeRoom, type ClassroomWrite} from '../classroom-contract.ts';
import {chatRoute} from '../model-route.ts';
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
  NODE_HEIGHT,
  NODE_WIDTH,
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

const KG_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function basisRefParts(value: unknown): { id: string; type?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { id?: unknown; type?: unknown; kind?: unknown };
  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;
  const type = typeof record.type === 'string' ? record.type : typeof record.kind === 'string' ? record.kind : undefined;
  return { id, ...(type !== undefined ? { type } : {}) };
}

const KG_BASIS_TYPE_LABELS: Record<string, string> = {
  'content.asset': '知识资产',
  'content.textbookPage': '教材页',
  'content.knowledgeEdge': '概念关系',
  'activity.textMaterial': '材料',
  'activity.workbookPaper': '试卷',
  'activity.workbookAttempt': '作答记录',
  'activity.workspaceEntry': '学习条目',
  'activity.studyRecord': '学习记录',
  'learner.belief': '学习认知',
  'learner.misconception': '错因记录',
  'companion.memoryAssertion': '同伴记忆',
  'companion.claim': '同伴断言',
  'plan.goal': '学习目标',
};

function basisTypeLabel(type: string | undefined): string {
  if (!type) return '学习记录';
  return KG_BASIS_TYPE_LABELS[type] ?? type.split('.').at(-1) ?? '学习记录';
}

function basisHref(id: string): string | null {
  return KG_ULID.test(id) ? `/materials/records/${encodeURIComponent(id)}` : null;
}

function BasisList({
  basisRefs,
  flow,
  onNavigate,
}: {
  basisRefs: readonly unknown[];
  flow: RecordFlowView | null;
  onNavigate?: ((href: string) => void) | undefined;
}) {
  const evidence: { key: string; badge: string; label: string; href: string | null }[] = [];
  const seen = new Set<string>();
  const push = (key: string, badge: string, label: string, href: string | null) => {
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({ key, badge, label, href });
  };

  if (flow) {
    for (const attempt of flow.attempts) {
      push(
        `attempt:${attempt.attemptId}:${attempt.itemId}`,
        attempt.verdict === 'correct' ? '答对' : attempt.verdict === 'incorrect' ? '答错' : '作答',
        attempt.paperTitle,
        attempt.href || null,
      );
    }
    for (const item of flow.misconceptions) {
      push(`misconception:${item.id}`, '错因', item.summary, item.evidenceHref ?? null);
    }
    for (const item of flow.discussions) {
      push(`discussion:${item.sessionId}:${item.turnId}`, '对话', item.title, item.href || null);
    }
  }

  for (const [index, raw] of basisRefs.entries()) {
    const parsed = basisRefParts(raw);
    if (!parsed) {
      push(`basis-${index}`, '依据', '一条学习依据记录', null);
      continue;
    }
    const label = basisTypeLabel(parsed.type);
    const flowMatch = flow?.provenance?.find(p => p.id === parsed.id)
      ?? flow?.derived?.find(p => p.id === parsed.id);
    push(
      `basis:${parsed.id}`,
      flowMatch?.originBadge?.trim() || label,
      flowMatch?.title ?? label,
      basisHref(parsed.id),
    );
  }

  if (evidence.length === 0) {
    return <p className="kg-detail-empty">尚无依据记录。</p>;
  }

  return (
    <ul className="kg-basis-list">
      {evidence.map(item => (
        <li key={item.key}>
          {item.href && onNavigate ? (
            <button type="button" className="kg-basis-link" onClick={() => onNavigate(item.href!)}>
              <span className="kg-basis-badge">{item.badge}</span>
              <span className="kg-basis-text">{item.label}</span>
            </button>
          ) : item.href ? (
            <a className="kg-basis-link" href={item.href}>
              <span className="kg-basis-badge">{item.badge}</span>
              <span className="kg-basis-text">{item.label}</span>
            </a>
          ) : (
            <span className="kg-basis-link kg-basis-link--static">
              <span className="kg-basis-badge">{item.badge}</span>
              <span className="kg-basis-text">{item.label}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

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

function masteryTopicHint(status: MasteryStatus): string {
  switch (status) {
    case 'fragile': return '该点尚薄弱，请先巩固再推进';
    case 'fading': return '已学内容待巩固，请安排复习';
    case 'unknown': return '掌握情况尚待核对，请先梳理要点';
    default: return '';
  }
}

function microLessonTopic(node: KnowledgeGraphNode): string {
  const parts = [`围绕知识点「${node.title}」上一节 10 分钟微课`];
  const hint = masteryTopicHint(node.mastery.status);
  if (hint) parts.push(hint);
  const details: string[] = [];
  if (node.counts.questions > 0) details.push(`${node.counts.questions} 道关联题`);
  if (node.counts.textbooks > 0) details.push(`${node.counts.textbooks} 个教材块`);
  if (details.length > 0) parts.push(`结合${details.join('、')}展开`);
  return parts.join('，').slice(0, 280);
}

function parseQuickPaper(result: unknown): {kind: 'paper'; paperId: string} | {kind: 'empty'; message?: string | undefined} {
  if (!result || typeof result !== 'object') throw new Error('抽题响应格式无法识别。');
  const record = result as Record<string, unknown>;
  if (record.kind === 'empty') {
    const raw = typeof record.reason === 'string' && record.reason.trim() !== ''
      ? record.reason
      : typeof record.message === 'string' && record.message.trim() !== ''
        ? record.message
        : undefined;
    return {kind: 'empty', message: raw};
  }
  const nested = record.paper && typeof record.paper === 'object' ? (record.paper as Record<string, unknown>).id : undefined;
  const paperId = record.paperId ?? nested ?? record.id;
  if (typeof paperId === 'string' && paperId.trim() !== '') return {kind: 'paper', paperId};
  throw new Error('抽题响应未包含试卷标识。');
}

function EdgePath({
  edge,
  nodes,
  active,
  fontScale,
  edgeIndex,
  showLabel,
}: {
  edge: LayoutEdge;
  nodes: Map<string, LayoutNode>;
  active: boolean;
  fontScale: number;
  edgeIndex: number;
  showLabel: boolean;
}) {
  const from = nodes.get(edge.fromId);
  const to = nodes.get(edge.toId);
  if (!from || !to) return null;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const distance = Math.hypot(deltaX, deltaY) || 1;
  const unitX = deltaX / distance;
  const unitY = deltaY / distance;
  const fromScale = Math.min(NODE_WIDTH / 2 / Math.abs(unitX || Infinity), NODE_HEIGHT / 2 / Math.abs(unitY || Infinity));
  const toScale = Math.min(
    (NODE_WIDTH / 2 + 10) / Math.abs(unitX || Infinity),
    (NODE_HEIGHT / 2 + 10) / Math.abs(unitY || Infinity),
  );
  const startX = from.x + unitX * (fromScale + 3);
  const startY = from.y + unitY * (fromScale + 3);
  const endX = to.x - unitX * toScale;
  const endY = to.y - unitY * toScale;
  const curvature = Math.max(22, Math.min(56, distance * 0.1));
  const normalX = -unitY * curvature;
  const normalY = unitX * curvature;
  const control1X = startX + deltaX * 0.24 + normalX;
  const control1Y = startY + deltaY * 0.24 + normalY;
  const control2X = endX - deltaX * 0.24 + normalX;
  const control2Y = endY - deltaY * 0.24 + normalY;
  const d = `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`;
  const labelT = 0.35 + (edgeIndex % 3) * 0.15;
  const inverseLabelT = 1 - labelT;
  const labelX =
    inverseLabelT ** 3 * startX +
    3 * inverseLabelT ** 2 * labelT * control1X +
    3 * inverseLabelT * labelT ** 2 * control2X +
    labelT ** 3 * endX;
  const labelY =
    inverseLabelT ** 3 * startY +
    3 * inverseLabelT ** 2 * labelT * control1Y +
    3 * inverseLabelT * labelT ** 2 * control2Y +
    labelT ** 3 * endY;
  const label = edge.pending ? `待核对 · ${edgeKindLabel(edge.kind)}` : edgeKindLabel(edge.kind);
  const labelFontSize = Math.round(15 * fontScale);
  const labelHeight = labelFontSize > 14 ? 28 : 24;
  const labelWidth = label.length * labelFontSize + 20;
  return (
    <g className={`${edge.pending ? 'kg-edge-pending' : 'kg-edge'}${active ? ' kg-edge-active' : ' kg-edge-dim'}`}>
      <path
        d={d}
        markerEnd={`url(#${edge.pending ? 'kg-arrow-pending' : 'kg-arrow'})`}
      >
        <title>{edge.pending && edge.summary ? `${edge.summary}（待核对）` : label}</title>
      </path>
      {showLabel ? (
        <g className="kg-edge-label" pointerEvents="none">
          <rect x={labelX - labelWidth / 2} y={labelY - labelHeight / 2} width={labelWidth} height={labelHeight} rx={labelHeight / 2} />
          <text x={labelX} y={labelY} textAnchor="middle" style={{fontSize: `${labelFontSize}px`}}>{label}</text>
        </g>
      ) : null}
    </g>
  );
}

function GraphCanvas({
  layout,
  selectedId,
  onSelect,
  focusNodeId,
}: {
  layout: ReturnType<typeof buildGraphLayout>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  focusNodeId?: string | null | undefined;
}) {
  const [view, setView] = useState({x: 0, y: 0, scale: 1});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(960);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{startX: number; startY: number; baseX: number; baseY: number} | null>(null);
  const nodeMap = useMemo(() => new Map(layout.nodes.map(item => [item.node.id, item])), [layout]);
  const [focusIndex, setFocusIndex] = useState(-1);

  const ordered = useMemo(() => [...layout.nodes].sort((a, b) => a.y - b.y || a.x - b.x), [layout]);
  const fontScale = Math.max(1, Math.min(1.5, layout.width / Math.max(canvasWidth, 1)));
  const titleFontSize = Math.round(14 * fontScale);
  const metaFontSize = Math.round(12 * fontScale);
  const dense = layout.edges.length > 10;
  const interactiveIds = useMemo(() => {
    const ids = new Set<string>();
    if (hoveredId) ids.add(hoveredId);
    if (selectedId) ids.add(selectedId);
    return ids;
  }, [hoveredId, selectedId]);
  const activeNodeIds = useMemo(() => {
    const active = new Set<string>();
    for (const id of interactiveIds) {
      active.add(id);
      for (const edge of layout.edges) {
        if (edge.fromId === id) active.add(edge.toId);
        if (edge.toId === id) active.add(edge.fromId);
      }
    }
    return active;
  }, [interactiveIds, layout.edges]);

  useEffect(() => {
    setView({x: 0, y: 0, scale: 1});
  }, [layout.width, layout.height]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setCanvasWidth(width);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const focusRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNodeId) return;
    const target = nodeMap.get(focusNodeId);
    if (!target) return;
    if (focusRequest.current === `${focusNodeId}:${layout.width}:${layout.height}`) return;
    focusRequest.current = `${focusNodeId}:${layout.width}:${layout.height}`;
    const scale = Math.min(1.4, Math.max(0.8, canvasWidth / Math.max(layout.width, 1)));
    setView({
      x: layout.width / 2 - target.x * scale,
      y: layout.height / 2 - target.y * scale,
      scale,
    });
  }, [focusNodeId, nodeMap, layout.width, layout.height, canvasWidth]);

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
        preserveAspectRatio="xMidYMid meet"
        role="list"
        aria-label="知识图谱"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setFocusIndex(-1);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="var(--kg-edge)" strokeWidth="1.6" strokeLinecap="round" />
          </marker>
          <marker id="kg-arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="var(--kg-edge-pending)" strokeWidth="1.6" strokeLinecap="round" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.scale})`}>
          {layout.edges.map((edge, edgeIndex) => (
            <EdgePath
              key={edge.id}
              edge={edge}
              nodes={nodeMap}
              active={interactiveIds.has(edge.fromId) || interactiveIds.has(edge.toId)}
              fontScale={fontScale}
              edgeIndex={edgeIndex}
              showLabel={!dense || interactiveIds.has(edge.fromId) || interactiveIds.has(edge.toId)}
            />
          ))}
          {layout.nodes.map(item => {
            const {node} = item;
            const selected = node.id === selectedId;
            const focused = ordered[focusIndex]?.node.id === node.id;
            const focusedTarget = focusNodeId === node.id;
            const related = activeNodeIds.size === 0 || activeNodeIds.has(node.id);
            const dimmed = !selected && !focused && !related;
            return (
              <g
                key={node.id}
                id={`kg-node-${node.id}`}
                className={`kg-node ${nodeToneClass(node.mastery.status)}${selected ? ' kg-node-selected' : ''}${focused ? ' kg-node-focused' : ''}${focusedTarget ? ' kg-node--focused' : ''}${dimmed ? ' kg-node-dim' : ''}`}
                transform={`translate(${item.x},${item.y})`}
                role="listitem"
                aria-current={selected ? 'true' : undefined}
                aria-label={`${node.title}，${masterySummary(node)}`}
                onClick={() => {
                  setFocusIndex(-1);
                  onSelect(node.id);
                }}
                onFocus={() => setFocusIndex(ordered.indexOf(item))}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(current => current === node.id ? null : current)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                tabIndex={-1}
              >
                <title>{node.title}</title>
                <rect
                  className="kg-node-focus-ring"
                  x={-NODE_WIDTH / 2 - 8}
                  y={-NODE_HEIGHT / 2 - 8}
                  width={NODE_WIDTH + 16}
                  height={NODE_HEIGHT + 16}
                  rx={28}
                  pointerEvents="none"
                />
                <rect className="kg-node-card" x={-NODE_WIDTH / 2} y={-NODE_HEIGHT / 2} width={NODE_WIDTH} height={NODE_HEIGHT} rx={22} />
                <circle className="kg-node-dot" cx={-NODE_WIDTH / 2 + 22} cy={-14} r={6} />
                <text
                  className="kg-node-title"
                  x={-NODE_WIDTH / 2 + 38}
                  y={-10}
                  textAnchor="start"
                  style={{fontSize: `${titleFontSize}px`}}
                >
                  {node.title.length > Math.max(7, Math.floor((NODE_WIDTH - 58) / titleFontSize))
                    ? `${node.title.slice(0, Math.max(7, Math.floor((NODE_WIDTH - 58) / titleFontSize)))}…`
                    : node.title}
                </text>
                <text className="kg-node-meta" x={-NODE_WIDTH / 2 + 38} y={16} textAnchor="start" style={{fontSize: `${metaFontSize}px`}}>
                  {masteryLabel(node.mastery.status)}
                </text>
                <text className="kg-node-count" x={NODE_WIDTH / 2 - 18} y={16} textAnchor="end">
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
  focusNodeId,
}: {
  nodes: readonly KnowledgeGraphNode[];
  edges: KnowledgeGraphResponse['edges'];
  pending: KnowledgeGraphResponse['pendingProposals'];
  selectedId: string | null;
  onSelect: (id: string) => void;
  focusNodeId?: string | null | undefined;
}) {
  const forest = useMemo(() => buildTreeForest(nodes, edges, pending), [nodes, edges, pending]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusNodeId) return;
    // 展开目标节点的祖先分组，确保目标行可见。
    const ancestors = new Set<string>();
    const walk = (entries: readonly TreeEntry[], trail: readonly string[]): boolean => {
      for (const entry of entries) {
        const next = [...trail, entry.node.id];
        if (entry.node.id === focusNodeId) {
          trail.forEach(id => ancestors.add(id));
          return true;
        }
        if (walk(entry.children, next)) return true;
      }
      return false;
    };
    walk(forest, []);
    if (ancestors.size > 0) {
      setCollapsed(current => {
        if (![...ancestors].some(id => current.has(id))) return current;
        const next = new Set(current);
        ancestors.forEach(id => next.delete(id));
        return next;
      });
    }
    requestAnimationFrame(() => {
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusNodeId)}"]`);
      if (!row) return;
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({block: 'center', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth'});
    });
  }, [focusNodeId, forest]);

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
    const focusedTarget = focusNodeId === node.id;
    const row = (
      <button
        key={node.id}
        type="button"
        className={`kg-tree-row${selected ? ' kg-tree-row-selected' : ''}${focusedTarget ? ' kg-node--focused' : ''}${entry.pending ? ' kg-tree-row-pending' : ''}`}
        data-node-id={node.id}
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
    <div className="kg-tree" role="list" ref={rootRef}>
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
  settings,
  onNavigate,
  onCaptureMaterial,
  onSelectQuestion,
  onCiteToCompanion,
}: {
  node: KnowledgeGraphNode;
  nodes: readonly KnowledgeGraphNode[];
  edges: KnowledgeGraphResponse['edges'];
  pending: KnowledgeGraphResponse['pendingProposals'];
  onClose: () => void;
  settings?: Settings | null | undefined;
  onNavigate?: ((href: string) => void) | undefined;
  onCaptureMaterial?: (() => void) | undefined;
  onSelectQuestion?: (questionId: string) => void;
  onCiteToCompanion?: (node: KnowledgeGraphNode) => void;
}) {
  const relations = useMemo(() => relatedEdges(node.id, nodes, edges, pending), [node.id, nodes, edges, pending]);
  const [basisOpen, setBasisOpen] = useState(false);
  const basisRefs = node.mastery.basisRefs;
  const [lesson, setLesson] = useState<{state: 'idle'} | {state: 'starting'} | {state: 'no-route'} | {state: 'error'; message: string}>({state: 'idle'});
  const [paper, setPaper] = useState<{state: 'idle'} | {state: 'drawing'} | {state: 'empty'; message?: string | undefined} | {state: 'error'; message: string}>({state: 'idle'});
  const lessonBusy = useRef(false);
  const paperBusy = useRef(false);
  const lessonOperation = useRef<ClassroomWrite | undefined>(undefined);
  const [flow, setFlow] = useState<RecordFlowView | null>(null);
  const [flowLoaded, setFlowLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    workspaceRecordFlow(node.id, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setFlow(result);
        setFlowLoaded(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFlow(null);
        setFlowLoaded(true);
      });
    return () => controller.abort();
  }, [node.id]);

  const startMicroLesson = async () => {
    if (lessonBusy.current || lesson.state === 'starting') return;
    const route = settings && chatRoute(settings, 'companion');
    if (!route) {
      setLesson({state: 'no-route'});
      return;
    }
    lessonBusy.current = true;
    const operation = lessonOperation.current ?? {
      path: '/classrooms',
      body: {requestId: requestId(), topic: microLessonTopic(node), minutes: 10, route},
    };
    lessonOperation.current = operation;
    setLesson({state: 'starting'});
    try {
      const room = await writeRoom(operation);
      lessonOperation.current = undefined;
      rememberRoom(room.id);
      if (onNavigate) onNavigate(roomPath(room.id));
      else setLesson({state: 'idle'});
    } catch (failure) {
      if (rejected(failure)) lessonOperation.current = undefined;
      setLesson({state: 'error', message: failure instanceof ApiError ? failure.message : '尚未收到开课回执，可重试。'});
    } finally {
      lessonBusy.current = false;
    }
  };

  const drawQuickPaper = async () => {
    if (paperBusy.current || paper.state === 'drawing') return;
    paperBusy.current = true;
    setPaper({state: 'drawing'});
    try {
      const result = await api<unknown>(`/knowledge/graph/${encodeURIComponent(node.id)}/quick-paper`, {
        method: 'POST',
        body: {requestId: requestId()},
      });
      const parsed = parseQuickPaper(result);
      if (parsed.kind === 'paper') {
        if (onNavigate) onNavigate(`/papers/${encodeURIComponent(parsed.paperId)}`);
        else setPaper({state: 'idle'});
      } else {
        setPaper({state: 'empty', message: parsed.message});
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        setPaper({state: 'empty'});
      } else {
        setPaper({state: 'error', message: failure instanceof Error ? failure.message : '抽题暂时失败，请稍后重试。'});
      }
    } finally {
      paperBusy.current = false;
    }
  };

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
          <BasisList basisRefs={basisRefs} flow={flow} onNavigate={onNavigate} />
        ) : null}
      </div>

      {(flow && (flow.provenance?.length || flow.derived?.length)) ? (
        <div className="kg-detail-section">
          <p className="kg-detail-label">来源溯源</p>
          {flow.provenance && flow.provenance.length > 0 ? (
            <ul className="kg-prov-list">
              {flow.provenance.map(entry => (
                <li key={entry.id} className="kg-prov-item">
                  {entry.href ? (
                    <a className="kg-prov-link" href={entry.href}>
                      <span className="kg-prov-badge">{entry.originBadge?.trim() || '来源'}</span>
                      <span className="kg-prov-title">{entry.title}</span>
                      {entry.relation ? <span className="kg-prov-meta">{entry.relation}</span> : null}
                    </a>
                  ) : (
                    <span className="kg-prov-link kg-prov-link--static">
                      <span className="kg-prov-badge">{entry.originBadge?.trim() || '来源'}</span>
                      <span className="kg-prov-title">{entry.title}</span>
                      {entry.relation ? <span className="kg-prov-meta">{entry.relation}</span> : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {flow.derived && flow.derived.length > 0 ? (
            <>
              <p className="kg-detail-label kg-detail-label--sub">下游派生</p>
              <ul className="kg-prov-list">
                {flow.derived.map(entry => (
                  <li key={entry.id} className="kg-prov-item">
                    {entry.href ? (
                      <a className="kg-prov-link" href={entry.href}>
                        <span className="kg-prov-badge">{entry.originBadge?.trim() || '派生'}</span>
                        <span className="kg-prov-title">{entry.title}</span>
                        {entry.relation ? <span className="kg-prov-meta">{entry.relation}</span> : null}
                      </a>
                    ) : (
                      <span className="kg-prov-link kg-prov-link--static">
                        <span className="kg-prov-badge">{entry.originBadge?.trim() || '派生'}</span>
                        <span className="kg-prov-title">{entry.title}</span>
                        {entry.relation ? <span className="kg-prov-meta">{entry.relation}</span> : null}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {(flow && (flow.attempts.length > 0 || flow.misconceptions.length > 0 || flow.discussions.length > 0)) ? (
        <div className="kg-detail-section">
          <p className="kg-detail-label">证据记录</p>
          {flow.attempts.length > 0 ? (
            <ul className="kg-prov-list">
              {flow.attempts.slice(0, 4).map(attempt => (
                <li key={attempt.attemptId + ':' + attempt.itemId} className="kg-prov-item">
                  <a className="kg-prov-link" href={attempt.href}>
                    <span className={`kg-prov-badge ${attempt.verdict === 'correct' ? 'kg-prov-badge--correct' : attempt.verdict === 'incorrect' ? 'kg-prov-badge--incorrect' : ''}`}>
                      {attempt.verdict === 'correct' ? '答对' : attempt.verdict === 'incorrect' ? '答错' : '作答'}
                    </span>
                    <span className="kg-prov-title">{attempt.paperTitle}</span>
                    {attempt.errorStage ? <span className="kg-prov-meta">{attempt.errorStage}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {flow.misconceptions.length > 0 ? (
            <ul className="kg-prov-list">
              {flow.misconceptions.slice(0, 3).map(item => (
                <li key={item.id} className="kg-prov-item">
                  {item.evidenceHref ? (
                    <a className="kg-prov-link" href={item.evidenceHref}>
                      <span className="kg-prov-badge kg-prov-badge--incorrect">错因</span>
                      <span className="kg-prov-title">{item.summary}</span>
                      {item.errorStage ? <span className="kg-prov-meta">{item.errorStage}</span> : null}
                    </a>
                  ) : (
                    <span className="kg-prov-link kg-prov-link--static">
                      <span className="kg-prov-badge kg-prov-badge--incorrect">错因</span>
                      <span className="kg-prov-title">{item.summary}</span>
                      {item.errorStage ? <span className="kg-prov-meta">{item.errorStage}</span> : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {flow.discussions.length > 0 ? (
            <ul className="kg-prov-list">
              {flow.discussions.slice(0, 3).map(item => (
                <li key={item.sessionId + ':' + item.turnId} className="kg-prov-item">
                  <a className="kg-prov-link" href={item.href}>
                    <span className="kg-prov-badge">对话</span>
                    <span className="kg-prov-title">{item.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="kg-detail-section">
        <button
          type="button"
          className="kg-detail-full-flow"
          onClick={() => {
            if (onNavigate) onNavigate(`/materials/records/${encodeURIComponent(node.id)}`);
          }}
          disabled={!onNavigate}
        >
          查看完整数据脉络
          <Icon name="arrow" />
        </button>
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
        <button type="button" className="primary-button" disabled={lesson.state === 'starting'} onClick={() => void startMicroLesson()}>
          {lesson.state === 'starting' ? '正在开课…' : '开 10 分钟微课'}
        </button>
        <button type="button" className="tonal-button" disabled={paper.state === 'drawing'} onClick={() => void drawQuickPaper()}>
          {paper.state === 'drawing' ? '正在抽题…' : '抽题自测'}
        </button>
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

      {lesson.state === 'no-route' ? (
        <p className="kg-detail-notice" role="status">
          尚未配置教学模型，先去设置后即可开课
          {onNavigate ? (
            <button type="button" className="kg-detail-link" onClick={() => onNavigate('/me?section=models')}>
              去设置
            </button>
          ) : null}
        </p>
      ) : null}
      {lesson.state === 'starting' ? (
        <p className="kg-detail-notice" role="status">
          正在为你开课；首次生成课堂通常需要一到两分钟，请勿重复点击。
        </p>
      ) : null}
      {lesson.state === 'error' ? (
        <p className="kg-detail-notice kg-detail-notice-error" role="alert">
          开课未完成：{lesson.message}，可直接重试。
        </p>
      ) : null}
      {paper.state === 'error' ? (
        <p className="kg-detail-notice kg-detail-notice-error" role="alert">
          {paper.message}，可直接重试。
        </p>
      ) : null}
      {paper.state === 'empty' ? (
        <div className="kg-detail-card">
          <p className="kg-detail-card-title">该知识点暂无题库题</p>
          {paper.message ? <p className="kg-detail-card-sub">{paper.message}</p> : null}
          <div className="kg-detail-card-actions">
            <button type="button" className="tonal-button" onClick={() => void startMicroLesson()}>
              开 10 分钟微课
            </button>
            {onCaptureMaterial ? (
              <button type="button" className="text-button" onClick={onCaptureMaterial}>
                + 交入练习
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const {data, loading, error, notFound} = useGraphData(props);
  const [mode, setMode] = useState<GraphViewMode>('graph');
  const [filter, setFilter] = useState<MasteryFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const focusNodeId = props.focusNodeId ?? null;

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const pending = useMemo(() => data?.pendingProposals ?? [], [data]);

  const visibleNodes = useMemo(() => nodes.filter(node => matchesFilter(node, filter)), [nodes, filter]);

  const focusedInGraph = focusNodeId ? nodes.find(node => node.id === focusNodeId) ?? null : null;
  useEffect(() => {
    if (!focusedInGraph) return;
    if (!matchesFilter(focusedInGraph, filter)) setFilter('all');
    setSelectedId(focusedInGraph.id);
  }, [focusedInGraph, filter]);

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
            <GraphCanvas layout={layout} selectedId={selectedId} onSelect={selectNode} focusNodeId={focusedInGraph?.id ?? null} />
          ) : (
            <TreeView nodes={visibleNodes} edges={edges} pending={pending} selectedId={selectedId} onSelect={selectNode} focusNodeId={focusedInGraph?.id ?? null} />
          )}
        </div>
        {selected ? (
          <DetailPanel
            key={selected.id}
            node={selected}
            nodes={nodes}
            edges={edges}
            pending={pending}
            onClose={clearSelection}
            settings={props.settings}
            onNavigate={props.onNavigate}
            onCaptureMaterial={props.onCaptureMaterial}
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
