import { factId, type Revision } from '@mangekyo/kernel';

export const learnerPreferenceType = 'learner.preference';
export const declarePreferenceCommand = 'learner.declarePreference';
export const revisePreferenceCommand = 'learner.revisePreference';
export const retractPreferenceCommand = 'learner.retractPreference';
export const storagePurpose = 'storage';

const textLimit = 4000;
const tagLimit = 40;
const scopeLimit = 240;
const scopeKeys = ['subject', 'activity', 'context'] as const;

export type PreferenceScope = {
  readonly subject?: string;
  readonly activity?: string;
  readonly context?: string;
};

export type LearnerPreference = {
  readonly text: string;
  readonly tags: readonly string[];
  readonly scope: PreferenceScope;
};

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('偏好格式无效。');
  return input as Record<string, unknown>;
}

function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes(' ');
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > scopeLimit || !storable(value)) {
    throw new Error(`偏好范围${key}无效。`);
  }
  return value.trim();
}

export function preferenceScope(input: unknown): PreferenceScope {
  if (input === undefined || input === null) return {};
  const value = record(input);
  for (const key of Object.keys(value)) {
    if (!(scopeKeys as readonly string[]).includes(key)) {
      throw new Error('偏好范围只支持学科、活动或本人自定语境。');
    }
  }
  const scope: { subject?: string; activity?: string; context?: string } = {};
  for (const key of scopeKeys) {
    const parsed = optionalText(value, key);
    if (parsed !== undefined) scope[key] = parsed;
  }
  return scope;
}

export function learnerPreference(input: unknown): LearnerPreference {
  const value = record(input);
  const text = value.text;
  if (typeof text !== 'string' || !text.trim() || text.length > textLimit || !storable(text)) {
    throw new Error('偏好内容无效。');
  }
  const rawTags = value.tags;
  if (rawTags === undefined) return { text: text.trim(), tags: [], scope: preferenceScope(value.scope) };
  if (!Array.isArray(rawTags) || rawTags.length > 20) throw new Error('偏好标签无效。');
  const tags = rawTags.map((tag) => {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > tagLimit || !storable(tag)) {
      throw new Error('偏好标签无效。');
    }
    return tag.trim();
  });
  if (new Set(tags).size !== tags.length) throw new Error('偏好标签不能重复。');
  return { text: text.trim(), tags, scope: preferenceScope(value.scope) };
}

function revision(input: Record<string, unknown>, key: string): Revision {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('版本号无效。');
  return value as Revision;
}

export function preferenceDeclareInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('偏好标识无效。');
  return { id: factId(value.id), data: learnerPreference(record(value.data ?? value)) };
}

export function preferenceReviseInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('偏好标识无效。');
  return {
    id: factId(value.id),
    expectedRev: revision(value, 'expectedRev'),
    data: learnerPreference(record(value.data ?? value)),
  };
}

export function preferenceRetractInput(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string') throw new Error('偏好标识无效。');
  return { id: factId(value.id), expectedRev: revision(value, 'expectedRev') };
}
