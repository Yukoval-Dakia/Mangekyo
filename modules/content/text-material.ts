export const materialType = 'activity.textMaterial';

function field(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('记录字段无效');
  return value;
}

export function textMaterial(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('记录格式无效');
  const value = input as Record<string, unknown>;
  const title = field(value.title, 240);
  const text = field(value.text, 4000);
  if (!title.isWellFormed() || title.includes('\u0000') || !text.isWellFormed() || text.includes('\u0000'))
    throw new Error('材料包含无效字符');
  return { title, text };
}
