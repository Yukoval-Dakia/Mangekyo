import { FactNotFoundError, factId, type FactId } from '@mangekyo/kernel';
import type { AssetReadContext } from './asset.ts';
import { knowledgeEdgeType } from './knowledge-edge.ts';
import {
  contentStableId,
  knowledgeName,
  normalizeKnowledgeName,
  openKnowledgeEntity,
  openKnowledgeName,
} from './knowledge-entity.ts';

export const confirmIntakeQuestionsCommand = 'content.confirmIntakeQuestions';
export const materialType = 'activity.textMaterial';
export const assetType = 'content.asset';
export const intakeConceptScope = 'intake-confirmed';
const maxConceptTagsPerQuestion = 6;
const conceptTagLimit = 120;

export async function intakeQuestionId(materialId: FactId, draftId: string): Promise<FactId> {
  return contentStableId('content.intakeQuestion', materialId, draftId);
}

export async function intakeConceptId(name: string): Promise<FactId> {
  return contentStableId('content.intakeConcept', 'concept', normalizeKnowledgeName(knowledgeName(name)));
}

export async function intakeQuestionConceptEdgeId(questionId: FactId, conceptId: FactId): Promise<FactId> {
  return contentStableId(knowledgeEdgeType, 'targets_concept', questionId, conceptId);
}

export type ConfirmIntakeQuestionsItem = {
  readonly draftId: string;
  readonly title: string;
  readonly stem: string;
  readonly options?: readonly { readonly label: string; readonly text: string }[];
  readonly questionId?: FactId;
  readonly conceptTags?: readonly string[];
};

export type ConfirmIntakeQuestionsInput = {
  readonly confirmedByLearner: true;
  readonly materialId: FactId;
  readonly expectedMaterialRev: number;
  readonly purpose?: 'storage' | 'teaching';
  readonly linkConcepts?: boolean;
  readonly items: readonly ConfirmIntakeQuestionsItem[];
};

export type IntakeQuestionConfirmationSummary = {
  readonly questionIds: readonly FactId[];
  readonly savedCount: number;
  readonly skippedCount: number;
  readonly conceptIds: readonly FactId[];
  readonly createdConceptCount: number;
  readonly linkedEdgeCount: number;
};

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}格式无效。`);
  return input as Record<string, unknown>;
}

function text(input: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof input !== 'string' || (!allowEmpty && !input.trim()) || input.length > limit || !input.isWellFormed() || input.includes('\u0000')) {
    throw new Error(`${label}无效。`);
  }
  return input.trim();
}

function option(input: unknown): { readonly label: string; readonly text: string } {
  const row = object(input, '题目选项');
  if (Object.keys(row).length !== 2) throw new Error('题目选项字段无效。');
  return { label: text(row.label, '选项字母', 40, true), text: text(row.text, '选项内容', 4_000) };
}

function parseConceptTags(input: unknown): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > maxConceptTagsPerQuestion) {
    throw new Error('单题知识点标签数量超过上限。');
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const cleaned = knowledgeName(text(raw, '知识点标签', conceptTagLimit));
    const key = normalizeKnowledgeName(cleaned);
    if (key.length > 240) throw new Error('知识点标签无效。');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(cleaned);
  }
  return tags;
}

export function parseConfirmIntakeQuestions(input: unknown): ConfirmIntakeQuestionsInput {
  const row = object(input, '拍卷题目确认');
  const allowed = new Set(['confirmedByLearner', 'materialId', 'expectedMaterialRev', 'purpose', 'linkConcepts', 'items']);
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('拍卷题目确认包含未知字段。');
  if (row.confirmedByLearner !== true) throw new Error('将拍卷题目加入正式题库需要学习者显式确认。');
  const expectedMaterialRev = row.expectedMaterialRev;
  if (typeof expectedMaterialRev !== 'number' || !Number.isSafeInteger(expectedMaterialRev) || expectedMaterialRev < 1) {
    throw new Error('材料版本无效。');
  }
  if (row.purpose !== undefined && row.purpose !== 'storage' && row.purpose !== 'teaching') {
    throw new Error('题目用途无效。');
  }
  if (row.linkConcepts !== undefined && typeof row.linkConcepts !== 'boolean') {
    throw new Error('是否关联知识图谱参数无效。');
  }
  const items = row.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 60) throw new Error('需要确认 1 到 60 道拍卷题目。');
  const parsed = items.map(value => {
    const item = object(value, '拍卷题目');
    const itemAllowed = new Set(['draftId', 'title', 'stem', 'options', 'questionId', 'conceptTags']);
    if (Object.keys(item).some(key => !itemAllowed.has(key))) throw new Error('拍卷题目包含未知字段。');
    const options = item.options === undefined ? undefined
      : Array.isArray(item.options) && item.options.length <= 60 ? item.options.map(option) : null;
    if (options === null) throw new Error('题目选项数量无效。');
    const conceptTags = parseConceptTags(item.conceptTags);
    return {
      draftId: text(item.draftId, '草案标识', 80),
      title: text(item.title, '题目标题', 240),
      stem: text(item.stem, '题干', 20_000),
      ...(options === undefined ? {} : { options }),
      ...(item.questionId === undefined ? {} : { questionId: factId(text(item.questionId, '题目标识', 26)) }),
      ...(conceptTags === undefined ? {} : { conceptTags }),
    };
  });
  if (new Set(parsed.map(item => item.draftId)).size !== parsed.length) throw new Error('草案标识不能重复。');
  return {
    confirmedByLearner: true,
    materialId: factId(text(row.materialId, '材料标识', 26)),
    expectedMaterialRev,
    ...(row.purpose === undefined ? {} : { purpose: row.purpose }),
    ...(row.linkConcepts === undefined ? {} : { linkConcepts: row.linkConcepts }),
    items: parsed,
  };
}

export function intakeQuestionFullPrompt(item: ConfirmIntakeQuestionsItem): string {
  const options = item.options ?? [];
  const optionText = options.map(option => (option.label ? `${option.label}. ${option.text}` : `- ${option.text}`)).join('\n');
  const prompt = optionText ? `${item.stem}\n${optionText}` : item.stem;
  if (!prompt.isWellFormed() || prompt.includes('\u0000')) throw new Error('完整题干包含无效字符。');
  return prompt;
}

export async function summarizeIntakeQuestionConfirmation(
  read: AssetReadContext['read'],
  input: ConfirmIntakeQuestionsInput,
  wrote: readonly { readonly id: FactId }[],
): Promise<IntakeQuestionConfirmationSummary> {
  const wroteIds = new Set(wrote.map(ref => ref.id));
  const questionIds = await Promise.all(input.items.map(item => intakeQuestionId(input.materialId, item.draftId)));
  const savedCount = questionIds.filter(id => wroteIds.has(id)).length;
  const skippedCount = questionIds.length - savedCount;
  if (input.linkConcepts !== true) {
    return { questionIds, savedCount, skippedCount, conceptIds: [], createdConceptCount: 0, linkedEdgeCount: 0 };
  }
  const conceptIdByNormalized = new Map<string, FactId>();
  const conceptIds: FactId[] = [];
  const seenConceptIds = new Set<FactId>();
  const edgeIds = new Set<FactId>();
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    const questionId = questionIds[index]!;
    for (const tag of item.conceptTags ?? []) {
      const normalized = normalizeKnowledgeName(tag);
      let conceptId = conceptIdByNormalized.get(normalized);
      if (!conceptId) {
        const named = await openKnowledgeName(read, 'concept', tag);
        if (named) {
          conceptId = named.snapshot.ref.id;
        } else {
          const fallbackId = await intakeConceptId(tag);
          try {
            const opened = await openKnowledgeEntity(read, fallbackId);
            conceptId = opened.snapshot.ref.id;
          } catch (error) {
            if (!(error instanceof FactNotFoundError)) throw error;
            conceptId = fallbackId;
          }
        }
        conceptIdByNormalized.set(normalized, conceptId);
      }
      if (!seenConceptIds.has(conceptId)) {
        seenConceptIds.add(conceptId);
        conceptIds.push(conceptId);
      }
      edgeIds.add(await intakeQuestionConceptEdgeId(questionId, conceptId));
    }
  }
  const createdConceptCount = conceptIds.filter(id => wroteIds.has(id)).length;
  const linkedEdgeCount = [...edgeIds].filter(id => wroteIds.has(id)).length;
  return { questionIds, savedCount, skippedCount, conceptIds, createdConceptCount, linkedEdgeCount };
}
