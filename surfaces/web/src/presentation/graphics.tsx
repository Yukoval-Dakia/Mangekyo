import type { Drawing, ViewNode } from '../../../shared/presentation/index.ts';

type Range = Extract<ViewNode, { kind: 'range' }>;
export type Reading = { range: Range; index: number };
type Scene = Extract<ViewNode, { kind: 'scene' }>;
type Curve = Extract<ViewNode, { kind: 'curve' }>;
const paints = {
  ink: 'var(--ink)',
  muted: 'var(--muted)',
  liquid: 'var(--av-liquid)',
  paper: 'var(--surface)',
  none: 'none',
};
const points = (items: { x: number; y: number }[]) => items.map((p) => p.x + ',' + p.y).join(' ');
export function SceneFigure({
  node,
  read,
  advance,
}: {
  node: Scene;
  read: (id: string) => Reading;
  advance: (id: string, objectId: string) => void;
}) {
  const position = (p: number | { source: string; values: number[] }) =>
    typeof p === 'number' ? p : p.values[read(p.source).index];
  function object(o: Drawing) {
    switch (o.kind) {
      case 'line':
        return <polyline points={points(o.points)} fill="none" stroke={paints[o.stroke]} />;
      case 'polygon':
        return (
          <polygon points={points(o.points)} fill={paints[o.fill]} stroke={paints[o.stroke]} />
        );
      case 'rect':
        return (
          <rect
            x={position(o.x)}
            y={position(o.y)}
            width={o.width}
            height={position(o.height)}
            fill={paints[o.fill]}
            stroke={paints[o.stroke]}
          />
        );
      case 'label':
        return (
          <text x={o.x} y={o.y}>
            {o.text}
          </text>
        );
      case 'reading': {
        const { range, index } = read(o.source);
        return (
          <text className="av-svg-value" x={o.x} y={o.y}>
            {range.values[index]} {range.unit}
          </text>
        );
      }
      case 'stepTarget':
        return (
          <g className="av-hotspot" onClick={() => advance(o.source, o.id)}>
            <title>{o.label}</title>
            <circle cx={o.x} cy={o.y} r="11" />
            <path d={`M ${o.x - 5} ${o.y} h 10 M ${o.x} ${o.y - 5} v 10`} stroke="white" />
          </g>
        );
    }
  }
  return (
    <figure className="av-figure">
      <figcaption>{node.label}</figcaption>
      <svg viewBox={`0 0 ${node.width} ${node.height}`} role="img" aria-label={node.description}>
        {node.objects.map((o) => (
          <g key={o.id} data-object={o.id}>
            {object(o)}
          </g>
        ))}
      </svg>
      <p>{node.description}</p>
      {node.objects
        .filter((o) => o.kind === 'stepTarget')
        .map((o) => (
          <button
            key={o.id}
            type="button"
            className="tonal-button"
            disabled={read(o.source).index + 1 >= read(o.source).range.values.length}
            onClick={() => advance(o.source, o.id)}
          >
            {o.label}
          </button>
        ))}
    </figure>
  );
}
export function CurveFigure({ node, reading }: { node: Curve; reading: Reading }) {
  const { range, index } = reading;
  const min = Math.min(...node.values),
    max = Math.max(...node.values);
  const xs = range.values,
    first = xs[0]!,
    last = xs.at(-1)!;
  const data = node.values.map((v, i) => ({
    x: 36 + (202 * (xs[i]! - first)) / (last - first),
    y: 132 - (104 * (v - min)) / (max - min || 1),
  }));
  const active = data[index]!;
  const caption = `${xs[index]} ${range.unit} · ${node.unit} ${node.values[index]}`;
  return (
    <figure className="av-figure">
      <figcaption>{node.label}</figcaption>
      <svg viewBox="0 0 264 184" role="img" aria-label={node.label + '，' + caption}>
        {[
          { y: 28, label: max },
          { y: 132, label: min },
        ].map((t) => (
          <g key={t.y}>
            <line x1="36" x2="238" y1={t.y} y2={t.y} stroke="var(--line)" />
            <text x="30" y={t.y + 4} textAnchor="end">
              {Number(t.label.toFixed(1))}
            </text>
          </g>
        ))}
        <text x="36" y="16">
          {node.unit}
        </text>
        <polyline points={points(data)} fill="none" stroke="var(--primary)" strokeWidth="2" />
        <circle cx={active.x} cy={active.y} r="5" fill="var(--primary)" stroke="white" />
        <text x="36" y="152">
          {first}
        </text>
        <text x="238" y="152" textAnchor="end">
          {last} {range.unit}
        </text>
      </svg>
      <output>{caption}</output>
    </figure>
  );
}
