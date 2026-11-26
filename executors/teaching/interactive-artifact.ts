/*
 * Self-contained mirror of surfaces/shared/presentation artifact validation.
 * executors/teaching must never import surfaces/modules, so the exact v1
 * shape, budget and binding rules are re-implemented here.
 */

type Rule = {
  readonly type?: 'object' | 'array' | 'string' | 'number' | undefined;
  readonly const?: string | number | undefined;
  readonly enum?: readonly string[] | undefined;
  readonly pattern?: string | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly items?: Rule | undefined;
  readonly minItems?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly properties?: Record<string, Rule> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly oneOf?: readonly Rule[] | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const word = (maxLength: number): Rule => ({ type: 'string', minLength: 1, maxLength });
const identifier: Rule = { ...word(64), pattern: '^[a-z][a-z0-9_-]*$' };
const num = (minimum: number, maximum: number): Rule => ({ type: 'number', minimum, maximum });
const literal = (value: number | string): Rule => ({ const: value });
const choice = (...values: readonly string[]): Rule => ({ enum: values });
const list = (items: Rule, maxItems: number, minItems = 1): Rule => ({ type: 'array', items, minItems, maxItems });
const objectOf = (properties: Record<string, Rule>): Rule => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
});
const union = (...oneOf: readonly Rule[]): Rule => ({ oneOf });

const label = word(160);
const prose = word(2048);
const coord = num(-1024, 1024);
const sampled = objectOf({ source: identifier, values: list(coord, 128) });
const position = union(coord, sampled);
const point = objectOf({ x: coord, y: coord });
const paint = choice('ink', 'muted', 'liquid', 'paper', 'none');
const shape = union(
  objectOf({ kind: literal('polygon'), id: identifier, points: list(point, 96, 3), fill: paint, stroke: paint }),
  objectOf({ kind: literal('line'), id: identifier, points: list(point, 96, 2), stroke: paint }),
  objectOf({
    kind: literal('rect'),
    id: identifier,
    x: position,
    y: position,
    width: num(1, 1024),
    height: position,
    fill: paint,
    stroke: paint,
  }),
  objectOf({ kind: literal('label'), id: identifier, x: coord, y: coord, text: label }),
  objectOf({ kind: literal('reading'), id: identifier, x: coord, y: coord, source: identifier }),
  objectOf({ kind: literal('stepTarget'), id: identifier, x: coord, y: coord, label, source: identifier }),
);
const node = union(
  objectOf({ kind: literal('text'), id: identifier, text: prose }),
  objectOf({ kind: literal('steps'), id: identifier, items: list(label, 8) }),
  objectOf({
    kind: literal('scene'),
    id: identifier,
    label,
    description: prose,
    width: num(64, 1024),
    height: num(64, 1024),
    objects: list(shape, 96),
  }),
  objectOf({
    kind: literal('range'),
    id: identifier,
    label,
    unit: label,
    values: list(num(-1e6, 1e6), 128, 2),
    initial: num(0, 127),
  }),
  objectOf({
    kind: literal('curve'),
    id: identifier,
    label,
    source: identifier,
    unit: label,
    values: list(num(-1e6, 1e6), 128, 2),
  }),
  objectOf({
    kind: literal('selection'),
    id: identifier,
    label,
    layout: choice('passage', 'beats'),
    items: list(objectOf({ id: identifier, label }), 128),
    tail: { ...word(32), minLength: 0 },
    selected: list(identifier, 128, 0),
  }),
  objectOf({ kind: literal('stepControl'), id: identifier, label, target: identifier }),
  objectOf({ kind: literal('note'), id: identifier, label }),
  objectOf({ kind: literal('listen'), id: identifier, label, lanes: list(identifier, 4), bpm: num(40, 200) }),
  objectOf({ kind: literal('asset'), id: identifier, label, assetId: identifier, media: choice('image', 'audio') }),
  objectOf({
    kind: literal('action'),
    id: identifier,
    label,
    inputs: list(identifier, 128, 0),
    intent: choice('explore', 'saveDraft', 'submit', 'requestHelp', 'requestReveal'),
  }),
);
const section = objectOf({
  id: identifier,
  title: label,
  layout: choice('stack', 'columns'),
  nodes: list(node, 32),
});
const hostInteraction = objectOf({
  version: literal(1),
  logic: objectOf({ id: identifier, revision: identifier }),
  inputs: list(objectOf({ id: identifier, values: list(identifier, 16) }), 16),
  operations: list(objectOf({ target: identifier, input: identifier, equals: identifier, unavailable: label }), 64),
});
const base = objectOf({
  version: literal(1),
  id: identifier,
  revision: identifier,
  title: label,
  fallback: prose,
  sections: list(section, 12),
});
const artifactRule: Rule = {
  ...base,
  properties: { ...base.properties, interaction: hostInteraction, drawingId: identifier },
  required: base.required,
};

function checkShape(rule: Rule, value: unknown, path: string): string | undefined {
  const invalid = (reason: string) => path + ' ' + reason;
  if (rule.oneOf) {
    const kind = isRecord(value) ? value.kind : undefined;
    const branch = rule.oneOf.find(
      (candidate) => candidate.properties?.kind?.const === kind && kind !== undefined,
    );
    if (branch) return checkShape(branch, value, path);
    if (!rule.oneOf.some((candidate) => !checkShape(candidate, value, path)))
      return invalid('does not match a supported variant');
  } else if (rule.const !== undefined) {
    if (value !== rule.const) return invalid('expected ' + rule.const);
  } else if (rule.enum) {
    if (typeof value !== 'string' || !rule.enum.includes(value))
      return invalid('expected ' + rule.enum.join('|'));
  } else if (rule.type === 'object' && rule.properties) {
    if (!isRecord(value)) return invalid('expected object');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rule.properties, key)) return invalid('unexpected property ' + key);
    }
    for (const [key, field] of Object.entries(rule.properties)) {
      if (!Object.hasOwn(value, key)) {
        if (rule.required?.includes(key)) return invalid('missing ' + key);
        continue;
      }
      const error = checkShape(field, value[key], path + '.' + key);
      if (error) return error;
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value) || value.length < rule.minItems! || value.length > rule.maxItems!)
      return invalid('invalid list length');
    for (let index = 0; index < value.length; index++) {
      const error = checkShape(rule.items!, value[index], path + '[' + index + ']');
      if (error) return error;
    }
  } else if (rule.type === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < rule.minimum! ||
      value > rule.maximum!
    )
      return invalid('number outside permitted range');
  } else if (rule.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < rule.minLength! ||
      value.length > rule.maxLength! ||
      (rule.pattern && !new RegExp(rule.pattern).test(value))
    )
      return invalid('invalid text');
  }
  return undefined;
}

export const interactiveArtifactLimits = {
  nodes: 128,
  objects: 512,
  points: 4096,
  values: 24576,
  textUnits: 131072,
  assets: 4,
  bytesPerAsset: 16 * 1024 * 1024,
} as const;

function checkBudget(input: unknown): string | undefined {
  const used = { nodes: 0, objects: 0, points: 0, values: 0, textUnits: 0, assets: 0 };
  function charge(key: keyof typeof used, amount: number) {
    used[key] += amount;
    if (used[key] > interactiveArtifactLimits[key]) return 'view exceeds ' + key + ' budget';
    return undefined;
  }
  function visit(value: unknown, key: string, depth: number): string | undefined {
    if (depth > 24) return 'view exceeds nesting budget';
    const limit = charge('values', 1);
    if (limit) return limit;
    if (typeof value === 'string') return charge('textUnits', value.length);
    if (Array.isArray(value)) {
      if (key === 'objects' || key === 'points' || key === 'nodes') {
        const error = charge(key, value.length);
        if (error) return error;
      }
      for (const child of value) {
        const error = visit(child, '', depth + 1);
        if (error) return error;
      }
    } else if (isRecord(value)) {
      if (value.kind === 'asset') {
        const error = charge('assets', 1);
        if (error) return error;
      }
      if (value.kind === 'curve' && Array.isArray(value.values)) {
        const error = charge('points', value.values.length);
        if (error) return error;
      }
      for (const field in value) {
        if (!Object.hasOwn(value, field)) continue;
        const error = charge('textUnits', field.length) || visit(value[field], field, depth + 1);
        if (error) return error;
      }
    }
    return undefined;
  }
  return visit(input, '', 0);
}

type ViewPaint = 'ink' | 'muted' | 'liquid' | 'paper' | 'none';
type SampledPositionV1 = { readonly source: string; readonly values: readonly number[] };
export type InteractiveDrawingV1 =
  | { readonly kind: 'polygon'; readonly id: string; readonly points: readonly { readonly x: number; readonly y: number }[]; readonly fill: ViewPaint; readonly stroke: ViewPaint }
  | { readonly kind: 'line'; readonly id: string; readonly points: readonly { readonly x: number; readonly y: number }[]; readonly stroke: ViewPaint }
  | { readonly kind: 'rect'; readonly id: string; readonly x: number | SampledPositionV1; readonly y: number | SampledPositionV1; readonly width: number; readonly height: number | SampledPositionV1; readonly fill: ViewPaint; readonly stroke: ViewPaint }
  | { readonly kind: 'label'; readonly id: string; readonly x: number; readonly y: number; readonly text: string }
  | { readonly kind: 'reading'; readonly id: string; readonly x: number; readonly y: number; readonly source: string }
  | { readonly kind: 'stepTarget'; readonly id: string; readonly x: number; readonly y: number; readonly label: string; readonly source: string };
export type InteractiveNodeV1 =
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'steps'; readonly id: string; readonly items: readonly string[] }
  | { readonly kind: 'scene'; readonly id: string; readonly label: string; readonly description: string; readonly width: number; readonly height: number; readonly objects: readonly InteractiveDrawingV1[] }
  | { readonly kind: 'range'; readonly id: string; readonly label: string; readonly unit: string; readonly values: readonly number[]; readonly initial: number }
  | { readonly kind: 'curve'; readonly id: string; readonly label: string; readonly source: string; readonly unit: string; readonly values: readonly number[] }
  | { readonly kind: 'selection'; readonly id: string; readonly label: string; readonly layout: 'passage' | 'beats'; readonly items: readonly { readonly id: string; readonly label: string }[]; readonly tail: string; readonly selected: readonly string[] }
  | { readonly kind: 'stepControl'; readonly id: string; readonly label: string; readonly target: string }
  | { readonly kind: 'note'; readonly id: string; readonly label: string }
  | { readonly kind: 'listen'; readonly id: string; readonly label: string; readonly lanes: readonly string[]; readonly bpm: number }
  | { readonly kind: 'asset'; readonly id: string; readonly label: string; readonly assetId: string; readonly media: 'image' | 'audio' }
  | { readonly kind: 'action'; readonly id: string; readonly label: string; readonly inputs: readonly string[]; readonly intent: 'explore' | 'saveDraft' | 'submit' | 'requestHelp' | 'requestReveal' };
export type InteractiveSectionV1 = {
  readonly id: string;
  readonly title: string;
  readonly layout: 'stack' | 'columns';
  readonly nodes: readonly InteractiveNodeV1[];
};
export type InteractiveHostLogicV1 = {
  readonly version: 1;
  readonly logic: { readonly id: string; readonly revision: string };
  readonly inputs: readonly { readonly id: string; readonly values: readonly string[] }[];
  readonly operations: readonly { readonly target: string; readonly input: string; readonly equals: string; readonly unavailable: string }[];
};
export type InteractiveArtifactV1 = {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly fallback: string;
  readonly sections: readonly InteractiveSectionV1[];
  readonly interaction?: InteractiveHostLogicV1;
  readonly drawingId?: string;
};

function drawingStroke(view: InteractiveArtifactV1) {
  const scene = view.sections[0]?.nodes[0];
  const line = scene?.kind === 'scene' ? scene.objects[0] : undefined;
  if (!view.drawingId || view.interaction || view.sections.length !== 1 ||
      view.sections[0]!.nodes.length !== 1 || scene?.kind !== 'scene' ||
      scene.objects.length !== 1 || line?.kind !== 'line' || line.stroke === 'none') return;
  return { scene, line };
}

function samples(shapeEntry: InteractiveDrawingV1): readonly SampledPositionV1[] {
  if (shapeEntry.kind !== 'rect') return [];
  return [shapeEntry.x, shapeEntry.y, shapeEntry.height].filter((value) => typeof value !== 'number') as SampledPositionV1[];
}

function checkBindings(view: InteractiveArtifactV1): string | undefined {
  const nodes = view.sections.flatMap((entry) => entry.nodes);
  if (view.drawingId && !drawingStroke(view)) return 'drawingId requires one scene containing one visible line';
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const stepTargets = new Set(
    nodes.flatMap((entry) =>
      entry.kind === 'scene' ? entry.objects.filter((object) => object.kind === 'stepTarget').map((object) => object.id) : [],
    ),
  );
  const seen = new Set<string>();
  const ids = [
    ...view.sections,
    ...nodes,
    ...nodes.flatMap((entry) =>
      entry.kind === 'scene'
        ? entry.objects.map((object) => object.id)
        : entry.kind === 'selection'
          ? entry.items.map((item) => item.id)
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
    for (const operation of operations) {
      const kind = byId.get(operation.target)?.kind;
      if (
        (kind !== 'range' && kind !== 'action') ||
        targets.has(operation.target) ||
        !domains.get(operation.input)?.has(operation.equals)
      )
        return 'invalid gated operation ' + operation.target;
      targets.add(operation.target);
    }
  }
  function range(source: string, length?: number) {
    const entry = byId.get(source);
    return entry?.kind === 'range' && (length === undefined || entry.values.length === length);
  }
  for (const entry of nodes) {
    let valid = true;
    if (entry.kind === 'stepControl') valid = stepTargets.has(entry.target);
    if (entry.kind === 'range')
      valid =
        Number.isInteger(entry.initial) &&
        entry.initial < entry.values.length &&
        entry.values.every((value, index) => !index || value > entry.values[index - 1]!);
    if (entry.kind === 'action')
      valid =
        new Set(entry.inputs).size === entry.inputs.length &&
        entry.inputs.every((id) => {
          const target = byId.get(id);
          return (
            target?.kind === 'range' || target?.kind === 'selection' || target?.kind === 'note'
          );
        });
    if (entry.kind === 'curve') valid = range(entry.source, entry.values.length);
    if (entry.kind === 'selection')
      valid =
        new Set(entry.selected).size === entry.selected.length &&
        entry.selected.every((id) => entry.items.some((item) => item.id === id));
    if (entry.kind === 'scene')
      valid = entry.objects.every(
        (object) =>
          (!('source' in object) || range(object.source)) &&
          samples(object).every((sample) => range(sample.source, sample.values.length)) &&
          (object.kind !== 'rect' ||
            (typeof object.height === 'number' ? object.height >= 0 : object.height.values.every((value) => value >= 0))),
      );
    if (entry.kind === 'listen') {
      const lanes = entry.lanes.map((id) => byId.get(id));
      const first = lanes[0];
      valid =
        new Set(entry.lanes).size === lanes.length &&
        first?.kind === 'selection' &&
        lanes.every(
          (lane) =>
            lane?.kind === 'selection' &&
            lane.layout === 'beats' &&
            lane.items.length === first.items.length,
        );
    }
    if (!valid) return 'invalid initial value, geometry or binding at ' + entry.id;
  }
  return undefined;
}

function hasAnsweringInteraction(view: InteractiveArtifactV1): boolean {
  const nodes = view.sections.flatMap((entry) => entry.nodes);
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const answerable = new Set(
    nodes.filter((entry) => entry.kind === 'selection' || entry.kind === 'range').map((entry) => entry.id),
  );
  if (!answerable.size) return false;
  return nodes.some((entry) =>
    entry.kind === 'action' && entry.intent === 'submit' &&
    entry.inputs.some((id) => answerable.has(id) && byId.has(id)),
  );
}

/** Validate one Generative UI interaction artifact against the exact v1 wire contract. */
export function validateInteractiveArtifactV1(
  input: unknown,
): { ok: true; view: InteractiveArtifactV1 } | { ok: false; error: string } {
  const error = checkBudget(input) ?? checkShape(artifactRule, input, 'view');
  if (error) return { ok: false, error };
  const view = input as InteractiveArtifactV1;
  const binding = checkBindings(view);
  if (binding) return { ok: false, error: binding };
  if (!hasAnsweringInteraction(view)) {
    return { ok: false, error: 'view requires an answerable selection or range feeding a submit action' };
  }
  return { ok: true, view };
}

const jsonToken = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const jsonPointer = /^(?:\/(?:[^~/]|~0|~1)*)*$/;
const answerKinds = ['numeric', 'text', 'attachment', 'trace', 'structured'] as const;

const tokenText = (value: unknown): string | null =>
  typeof value === 'string' && jsonToken.test(value) ? value : null;
const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const textWithin = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= limit;
const uniqueStrings = (value: unknown, limit: number, textLimit: number): string[] | null => {
  if (!Array.isArray(value) || value.length > limit) return null;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '' && entry.length <= textLimit);
  return entries.length === value.length && new Set(entries).size === entries.length ? entries : null;
};

/** Collect input node IDs actually submitted by a submit action in the artifact. */
export function submittedInputIds(view: InteractiveArtifactV1): ReadonlySet<string> {
  const submitted = new Set<string>();
  for (const sectionEntry of view.sections) {
    for (const entry of sectionEntry.nodes) {
      if (entry.kind === 'action' && entry.intent === 'submit') {
        for (const id of entry.inputs) submitted.add(id);
      }
    }
  }
  return submitted;
}

/** Validate and normalize answer slots exactly as the frozen response_schema contract declares them. */
export function sanitizeResponseSchema(
  input: unknown,
  allowedSlotIds?: ReadonlySet<string>,
): Record<string, unknown>[] | null {
  if (!Array.isArray(input) || !input.length || input.length > 32) return null;
  const slots: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) return null;
    const slotId = tokenText(entry.slotId);
    const schemaVersion = tokenText(entry.schemaVersion);
    if (!slotId || !schemaVersion || seen.has(slotId) || (allowedSlotIds && !allowedSlotIds.has(slotId)) ||
        !Array.isArray(entry.fields) || !entry.fields.length) return null;
    seen.add(slotId);
    const paths = new Set<string>();
    const fields: Record<string, unknown>[] = [];
    for (const field of entry.fields) {
      if (!isRecord(field) || typeof field.path !== 'string' || !jsonPointer.test(field.path) || paths.has(field.path)) return null;
      if (typeof field.kind !== 'string' || !answerKinds.includes(field.kind as (typeof answerKinds)[number])) return null;
      paths.add(field.path);
      fields.push({ path: field.path, kind: field.kind });
    }
    slots.push({ slotId, schemaVersion, fields });
  }
  return slots;
}

function evaluatorRef(value: unknown): { id: string; version: string } | null {
  if (typeof value === 'string') {
    const at = value.lastIndexOf('@');
    const id = at > 0 ? value.slice(0, at) : '';
    const version = at > 0 ? value.slice(at + 1) : '';
    return tokenText(id) && tokenText(version) ? { id, version } : null;
  }
  if (!isRecord(value)) return null;
  const id = tokenText(value.id);
  const version = tokenText(value.version);
  return id && version ? { id, version } : null;
}

const decimalExpectedPattern = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const fractionExpectedPattern = /^([+-]?\d+)\s*\/\s*(\d+)$/;

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function normalizeEvaluatorUnit(value: unknown): { ok: true; unit: string | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, unit: undefined };
  if (value === null) return { ok: true, unit: null };
  if (typeof value !== 'string') return { ok: false };
  const unit = value.trim().replace(/\s+/gu, ' ');
  if (unit.length > 120) return { ok: false };
  return { ok: true, unit: unit || null };
}

function isValidNumericExpected(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const fraction = fractionExpectedPattern.exec(trimmed);
  if (fraction) {
    const numerator = fraction[1]!.replace(/^[+-]/, '').replace(/^0+/, '');
    const denominatorText = fraction[2]!.replace(/^0+/, '');
    return numerator.length <= 512 && denominatorText.length > 0 && denominatorText.length <= 512;
  }
  const decimal = decimalExpectedPattern.exec(trimmed);
  if (!decimal) return false;
  const [, , integer = '0', frac = '', exponent = ''] = decimal;
  const digits = (integer + frac).replace(/^0+/, '');
  const shift = Number(exponent || 0) - frac.length;
  return Number.isSafeInteger(shift) && Math.abs(shift) <= 512 && digits.length <= 512;
}

function isValidComparableAnswer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'numeric') {
    if (!exactKeys(value, ['kind', 'value', 'unit']) || !finiteNumber(value.value)) return false;
    const unit = normalizeEvaluatorUnit(value.unit);
    return unit.ok && unit.unit !== undefined;
  }
  if (value.kind === 'text') {
    return exactKeys(value, ['kind', 'value']) && typeof value.value === 'string' && value.value.trim().length > 0;
  }
  if (value.kind === 'structured') {
    if (!exactKeys(value, ['kind', 'value']) || !isRecord(value.value)) return false;
    const structured = value.value;
    if (!exactKeys(structured, ['kind', 'ids']) || (structured.kind !== 'selection' && structured.kind !== 'breaks')) return false;
    if (!Array.isArray(structured.ids)) return false;
    const seen = new Set<string>();
    for (const id of structured.ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }
  return false;
}

function parseEvaluatorParameters(evaluator: { id: string; version: string }, parameters: unknown, inputCount: number): boolean {
  if (!isRecord(parameters)) return false;
  if (evaluator.id === 'selection-constraint' && evaluator.version === '1') {
    if (!Array.isArray(parameters.domains) || !parameters.domains.length) return false;
    if (parameters.domains.length !== inputCount) return false;
    for (const domain of parameters.domains) {
      if (!Array.isArray(domain) || !domain.length) return false;
      const ids = new Set<string>();
      const values = new Set<string>();
      for (const option of domain) {
        if (!isRecord(option) || typeof option.id !== 'string' || typeof option.value !== 'string' ||
            !option.id.trim() || !option.value.trim() || ids.has(option.id) || values.has(option.value)) return false;
        ids.add(option.id);
        values.add(option.value);
      }
    }
    if (!isRecord(parameters.test)) return false;
    if (parameters.test.kind === 'count') {
      return parameters.domains.length === 1 && Number.isSafeInteger(parameters.test.equals) &&
        (parameters.test.equals as number) >= 0 && (parameters.test.equals as number) <= (parameters.domains[0] as unknown[]).length;
    }
    if (parameters.test.kind === 'intersection') {
      const items = uniqueStrings(parameters.test.equals, 128, 1024);
      if (parameters.domains.length < 2 || !items) return false;
      const domainValues = (parameters.domains as unknown[][]).map(domain =>
        new Set((domain as Record<string, unknown>[]).map(option => option.value as string)));
      return items.every(item => domainValues.every(values => values.has(item)));
    }
    return false;
  }
  if (evaluator.id === 'multi-scheme-best' && evaluator.version === '1') {
    if (!exactKeys(parameters, ['schemes'])) return false;
    if (!Array.isArray(parameters.schemes) || !parameters.schemes.length || parameters.schemes.length > 16) return false;
    const schemeIds = new Set<string>();
    for (const scheme of parameters.schemes) {
      if (!isRecord(scheme) || !exactKeys(scheme, ['schemeId', 'weight', 'match', 'answers'])) return false;
      if (scheme.schemeId !== undefined) {
        if (typeof scheme.schemeId !== 'string' || !scheme.schemeId.trim() || schemeIds.has(scheme.schemeId)) return false;
        schemeIds.add(scheme.schemeId);
      }
      if (scheme.weight !== undefined && (!finiteNumber(scheme.weight) || scheme.weight <= 0 || scheme.weight > 1)) return false;
      if (scheme.match !== undefined && scheme.match !== 'all' && scheme.match !== 'proportional') return false;
      if (!Array.isArray(scheme.answers) || scheme.answers.length !== inputCount || !scheme.answers.every(isValidComparableAnswer)) {
        return false;
      }
    }
    return true;
  }
  if (evaluator.id === 'range-constraint' && evaluator.version === '1') {
    if (inputCount !== 1 || !exactKeys(parameters, ['min', 'max', 'inclusiveMin', 'inclusiveMax', 'target', 'tolerance', 'unit', 'partialMargin'])) return false;
    const hasIntervalKey = parameters.min !== undefined || parameters.max !== undefined;
    const hasTargetKey = parameters.target !== undefined || parameters.tolerance !== undefined;
    if (hasIntervalKey === hasTargetKey) return false;
    if (hasIntervalKey) {
      if (!finiteNumber(parameters.min) || !finiteNumber(parameters.max) || parameters.min > parameters.max) return false;
    } else {
      if (!finiteNumber(parameters.target) || !finiteNumber(parameters.tolerance) || parameters.tolerance < 0) return false;
      if (parameters.inclusiveMin !== undefined || parameters.inclusiveMax !== undefined) return false;
    }
    if (parameters.inclusiveMin !== undefined && typeof parameters.inclusiveMin !== 'boolean') return false;
    if (parameters.inclusiveMax !== undefined && typeof parameters.inclusiveMax !== 'boolean') return false;
    if (!normalizeEvaluatorUnit(parameters.unit).ok) return false;
    if (parameters.partialMargin !== undefined && (!finiteNumber(parameters.partialMargin) || parameters.partialMargin < 0)) return false;
    return true;
  }
  if (evaluator.id === 'numeric-equivalence' && evaluator.version === '1') {
    if (inputCount !== 1 || !exactKeys(parameters, ['expected', 'tolerance', 'unit', 'acceptedUnits'])) return false;
    if (!isValidNumericExpected(parameters.expected) || !finiteNumber(parameters.tolerance) || parameters.tolerance < 0) return false;
    const unitCheck = normalizeEvaluatorUnit(parameters.unit);
    if (!unitCheck.ok) return false;
    if (parameters.acceptedUnits !== undefined) {
      if (!Array.isArray(parameters.acceptedUnits)) return false;
      const accepted: string[] = [];
      const seen = new Set<string>();
      for (const entry of parameters.acceptedUnits) {
        const checked = normalizeEvaluatorUnit(entry);
        if (!checked.ok || !checked.unit || seen.has(checked.unit)) return false;
        seen.add(checked.unit);
        accepted.push(checked.unit);
      }
      if (unitCheck.unit !== undefined && unitCheck.unit !== null && accepted.length > 0 && !accepted.includes(unitCheck.unit)) return false;
    }
    return true;
  }
  return false;
}

const supportedEvaluators = new Set(['selection-constraint@1', 'multi-scheme-best@1', 'range-constraint@1', 'numeric-equivalence@1']);
const extendedEvaluators = new Set(['multi-scheme-best@1', 'range-constraint@1', 'numeric-equivalence@1']);

/** Validate frozen assessment criteria against the interactive evaluator protocols and declared slots. */
export function sanitizeAssessmentContract(input: unknown, slots: readonly Record<string, unknown>[]): Record<string, unknown>[] | null {
  if (!Array.isArray(input) || !input.length || input.length > 32) return null;
  const criteria: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!isRecord(entry)) return null;
    const criterionId = Object.hasOwn(entry, 'criterionId') ? tokenText(entry.criterionId) : tokenText(entry.id);
    if (!criterionId || seen.has(criterionId)) return null;
    seen.add(criterionId);
    if (!Array.isArray(entry.inputs) || !entry.inputs.length) return null;
    const addresses = new Set<string>();
    const boundKinds: string[] = [];
    for (const address of entry.inputs) {
      if (!isRecord(address)) return null;
      const slotId = tokenText(address.slotId);
      const path = typeof address.path === 'string' && jsonPointer.test(address.path) ? address.path : null;
      if (!slotId || path === null) return null;
      const key = JSON.stringify([slotId, path]);
      if (addresses.has(key)) return null;
      addresses.add(key);
      const slot = slots.find((candidate) => candidate.slotId === slotId);
      const fields = slot?.fields;
      const field = Array.isArray(fields)
        ? fields.find((candidate) => isRecord(candidate) && candidate.path === path)
        : undefined;
      if (!field || !isRecord(field) || typeof field.kind !== 'string') return null;
      boundKinds.push(field.kind);
    }
    const evaluator = evaluatorRef(entry.evaluator);
    const evaluatorKey = evaluator ? `${evaluator.id}@${evaluator.version}` : '';
    if (!evaluator || !supportedEvaluators.has(evaluatorKey)) return null;
    if (Object.hasOwn(entry, 'source')) return null;
    if (!finiteNumber(entry.maximum) || entry.maximum <= 0) return null;
    if (entry.missingEvidence !== 'insufficient-evidence' && entry.missingEvidence !== 'allow-qualitative') return null;
    if (evaluatorKey === 'selection-constraint@1' && !boundKinds.every(kind => kind === 'structured')) return null;
    if (extendedEvaluators.has(evaluatorKey) && !boundKinds.every(kind => kind === 'numeric' || kind === 'text' || kind === 'structured')) return null;
    if (!parseEvaluatorParameters(evaluator, entry.parameters, entry.inputs.length)) return null;
    criteria.push({
      criterionId,
      inputs: entry.inputs,
      evaluator,
      parameters: entry.parameters,
      maximum: entry.maximum,
      missingEvidence: entry.missingEvidence,
    });
  }
  return criteria;
}
