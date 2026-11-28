import { FactNotFoundError, factId, type FactId, type FactSnapshot } from '@mangekyo/kernel';
import { fields, list, pageId, record, text } from './parse.ts';

import { AssetBasisError, assetType, checkTextbookBasis, parseAsset, type AssetReadContext } from './asset.ts';
export const knowledgeNameType = 'content.knowledgeName';
export const knowledgeEntityKinds = ['concept', 'method', 'archetype'] as const;
export type KnowledgeEntityKind = (typeof knowledgeEntityKinds)[number];
export const kliProfiles = [
  'memory_discrimination', 'procedural_fluency', 'principle_intuition', 'open_construction',
] as const;
export type KliProfile = (typeof kliProfiles)[number];

export function parseKliProfile(value: unknown): KliProfile {
  const profile = kliProfiles.find(candidate => candidate === value);
  if (!profile) throw new Error('知识点 KLI 形态无效。');
  return profile;
}

export function knowledgeEntityKind(value: unknown) {
  const kind = knowledgeEntityKinds.find(kind => kind === value);
  if (!kind) throw new Error('规范实体类别无效。');
  return kind;
}

export function knowledgeName(value: unknown) {
  const name = text(value, '实体名称').trim();
  if (!normalizeKnowledgeName(name) || name.length > 240) throw new Error('实体名称无效。');
  return name;
}

export function normalizeKnowledgeName(name: string) {
  return name.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function parseKnowledgeEntity(input: unknown) {
  const value = record(input);
  fields(value, 'kind', 'canonicalName', 'aliases', 'embedding', 'merged_into', 'mergedInto', 'kliProfile');
  if (value.merged_into !== undefined && value.mergedInto !== undefined && value.merged_into !== value.mergedInto) {
    throw new Error('规范实体的合并目标不一致。');
  }
  const redirect = value.merged_into !== undefined ? value.merged_into : value.mergedInto;
  const canonicalName = knowledgeName(value.canonicalName);
  const aliases = list(value.aliases).map(knowledgeName);
  const names = new Set([canonicalName, ...aliases].map(normalizeKnowledgeName));
  if (aliases.length > 32 || names.size !== aliases.length + 1) throw new Error('别名重复或过多。');
  const kliProfile = value.kliProfile === undefined ? undefined : parseKliProfile(value.kliProfile);
  let embedding;
  if (value.embedding !== undefined) {
    const data = record(value.embedding);
    fields(data, 'model', 'vector');
    const vector = list(data.vector).map(component => {
      if (typeof component !== 'number' || !Number.isFinite(component)) throw new Error('语义向量无效。');
      return component;
    });
    if (!vector.length || vector.length > 4096 || vector.every(component => component === 0)) {
      throw new Error('语义向量维度或数值无效。');
    }
    embedding = { model: text(data.model, '语义模型版本'), vector };
  }
  return {
    kind: knowledgeEntityKind(value.kind), canonicalName, aliases,
    ...(embedding ? { embedding } : {}),
    ...(kliProfile ? { kliProfile } : {}),
    merged_into: redirect == null ? null : pageId(redirect),
  };
}

export function parseKnowledgeName(input: unknown) {
  const value = record(input);
  fields(value, 'kind', 'normalized', 'entityId');
  return {
    kind: knowledgeEntityKind(value.kind), normalized: normalizeKnowledgeName(knowledgeName(value.normalized)),
    entityId: pageId(value.entityId),
  };
}

// Stable fact keys let the kernel's atomic creation constraint serialize alias claims.
export async function contentStableId(namespace: string, ...parts: string[]): Promise<FactId> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([namespace, ...parts]))));
  let value = 0n;
  for (const byte of hash.subarray(0, 16)) value = (value << 8n) | BigInt(byte);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let encoded = '';
  while (encoded.length < 26) {
    encoded = alphabet.charAt(Number(value & 31n)) + encoded;
    value >>= 5n;
  }
  return factId(encoded);
}

export function knowledgeNameId(kind: KnowledgeEntityKind, name: string) {
  return contentStableId(knowledgeNameType, kind, normalizeKnowledgeName(name));
}

export async function openKnowledgeEntity(read: AssetReadContext['read'], id: FactId, pinned?: FactSnapshot['ref']['rev']) {
  const redirects: FactSnapshot['ref'][] = [];
  let snapshot = await read.fact(id, pinned === undefined ? { mode: 'following' } : { mode: 'pinned', rev: pinned });
  let kind: KnowledgeEntityKind | undefined;
  const visited = new Set<FactId>();
  for (;;) {
    if (snapshot.type !== assetType) throw new AssetBasisError('规范实体类型不符。');
    const asset = parseAsset(snapshot.value);
    if (asset.kind !== 'concept' && asset.kind !== 'method' && asset.kind !== 'archetype') {
      throw new AssetBasisError('规范实体类型不符。');
    }
    await checkTextbookBasis(read, asset.basis ?? []);
    const { kind: entityKind, title, aliases, embedding, merged_into, kliProfile } = asset;
    const entity = {
      kind: entityKind, canonicalName: title, aliases,
      ...(embedding ? { embedding } : {}),
      ...(kliProfile ? { kliProfile } : {}),
      merged_into,
    };
    if (kind !== undefined && entity.kind !== kind) throw new AssetBasisError('规范实体重定向类型不符。');
    if (pinned !== undefined || entity.merged_into === null) return { snapshot, entity, redirects };
    if (visited.has(snapshot.ref.id)) throw new AssetBasisError('规范实体重定向成环。');
    visited.add(snapshot.ref.id);
    kind = entity.kind;
    redirects.push(snapshot.ref);
    snapshot = await read.fact(entity.merged_into, { mode: 'following' });
  }
}

export async function openKnowledgeName(read: AssetReadContext['read'], kind: KnowledgeEntityKind, name: string) {
  let fact;
  try {
    fact = await read.fact(await knowledgeNameId(kind, name), { mode: 'following' });
  } catch (error) {
    if (error instanceof FactNotFoundError) return undefined;
    throw error;
  }
  if (fact.type !== knowledgeNameType) throw new Error('规范名称索引类型不符。');
  const binding = parseKnowledgeName(fact.value);
  if (binding.kind !== kind || binding.normalized !== normalizeKnowledgeName(name)) {
    throw new Error('规范名称索引与请求不符。');
  }
  return openKnowledgeEntity(read, binding.entityId);
}
