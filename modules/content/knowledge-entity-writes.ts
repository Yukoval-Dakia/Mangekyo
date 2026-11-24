import { type CommandContext, type FactWrite } from '@mangekyo/kernel';
import { assetType, parseAsset } from './asset.ts';
import { edgePurposes, readKnowledgeUse, sourceUse } from './knowledge-edge.ts';
import {
  knowledgeNameId, knowledgeNameType, normalizeKnowledgeName, openKnowledgeEntity, openKnowledgeName, parseKnowledgeEntity,
} from './knowledge-entity.ts';
import { fields, list, pageId, record, revision, text } from './parse.ts';

export function parseCreateKnowledgeEntity(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'entity', 'purpose', 'resolution', 'summary');
  const entity = parseKnowledgeEntity(value.entity);
  if (entity.merged_into !== null) throw new Error('请通过合并命令建立实体重定向。');
  const purpose: unknown = value.purpose ?? 'storage';
  if (purpose !== 'storage' && purpose !== 'teaching') throw new Error('规范实体用途无效。');
  const resolution = record(value.resolution);
  fields(resolution, 'decision', 'reason', 'candidates', 'sourceUses');
  if (resolution.decision !== 'no-match') throw new Error('已有匹配时应连接现有实体。');
  const candidates = list(resolution.candidates).map(sourceUse);
  const sources = list(resolution.sourceUses).map(sourceUse);
  if (candidates.length > 32 || sources.length === 0 || sources.length > 32) {
    throw new Error('规范实体需要已打开的来源和有界的候选集合。');
  }
  let summary: string | undefined;
  if (value.summary !== undefined && value.summary !== null) {
    const trimmed = text(value.summary, '概念摘要', true).trim();
    if (trimmed.length > 600) throw new Error('概念摘要超过 600 字。');
    if (trimmed) summary = trimmed;
  }
  return {
    id: pageId(value.id), entity, purpose: purpose === 'teaching' ? 'teaching' as const : 'storage' as const,
    candidates, sources, reason: text(resolution.reason, '无匹配依据'),
    ...(summary ? { summary } : {}),
  };
}

export async function createKnowledgeEntity(
  ctx: CommandContext, { id, entity, purpose, candidates, sources, summary }: ReturnType<typeof parseCreateKnowledgeEntity>,
): Promise<readonly FactWrite[]> {
  const uses = await Promise.all(sources.map(use => readKnowledgeUse(ctx, use)));
  const names = [entity.canonicalName, ...entity.aliases].map(normalizeKnowledgeName);
  for (const name of names) {
    if (await openKnowledgeName(ctx.read, entity.kind, name)) throw new Error('已有同名实体，请使用现有身份。');
  }
  for (const candidate of candidates) {
    const opened = await readKnowledgeUse(ctx, candidate);
    if (opened.type === 'activity.workspaceEntry') {
      const legacy = record(opened.value);
      if (entity.kind === 'concept' && legacy.kind === 'concept' &&
          names.includes(normalizeKnowledgeName(text(legacy.title, '旧概念名称')))) {
        throw new Error('已有同名概念，请使用现有身份。');
      }
      continue;
    }
    const canonical = await openKnowledgeEntity(ctx.read, opened.ref.id);
    if (canonical.entity.kind === entity.kind &&
        [canonical.entity.canonicalName, ...canonical.entity.aliases].some(name => names.includes(normalizeKnowledgeName(name)))) {
      throw new Error('已有同名实体，请使用现有身份。');
    }
  }
  const currentSources = purpose === 'teaching'
    ? await Promise.all(sources.map(source => ctx.read.fact(source.id, { mode: 'following' })))
    : [];
  const allowed = edgePurposes(purpose, [...uses, ...currentSources]);
  const claims = await Promise.all(names.map(async normalized => ({
    kind: 'create' as const, id: await knowledgeNameId(entity.kind, normalized),
    factType: knowledgeNameType, data: { kind: entity.kind, normalized, entityId: id }, purpose: allowed,
  })));
  const { canonicalName: title, ...canonical } = entity;
  const basis = uses.map(fact => ({ id: fact.ref.id, rev: fact.ref.rev, epoch: fact.accessEpoch, type: fact.type }));
  const blocks = summary ? [{ id: 'summary', parentId: null, body: { kind: 'text' as const, text: summary } }] : [];
  return [{ kind: 'create', id, factType: assetType, data: { ...canonical, title, blocks, basis }, purpose: allowed }, ...claims];
}

export function parseMergeKnowledgeEntity(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'into', 'targetRev');
  const id = pageId(value.id);
  const into = pageId(value.into);
  if (id === into) throw new Error('规范实体不能合并到自身。');
  return { id, expectedRev: revision(value.expectedRev), into, targetRev: revision(value.targetRev) };
}

export async function mergeKnowledgeEntity(
  ctx: CommandContext, { id, expectedRev, into, targetRev }: ReturnType<typeof parseMergeKnowledgeEntity>,
): Promise<readonly FactWrite[]> {
  const source = await ctx.read.fact(id, { mode: 'following' });
  const target = await openKnowledgeEntity(ctx.read, into);
  if (source.type !== assetType || source.ref.rev !== expectedRev ||
      target.snapshot.ref.rev !== targetRev || target.redirects.length) {
    throw new Error('合并需要两个当前的规范实体修订。');
  }
  const { entity } = await openKnowledgeEntity(ctx.read, id, expectedRev);
  if (entity.merged_into !== null || entity.kind !== target.entity.kind) {
    throw new Error('仅能合并尚未重定向且类别相同的实体。');
  }
  if (!source.purpose.every(purpose => target.snapshot.purpose.includes('all') || target.snapshot.purpose.includes(purpose))) {
    throw new Error('合并目标没有覆盖来源实体的允许用途。');
  }
  return [{ kind: 'correct', id, expectedRev, data: { ...parseAsset(source.value), merged_into: into } }];
}
