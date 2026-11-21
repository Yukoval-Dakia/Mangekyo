import type {CanonicalEvidenceSliceV1, Json} from '@mangekyo/kernel';
import type {ToolArgs} from './learning-tools.ts';

const sdkMethods = {
  attempts: ['since', 'subject', 'paper_ids'],
  forgetting_risks: ['horizon_hours'],
  kg_prereqs: ['kc_id', 'depth'],
  questions: ['kc_ids', 'answer_exposed', 'limit'],
  evidence_slice: [],
} as const;

export type PythonRead = {method: keyof typeof sdkMethods; args: ToolArgs};
export type PythonReadValue = Json | CanonicalEvidenceSliceV1;
const text = {type: 'string', minLength: 1, maxLength: 160} as const;
const ids = {type: 'array', items: text, minItems: 1, maxItems: 30} as const;
const sdkFields = {
  since: {...text, format: 'date-time'}, subject: text, paper_ids: ids,
  horizon_hours: {type: 'integer', minimum: 1, maximum: 168},
  kc_id: text, depth: {type: 'integer', minimum: 1, maximum: 3},
  kc_ids: {...ids, description: '任一指定知识点与题目的直接、当前获准图谱关系。'},
  answer_exposed: {type: 'boolean', description: 'false 只匹配本系统能核对曝光出口的独立新练习，true 只匹配经授权的实际答案展示。未知题项不进入布尔筛选，coverage 标记证据缺口。'},
  limit: {type: 'integer', minimum: 1, maximum: 30},
} as const;

export const runCalculationDefinition = {type: 'function', function: {
  name: 'run_calculation',
  description: '在隔离 Python 中统计、验算或生成图表。print 输出，绘图保存 PNG。在 reads 声明所需的 mangekyo 只读查询，代码中用相同参数。inputs 字典按本轮 @res_ 或 @calc_ 句柄取值。',
  parameters: {type: 'object', additionalProperties: false, required: ['code'], properties: {
    code: {type: 'string', minLength: 1, maxLength: 20_000},
    inputs: {type: 'array', maxItems: 8, items: {type: 'string'}},
    reads: {type: 'array', maxItems: 8, items: {oneOf: Object.entries(sdkMethods).map(([method, fields]) => ({
      type: 'object', required: ['method', 'args'], additionalProperties: false, properties: {
        method: {type: 'string', enum: [method]},
        args: {type: 'object', additionalProperties: false, ...(method === 'kg_prereqs' && {required: ['kc_id']}),
          properties: Object.fromEntries(fields.map(field => [field, sdkFields[field]]))},
      },
    }))}},
  }},
}};

function object(value: unknown): value is ToolArgs {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validField(field: keyof typeof sdkFields, value: unknown): boolean {
  const schema = sdkFields[field];
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= text.maxLength &&
        (field !== 'since' || (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value))));
    case 'array':
      return Array.isArray(value) && value.length >= ids.minItems && value.length <= ids.maxItems &&
        value.every(id => validField('kc_id', id)) && new Set(value).size === value.length;
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
    default:
      return typeof value === 'boolean';
  }
}

export function pythonReads(input: unknown): readonly PythonRead[] | undefined {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) return;
  const result: PythonRead[] = [];
  for (const item of input) {
    if (!object(item) || Object.keys(item).length !== 2 || typeof item.method !== 'string' ||
        !Object.hasOwn(sdkMethods, item.method) || !object(item.args)) return;
    const method = item.method as PythonRead['method'];
    const fields: readonly string[] = sdkMethods[method];
    if (method === 'kg_prereqs' && !Object.hasOwn(item.args, 'kc_id')) return;
    if (Object.entries(item.args).some(([key, value]) =>
      !fields.includes(key) || !validField(key as keyof typeof sdkFields, value))) return;
    result.push({method, args: item.args});
  }
  return result;
}
