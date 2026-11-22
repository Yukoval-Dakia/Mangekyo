import { factId, type FactId } from '@mangekyo/kernel';
import { contentStableId } from './knowledge-entity.ts';

export const confirmIntakeQuestionsCommand = 'content.confirmIntakeQuestions';
export const materialType = 'activity.textMaterial';
export const assetType = 'content.asset';

export async function intakeQuestionId(materialId: FactId, draftId: string): Promise<FactId> {
  return contentStableId('content.intakeQuestion', materialId, draftId);
}

export type ConfirmIntakeQuestionsItem = {
  readonly draftId: string;
  readonly title: string;
  readonly stem: string;
  readonly options?: readonly { readonly label: string; readonly text: string }[];
  readonly questionId?: FactId;
};

export type ConfirmIntakeQuestionsInput = {
  readonly confirmedByLearner: true;
  readonly materialId: FactId;
  readonly expectedMaterialRev: number;
  readonly purpose?: 'storage' | 'teaching';
  readonly items: readonly ConfirmIntakeQuestionsItem[];
};

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label}格式无效。`);
  return input as Record<string, unknown>;
}

function text(input: unknown, label: string, limit: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > limit || !input.isWellFormed() || input.includes('\u0000')) {
    throw new Error(`${label}无效。`);
  }
  return input.trim();
}

function option(input: unknown): { readonly label: string; readonly text: string } {
  const row = object(input, '题目选项');
  if (Object.keys(row).length !== 2) throw new Error('题目选项字段无效。');
  return { label: text(row.label, '选项字母', 40), text: text(row.text, '选项内容', 4_000) };
}

export function parseConfirmIntakeQuestions(input: unknown): ConfirmIntakeQuestionsInput {
  const row = object(input, '拍卷题目确认');
  const allowed = new Set(['confirmedByLearner', 'materialId', 'expectedMaterialRev', 'purpose', 'items']);
  if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('拍卷题目确认包含未知字段。');
  if (row.confirmedByLearner !== true) throw new Error('将拍卷题目加入正式题库需要学习者显式确认。');
  const expectedMaterialRev = row.expectedMaterialRev;
  if (typeof expectedMaterialRev !== 'number' || !Number.isSafeInteger(expectedMaterialRev) || expectedMaterialRev < 1) {
    throw new Error('材料版本无效。');
  }
  if (row.purpose !== undefined && row.purpose !== 'storage' && row.purpose !== 'teaching') {
    throw new Error('题目用途无效。');
  }
  const items = row.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 60) throw new Error('需要确认 1 到 60 道拍卷题目。');
  const parsed = items.map(value => {
    const item = object(value, '拍卷题目');
    const itemAllowed = new Set(['draftId', 'title', 'stem', 'options', 'questionId']);
    if (Object.keys(item).some(key => !itemAllowed.has(key))) throw new Error('拍卷题目包含未知字段。');
    const options = item.options === undefined ? undefined
      : Array.isArray(item.options) && item.options.length <= 60 ? item.options.map(option) : null;
    if (options === null) throw new Error('题目选项数量无效。');
    return {
      draftId: text(item.draftId, '草案标识', 80),
      title: text(item.title, '题目标题', 240),
      stem: text(item.stem, '题干', 20_000),
      ...(options === undefined ? {} : { options }),
      ...(item.questionId === undefined ? {} : { questionId: factId(text(item.questionId, '题目标识', 26)) }),
    };
  });
  if (new Set(parsed.map(item => item.draftId)).size !== parsed.length) throw new Error('草案标识不能重复。');
  return {
    confirmedByLearner: true,
    materialId: factId(text(row.materialId, '材料标识', 26)),
    expectedMaterialRev,
    ...(row.purpose === undefined ? {} : { purpose: row.purpose }),
    items: parsed,
  };
}

export function intakeQuestionFullPrompt(item: ConfirmIntakeQuestionsItem): string {
  const options = item.options ?? [];
  const optionText = options.map(option => `${option.label}. ${option.text}`).join('\n');
  const prompt = optionText ? `${item.stem}\n${optionText}` : item.stem;
  if (!prompt.isWellFormed() || prompt.includes('\u0000')) throw new Error('完整题干包含无效字符。');
  return prompt;
}
