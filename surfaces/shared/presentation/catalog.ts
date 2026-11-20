import { artifactLimits } from './budget.ts';
import {
  choice,
  id,
  list,
  literal,
  num,
  obj,
  union,
  word,
  type Wire,
  type Schema,
} from './schema.ts';

const label = word(160);
const prose = word(2048);
const coord = num(-1024, 1024);
const sampled = obj({ source: id, values: list(coord, 128) });
const position = union(coord, sampled);
const point = obj({ x: coord, y: coord });
const paint = choice('ink', 'muted', 'liquid', 'paper', 'none');
const shape = union(
  obj({ kind: literal('polygon'), id, points: list(point, 96, 3), fill: paint, stroke: paint }),
  obj({ kind: literal('line'), id, points: list(point, 96, 2), stroke: paint }),
  obj({
    kind: literal('rect'),
    id,
    x: position,
    y: position,
    width: num(1, 1024),
    height: position,
    fill: paint,
    stroke: paint,
  }),
  obj({ kind: literal('label'), id, x: coord, y: coord, text: label }),
  obj({ kind: literal('reading'), id, x: coord, y: coord, source: id }),
  obj({ kind: literal('stepTarget'), id, x: coord, y: coord, label, source: id }),
);
const node = union(
  obj({ kind: literal('text'), id, text: prose }),
  obj({ kind: literal('steps'), id, items: list(label, 8) }),
  obj({
    kind: literal('scene'),
    id,
    label,
    description: prose,
    width: num(64, 1024),
    height: num(64, 1024),
    objects: list(shape, 96),
  }),
  obj({
    kind: literal('range'),
    id,
    label,
    unit: label,
    values: list(num(-1e6, 1e6), 128, 2),
    initial: num(0, 127),
  }),
  obj({
    kind: literal('curve'),
    id,
    label,
    source: id,
    unit: label,
    values: list(num(-1e6, 1e6), 128, 2),
  }),
  obj({
    kind: literal('selection'),
    id,
    label,
    layout: choice('passage', 'beats'),
    items: list(obj({ id, label }), 128),
    tail: { ...word(32), minLength: 0 },
    selected: list(id, 128, 0),
  }),
  obj({ kind: literal('stepControl'), id, label, target: id }),
  obj({ kind: literal('note'), id, label }),
  obj({ kind: literal('listen'), id, label, lanes: list(id, 4), bpm: num(40, 200) }),
  obj({ kind: literal('asset'), id, label, assetId: id, media: choice('image', 'audio') }),
  obj({
    kind: literal('action'),
    id,
    label,
    inputs: list(id, 128, 0),
    intent: choice('explore', 'saveDraft', 'submit', 'requestHelp', 'requestReveal'),
  }),
);
const section = obj({
  id,
  title: label,
  layout: choice('stack', 'columns'),
  nodes: list(node, 32),
});
const interaction = obj({
  version: literal(1),
  logic: obj({ id, revision: id }),
  inputs: list(obj({ id, values: list(id, 16) }), 16),
  operations: list(obj({ target: id, input: id, equals: id, unavailable: label }), 64),
});
const base = obj({
  version: literal(1),
  id,
  revision: id,
  title: label,
  fallback: prose,
  sections: list(section, 12),
});
export type Artifact = Wire<typeof base> & { interaction?: Wire<typeof interaction>; drawingId?: string };
export const artifactSchema: Schema<Artifact> = {
  ...base,
  properties: { ...base.properties, interaction, drawingId: id },
};
export type ViewNode = Wire<typeof node>;
export type Drawing = Wire<typeof shape>;
export const presentationCatalog = {
  version: 1,
  schema: artifactSchema,
  limits: artifactLimits,
  hostInteraction:
    'Optional interaction v1 refers to immutable host logic by id and revision. Each input declares allowed state values. Each operation enables a range or action when its host input equals the declared value. Range, drawing hotspot and its labeled native button share the same permission. Missing or mismatched state disables guarded operations. Ship only phase-approved content.',
  composition:
    'Sections preserve reading order. Every section, node, drawing object and option has a unique stable ID within the revision. New definitions use a new revision.',
  bindings:
    'range.initial is an index. Range values strictly increase. source binds by range node ID. Sample arrays match its length. stepTarget advances one sample. listen.lanes names distinct equal-length beats selections; bpm denotes quarter notes, two cells per beat. To draw progressively, call mount_artifact once per stroke. Reuse view.drawingId, revision, title and canvas size within the turn. Each such view contains just one scene with one visible line. Describe this stroke in scene.description.',
  equivalents:
    'stepControl.target names a stepTarget drawing object. Its native button and the figure operate the same range and report the same object ID. A figure supplies its own equivalent when none is placed explicitly.',
  actions:
    'Edits are local. An action node emits only its inputs (range, selection or note IDs) and their edits. Trace keeps the most recent 128 settled edits in this revision; omitted counts all earlier edits across inputs. Release or blur settles a slider gesture. The host decides whether it can accept the request.',
  assets:
    'assetId names a host-resolved raster image or audio blob. Wire definitions cannot supply URLs or markup.',
} as const;
