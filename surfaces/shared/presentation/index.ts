import { artifactSchema, type Artifact, type Drawing, type ViewNode } from './catalog.ts';
import { checkBudget } from './budget.ts';
import { checkShape } from './schema.ts';
export * from './catalog.ts';
export * from './mount.ts';

export type Answer =
  | { kind: 'quantity'; value: number; unit: string }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'text'; text: string };
export type Interaction =
  | { kind: 'adjust'; nodeId: string; value: number; unit: string; objectId?: string }
  | { kind: 'toggle'; nodeId: string; objectId: string; selected: boolean };

export interface ArtifactAction {
  version: 1;
  artifactId: string;
  revision: string;
  nodeId: string;
  intent: Extract<ViewNode, { kind: 'action' }>['intent'];
  // Oldest entries are dropped first. The host can detect incomplete history.
  trace: { omitted: number; steps: Interaction[] };
  answers: Record<string, Answer>;
}

function samples(shape: Drawing) {
  if (shape.kind !== 'rect') return [];
  return [shape.x, shape.y, shape.height].filter((v) => typeof v !== 'number');
}

/** Only a fully public, read-only line can participate in a turn drawing. */
export function drawingStroke(view: Artifact) {
  const scene = view.sections[0]?.nodes[0];
  const line = scene?.kind === 'scene' ? scene.objects[0] : undefined;
  if (!view.drawingId || view.interaction || view.sections.length !== 1 ||
      view.sections[0]!.nodes.length !== 1 || scene?.kind !== 'scene' ||
      scene.objects.length !== 1 || line?.kind !== 'line' || line.stroke === 'none') return;
  return { scene, line };
}

function checkBindings(view: Artifact): string | undefined {
  const nodes = view.sections.flatMap((section) => section.nodes);
  if (view.drawingId && !drawingStroke(view)) return 'drawingId requires one scene containing one visible line';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stepTargets = new Set(
    nodes.flatMap((n) =>
      n.kind === 'scene' ? n.objects.filter((o) => o.kind === 'stepTarget').map((o) => o.id) : [],
    ),
  );
  const seen = new Set<string>();
  const ids = [
    ...view.sections,
    ...nodes,
    ...nodes.flatMap((n) =>
      n.kind === 'scene'
        ? n.objects.map((o) => o.id)
        : n.kind === 'selection'
          ? n.items.map((i) => i.id)
          : [],
    ),
  ];
  for (const entry of ids) {
    const id = typeof entry === 'string' ? entry : entry.id;
    if (seen.has(id)) return 'duplicate ID ' + id;
    seen.add(id);
  }
  if (view.interaction) {
    const { inputs, operations } = view.interaction;
    const domains = new Map(inputs.map((input) => [input.id, new Set(input.values)]));
    if (
      domains.size !== inputs.length ||
      inputs.some((input) => domains.get(input.id)!.size !== input.values.length)
    )
      return 'duplicate host input or state value';
    const targets = new Set<string>();
    for (const op of operations) {
      const kind = byId.get(op.target)?.kind;
      if (
        (kind !== 'range' && kind !== 'action') ||
        targets.has(op.target) ||
        !domains.get(op.input)?.has(op.equals)
      )
        return 'invalid gated operation ' + op.target;
      targets.add(op.target);
    }
  }
  function range(source: string, length?: number) {
    const n = byId.get(source);
    return n?.kind === 'range' && (length === undefined || n.values.length === length);
  }
  for (const n of nodes) {
    let valid = true;
    if (n.kind === 'stepControl') valid = stepTargets.has(n.target);
    if (n.kind === 'range')
      valid =
        Number.isInteger(n.initial) &&
        n.initial < n.values.length &&
        n.values.every((v, i) => !i || v > n.values[i - 1]!);
    if (n.kind === 'action')
      valid =
        new Set(n.inputs).size === n.inputs.length &&
        n.inputs.every((id) => {
          const target = byId.get(id);
          return (
            target?.kind === 'range' || target?.kind === 'selection' || target?.kind === 'note'
          );
        });
    if (n.kind === 'curve') valid = range(n.source, n.values.length);
    if (n.kind === 'selection')
      valid =
        new Set(n.selected).size === n.selected.length &&
        n.selected.every((id) => n.items.some((i) => i.id === id));
    if (n.kind === 'scene')
      valid = n.objects.every(
        (o) =>
          (!('source' in o) || range(o.source)) &&
          samples(o).every((s) => range(s.source, s.values.length)) &&
          (o.kind !== 'rect' ||
            (typeof o.height === 'number' ? o.height >= 0 : o.height.values.every((v) => v >= 0))),
      );
    if (n.kind === 'listen') {
      const lanes = n.lanes.map((id) => byId.get(id));
      const first = lanes[0];
      valid =
        new Set(n.lanes).size === lanes.length &&
        first?.kind === 'selection' &&
        lanes.every(
          (l) =>
            l?.kind === 'selection' &&
            l.layout === 'beats' &&
            l.items.length === first.items.length,
        );
    }
    if (!valid) return 'invalid initial value, geometry or binding at ' + n.id;
  }
  return undefined;
}

export function validateArtifact(
  input: unknown,
): { ok: true; view: Artifact } | { ok: false; error: string } {
  const error = checkBudget(input) ?? checkShape(artifactSchema, input, 'view');
  if (error) return { ok: false, error };
  const view = input as Artifact;
  const binding = checkBindings(view);
  return binding ? { ok: false, error: binding } : { ok: true, view };
}
