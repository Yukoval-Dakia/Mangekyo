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
  const savedAt = value.savedAt;
  if (!title.isWellFormed() || title.includes('\u0000') || !text.isWellFormed() || text.includes('\u0000'))
    throw new Error('材料包含无效字符');
  if (savedAt === undefined) return { title, text };
  if (typeof savedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(savedAt) ||
    !Number.isFinite(Date.parse(savedAt)))
    throw new Error('材料保存时间无效');
  const [year = 0, month = 0, day = 0] = savedAt.slice(0, 10).split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== savedAt.slice(0, 10))
    throw new Error('材料保存时间无效');
  return { title, text, savedAt: new Date(savedAt).toISOString() };
}
