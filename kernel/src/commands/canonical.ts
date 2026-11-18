import type { Json, JsonObject } from '../declarations/types.ts';

type CanonicalObject = { readonly [key: string]: Json };

function plainPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalize(
  value: unknown,
  ancestors: readonly object[],
): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON input must not contain non-finite numbers');
    return value;
  }
  if (typeof value !== 'object') throw new Error('JSON input must not contain undefined or unsupported values');
  if (ancestors.includes(value)) throw new Error('JSON input must not contain cycles');

  const nestedAncestors = [...ancestors, value];
  if (Array.isArray(value)) {
    if (value.length > 0 && !Object.prototype.hasOwnProperty.call(value, value.length - 1)) {
      throw new Error('JSON input must not contain sparse arrays');
    }
    const items: Json[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error('JSON input must not contain sparse arrays');
      }
      items.push(canonicalize(value[index], nestedAncestors));
    }
    return items;
  }
  if (!plainPrototype(value)) {
    throw new Error('JSON input must contain only plain objects and arrays');
  }

  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]): readonly [string, Json] => [key, canonicalize(item, nestedAncestors)]);
  return Object.fromEntries(entries);
}

export function canonicalizeJson(value: Json): Json {
  return canonicalize(value, []);
}

export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value, []));
}

export function jsonEnvelope(value: JsonObject): string {
  return canonicalJsonString(value);
}
