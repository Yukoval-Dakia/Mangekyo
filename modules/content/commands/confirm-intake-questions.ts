import { FactNotFoundError, defineCommand, type FactId, type FactWrite } from '@mangekyo/kernel';
import materialFact from '../facts/material.ts';
import {
  assetType,
  confirmIntakeQuestionsCommand,
  intakeConceptId,
  intakeConceptScope,
  IntakeQuestionConfirmConflict,
  intakeQuestionConceptEdgeId,
  intakeQuestionFullPrompt,
  intakeQuestionId,
  materialType,
  parseConfirmIntakeQuestions,
} from '../intake-question-bank.ts';
import { checkTextbookBasis, parseAsset, questionAsset } from '../asset.ts';
import {
  knowledgeEdgeType,
  parseKnowledgeEdge,
  sourceUse,
  type KnowledgeSourceUse,
} from '../knowledge-edge.ts';
import {
  knowledgeName,
  knowledgeNameId,
  knowledgeNameType,
  normalizeKnowledgeName,
  openKnowledgeEntity,
  openKnowledgeName,
} from '../knowledge-entity.ts';
import { writeQuestion } from '../question-writes.ts';

function allowsPurpose(purposes: readonly string[], required: 'storage' | 'teaching'): boolean {
  return required === 'storage' || purposes.includes('teaching') || purposes.includes('all');
}

export default defineCommand({
  type: confirmIntakeQuestionsCommand,
  destructive: true,
  schema: { parse: parseConfirmIntakeQuestions },
  async write(ctx, input): Promise<readonly FactWrite[]> {
    const material = await ctx.read.fact(input.materialId, { mode: 'following' });
    if (material.type !== materialType) throw new Error('来源不是拍卷材料。');
    if (material.ref.rev !== input.expectedMaterialRev) throw new Error('材料版本已变化，请重新核对拍卷题目。');
    materialFact.schema.parse(material.value);
    if (input.purpose === 'teaching' && !material.purpose.includes('teaching') && !material.purpose.includes('all')) {
      throw new IntakeQuestionConfirmConflict('这份材料未授权教学用途。');
    }
    const purpose = input.purpose ?? 'storage';
    const allowedPurpose = purpose === 'teaching' ? ['storage', 'teaching'] : ['storage'];
    const basis = [{
      id: material.ref.id, rev: material.ref.rev, epoch: material.accessEpoch, type: materialType,
    }];
    const writes: FactWrite[] = [];
    const resolvedConcepts = new Map<string, { readonly id: FactId; readonly use: KnowledgeSourceUse }>();
    const seenEdgeIds = new Set<FactId>();

    const resolveOrCreateConcept = async (tag: string) => {
      const canonicalName = knowledgeName(tag);
      const normalized = normalizeKnowledgeName(canonicalName);
      const cached = resolvedConcepts.get(normalized);
      if (cached) return cached;

      const named = await openKnowledgeName(ctx.read, 'concept', canonicalName);
      if (named) {
        if (named.entity.kind !== 'concept') throw new IntakeQuestionConfirmConflict('规范概念类型不符。');
        if (!allowsPurpose(named.snapshot.purpose, purpose)) throw new IntakeQuestionConfirmConflict('已有概念节点未授权教学用途。');
        const resolved = {
          id: named.snapshot.ref.id,
          use: sourceUse({
            id: named.snapshot.ref.id, rev: named.snapshot.ref.rev, accessEpoch: named.snapshot.accessEpoch,
          }),
        };
        resolvedConcepts.set(normalized, resolved);
        return resolved;
      }

      const cid = await intakeConceptId(canonicalName);
      let existingConcept;
      try {
        existingConcept = await ctx.read.fact(cid, { mode: 'following' });
      } catch (error) {
        if (!(error instanceof FactNotFoundError)) throw error;
      }
      if (existingConcept) {
        const opened = await openKnowledgeEntity(ctx.read, cid);
        if (opened.entity.kind !== 'concept') throw new IntakeQuestionConfirmConflict('概念标识已被其他记录占用。');
        if (!allowsPurpose(opened.snapshot.purpose, purpose)) throw new IntakeQuestionConfirmConflict('已有概念节点未授权教学用途。');
        const resolved = {
          id: opened.snapshot.ref.id,
          use: sourceUse({
            id: opened.snapshot.ref.id, rev: opened.snapshot.ref.rev, accessEpoch: opened.snapshot.accessEpoch,
          }),
        };
        resolvedConcepts.set(normalized, resolved);
        return resolved;
      }

      const conceptData = parseAsset({
        kind: 'concept',
        title: canonicalName,
        aliases: [],
        merged_into: null,
        blocks: [],
        basis,
      });
      writes.push(
        { kind: 'create', id: cid, factType: assetType, data: conceptData, purpose: allowedPurpose },
        {
          kind: 'create',
          id: await knowledgeNameId('concept', canonicalName),
          factType: knowledgeNameType,
          data: { kind: 'concept', normalized, entityId: cid },
          purpose: allowedPurpose,
        },
      );
      const resolved = { id: cid, use: sourceUse({ id: cid, rev: 1, accessEpoch: '0' }) };
      resolvedConcepts.set(normalized, resolved);
      return resolved;
    };

    for (const item of input.items) {
      const id = await intakeQuestionId(input.materialId, item.draftId);
      if (item.questionId !== undefined && item.questionId !== id) throw new Error('题目标识与来源草案不匹配。');
      let existing;
      try {
        existing = await ctx.read.fact(id, { mode: 'following' });
      } catch (error) {
        if (!(error instanceof FactNotFoundError)) throw error;
      }
      let questionUse: KnowledgeSourceUse;
      let questionPurpose: readonly string[];
      if (existing) {
        if (existing.type !== assetType) throw new IntakeQuestionConfirmConflict('题目标识已被其他记录占用。');
        const existingAsset = questionAsset(existing.value);
        if (input.linkConcepts === true && item.conceptTags?.length) {
          await checkTextbookBasis(ctx.read, existingAsset.basis ?? []);
        }
        questionUse = sourceUse({ id: existing.ref.id, rev: existing.ref.rev, accessEpoch: existing.accessEpoch });
        questionPurpose = existing.purpose;
      } else {
        const fullPrompt = intakeQuestionFullPrompt(item);
        const asset = questionAsset({
          kind: 'question',
          title: item.title,
          promptBlockId: 'prompt',
          basis,
          blocks: [
            { id: 'prompt', parentId: null, body: { kind: 'text', text: fullPrompt } },
            {
              id: 'source', parentId: null,
              body: {
                kind: 'reference', role: 'citation',
                target: { fact: material.ref, type: materialType, anchor: { kind: 'whole' } },
              },
            },
          ],
        });
        writes.push(...await writeQuestion(ctx, { id, asset, teaching: purpose === 'teaching' }, 'revise'));
        questionUse = sourceUse({ id, rev: 1, accessEpoch: '0' });
        questionPurpose = allowedPurpose;
      }

      if (input.linkConcepts !== true || !item.conceptTags?.length) continue;
      if (!allowsPurpose(questionPurpose, purpose)) throw new IntakeQuestionConfirmConflict('已有题目未授权教学用途。');

      for (const tag of item.conceptTags) {
        const concept = await resolveOrCreateConcept(tag);
        const edgeId = await intakeQuestionConceptEdgeId(id, concept.id);
        if (seenEdgeIds.has(edgeId)) continue;
        let existingEdge;
        try {
          existingEdge = await ctx.read.fact(edgeId, { mode: 'following' });
        } catch (error) {
          if (!(error instanceof FactNotFoundError)) throw error;
        }
        if (existingEdge) {
          if (existingEdge.type !== knowledgeEdgeType) throw new IntakeQuestionConfirmConflict('知识边标识已被其他记录占用。');
          parseKnowledgeEdge(existingEdge.value);
          seenEdgeIds.add(edgeId);
          continue;
        }
        writes.push({
          kind: 'create',
          id: edgeId,
          factType: knowledgeEdgeType,
          purpose: allowedPurpose,
          data: parseKnowledgeEdge({
            kind: 'targets_concept',
            from: { kind: 'question', sourceUse: questionUse },
            to: { kind: 'concept', sourceUse: concept.use },
            sourceUses: [questionUse, concept.use],
            scope: intakeConceptScope,
          }),
        });
        seenEdgeIds.add(edgeId);
      }
    }
    return writes;
  },
});
