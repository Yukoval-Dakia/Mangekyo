import type { CanonicalEvidenceSliceV1, EvidenceEventV1 } from '@mangekyo/kernel';
import wireSchema from './schema.json' with { type: 'json' };

type Schema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly not?: Schema;
  readonly const?: boolean;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly minLength?: number;
  readonly maxItems?: number;
  readonly pattern?: string;
  readonly format?: string;
};

const definitions: Readonly<Record<string, Schema>> = wireSchema.$defs;
const derivers: Readonly<Record<string, string>> = wireSchema['x-derivers'];

export function getMethodVersion(deriver: string): string | undefined {
  return Object.hasOwn(derivers, deriver) ? derivers[deriver] : undefined;
}

function isUtcTimestamp(value: string): boolean {
  const parts = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!parts || parts[0] !== value || value.startsWith('0000')) return false;
  const normalized = `${parts[1]}.${(parts[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}

function matches(schema: Schema, value: unknown): boolean {
  if (schema.$ref) {
    const target = definitions[schema.$ref.slice('#/$defs/'.length)];
    return target !== undefined && matches(target, value);
  }
  if (schema.const !== undefined) return value === schema.const;
  if (schema.not && matches(schema.not, value)) return false;
  if (schema.anyOf) {
    if (!schema.anyOf.some(branch => matches(branch, value))) return false;
    if (!schema.type) return true;
  }
  if (schema.enum) return typeof value === 'string' && schema.enum.includes(value);
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      return (schema.required ?? []).every(key => Object.hasOwn(record, key)) &&
        Object.entries(record).every(([key, field]) => {
          const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
          return property ? matches(property, field) : schema.additionalProperties !== false;
        }) && (schema !== definitions.examScore || Number(record.earned) <= Number(record.maximum)) &&
        (schema !== definitions.itemPacing || Number(record.position) <= Number(record.item_count));
    }
    case 'array':
      return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems) && [...value].every(item => schema.items !== undefined && matches(schema.items, item));
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string' &&
        (schema.minLength === undefined || value.length >= schema.minLength) &&
        (schema.pattern === undefined || new RegExp(schema.pattern, 'u').test(value)) &&
        (schema.format !== 'date-time' || isUtcTimestamp(value));
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum) &&
        (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum);
    default:
      return false;
  }
}

export type CognitionMethod = 'cognition@3' | 'cognition@2' | 'cognition@1' | 'dimensioned-retention@1';
export type CognitionDeriver = 'learner/cognition@3' | 'learner/cognition@2' | 'learner/cognition@1' | 'learner/retention-forecast@1';
type Novelty = EvidenceEventV1['item_novelty'];
type EvidenceRef = Pick<EvidenceEventV1, 'ref' | 'rev'>;

type UnknownUncertainty = { readonly kind: 'unknown'; readonly reason: string; readonly needed: string };
type Interval = { readonly kind: 'interval'; readonly low: number; readonly high: number };
type StateDimension = {
  readonly concept_id: string;
  readonly representation: string | null;
  readonly context: string | null;
  readonly method: string | null;
  readonly item_novelty: Novelty;
  readonly evidence_refs: readonly EvidenceRef[];
} & (
  | { readonly state: 'unknown'; readonly uncertainty: UnknownUncertainty }
  | {
    readonly state: 'known';
    readonly uncertainty: Interval;
    readonly mastery_prob: number;
    readonly r_now: number;
    readonly stability_days: number;
    readonly difficulty: number;
    readonly effective_evidence: number;
    readonly interval_days: readonly number[];
    readonly last_at: string;
    readonly crossing_at?: string;
  }
);

export type CognitionResult = {
  readonly method_version: CognitionMethod;
  readonly state: 'known' | 'unknown';
  readonly state_vector: readonly StateDimension[];
  readonly uncertainty: UnknownUncertainty | Interval;
  readonly r_now?: number;
  readonly crossing_at?: string;
  readonly ranked_candidates: readonly { readonly ref: string; readonly info_gain: number; readonly est_min: number;
    readonly reason_code: string; readonly evidence_refs?: readonly EvidenceRef[] }[];
  readonly anomalies: readonly { readonly type: string; readonly refs: readonly string[];
    readonly evidence_refs?: readonly EvidenceRef[]; readonly error_stage?: EvidenceEventV1['error_stage'] }[];
  readonly artifacts?: readonly string[];
};

export type ItemPacingEvidence = {
  readonly attempt_ref: { readonly id: string; readonly rev: number };
  readonly paper_key: string; readonly item_id: string; readonly position: number; readonly item_count: number;
  readonly estimated_duration_ms?: number;
} & ({ readonly skipped: true; readonly returned?: true } | { readonly skipped?: never; readonly returned?: never })
  & ({ readonly scale_key: string; readonly score: { readonly earned: number; readonly maximum: number } }
    | { readonly scale_key?: never; readonly score?: never });
type WireEvent = (EvidenceEventV1 & { readonly exam_pacing_item?: never }) |
  (Omit<EvidenceEventV1, 'help_level' | 'concept_ids' | 'outcome' | 'exam_pacing'> & {
    readonly help_level: 'unknown'; readonly concept_ids: readonly []; readonly claim_ids: readonly []; readonly outcome: 'unknown';
    readonly exam_pacing_item: ItemPacingEvidence; readonly exam_pacing?: never; readonly score_norm?: never;
  });
export type WireSlice = Omit<CanonicalEvidenceSliceV1, 'events'> & { readonly events: readonly WireEvent[] };
export function isCanonicalEvidenceSlice(value: unknown): value is WireSlice {
  return matches(wireSchema.$defs.input, value);
}

export function isCognitionResult(value: unknown): value is CognitionResult {
  return matches(wireSchema.$defs.output, value);
}
