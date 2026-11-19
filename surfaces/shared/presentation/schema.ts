// The catalog uses this closed subset of JSON Schema. Each constructor retains
// the wire type, so validation, authoring types and discovery share one source.
export interface Schema<T = unknown> {
  readonly _type?: T;
  type?: 'object' | 'array' | 'string' | 'number';
  const?: string | number;
  enum?: readonly string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  oneOf?: readonly Schema[];
}

export type Wire<S extends Schema> = S extends Schema<infer T> ? T : never;
export const word = (maxLength: number): Schema<string> => ({
  type: 'string',
  minLength: 1,
  maxLength,
});
export const id: Schema<string> = { ...word(64), pattern: '^[a-z][a-z0-9_-]*$' };
export const num = (minimum: number, maximum: number): Schema<number> => ({
  type: 'number',
  minimum,
  maximum,
});
export const literal = <const T extends number | string>(value: T): Schema<T> => ({ const: value });
export const choice = <const T extends readonly string[]>(...values: T): Schema<T[number]> => ({
  enum: values,
});
export const list = <T>(items: Schema<T>, maxItems: number, minItems = 1): Schema<T[]> => ({
  type: 'array',
  items,
  minItems,
  maxItems,
});
export const obj = <T extends Record<string, Schema>>(
  properties: T,
): Schema<{ [K in keyof T]: Wire<T[K]> }> => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const union = <T extends Schema[]>(...oneOf: T): Schema<Wire<T[number]>> => ({ oneOf });

export function checkShape(schema: Schema, value: unknown, path: string): string | undefined {
  const invalid = (reason: string) => path + ' ' + reason;
  if (schema.oneOf) {
    const kind = isRecord(value) ? value.kind : undefined;
    const branch = schema.oneOf.find(
      (s) => s.properties?.kind?.const === kind && kind !== undefined,
    );
    if (branch) return checkShape(branch, value, path);
    if (!schema.oneOf.some((s) => !checkShape(s, value, path)))
      return invalid('does not match a supported variant');
  } else if (schema.const !== undefined) {
    if (value !== schema.const) return invalid('expected ' + schema.const);
  } else if (schema.enum) {
    if (typeof value !== 'string' || !schema.enum.includes(value))
      return invalid('expected ' + schema.enum.join('|'));
  } else if (schema.type === 'object' && schema.properties) {
    if (!isRecord(value)) return invalid('expected object');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) return invalid('unexpected property ' + key);
    }
    for (const [key, field] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) return invalid('missing ' + key);
      const error = checkShape(field, value[key], path + '.' + key);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems! || value.length > schema.maxItems!)
      return invalid('invalid list length');
    for (let i = 0; i < value.length; i++) {
      const error = checkShape(schema.items!, value[i], path + '[' + i + ']');
      if (error) return error;
    }
  } else if (schema.type === 'number') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < schema.minimum! ||
      value > schema.maximum!
    )
      return invalid('number outside permitted range');
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < schema.minLength! ||
      value.length > schema.maxLength! ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))
    )
      return invalid('invalid text');
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
