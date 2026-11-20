import { defineCommand, type FactWrite } from '@mangekyo/kernel';
import { assetType } from '../asset.ts';
import { edgePurposes, readKnowledgeUse, sourceUse } from '../knowledge-edge.ts';
import {
  knowledgeNameId, knowledgeNameType, normalizeKnowledgeName, openKnowledgeEntity, openKnowledgeName, parseKnowledgeEntity,
} from '../knowledge-entity.ts';
import { fields, list, pageId, record, text } from '../parse.ts';

export default defineCommand({
  type: 'content.createKnowledgeEntity',
  destructive: true,
  schema: { parse(input: unknown) {
    const value = record(input);
    fields(value, 'id', 'entity', 'purpose', 'resolution');
    const entity = parseKnowledgeEntity({ ...record(value.entity), mergedInto: null });
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
    return {
      id: pageId(value.id), entity, purpose: purpose === 'teaching' ? 'teaching' as const : 'storage' as const,
      candidates, sources, reason: text(resolution.reason, '无匹配依据'),
    };
  } },
  async write(ctx, { id, entity, purpose, candidates, sources }): Promise<readonly FactWrite[]> {
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
    return [{ kind: 'create', id, factType: assetType, data: { ...canonical, title, blocks: [], basis }, purpose: allowed }, ...claims];
  },
});
