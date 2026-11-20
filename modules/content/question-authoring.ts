import { isJson, type JsonObject } from '@mangekyo/kernel';
import { fields, key, record, revision, text } from './parse.ts';

const questionFields = ['title', 'prompt', 'response_schema', 'assessment_contract', 'interaction', 'sources', 'shared_materials'] as const;
const tagKinds = ['target_skill', 'prerequisite', 'optional_method', 'discriminator'] as const;

export class QuestionAuthoringError extends Error {
  constructor(readonly code: 'invalid_args' | 'limit_exceeded', readonly field: string, message: string) {
    super(message);
  }
}

function bounded(value: unknown, field: string, length: number, allowEmpty = false) {
  if (typeof value === 'string' && value.length > length)
    throw new QuestionAuthoringError('limit_exceeded', field, `${field}超过 ${length} 字。`);
  return text(value, field, allowEmpty);
}

function array(value: unknown, field: string, limit: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum)
    throw new QuestionAuthoringError('invalid_args', field, `${field}须为列表。`);
  if (value.length > limit) throw new QuestionAuthoringError('limit_exceeded', field, `${field}最多 ${limit} 项。`);
  return value;
}

function jsonObject(value: unknown, field: string): JsonObject {
  const object = record(value);
  if (!isJson(object)) throw new QuestionAuthoringError('invalid_args', field, `${field}须为 JSON 对象。`);
  if (JSON.stringify(object).length > 48_000)
    throw new QuestionAuthoringError('limit_exceeded', field, `${field}载荷过大。`);
  return object;
}

function source(value: unknown) {
  return bounded(value, '来源引用', 4096);
}

function references(value: unknown, field: string) {
  const parsed = array(value, field, 8).map(source);
  if (new Set(parsed).size !== parsed.length) throw new QuestionAuthoringError('invalid_args', field, '已打开的引用不能重复。');
  return parsed;
}

export function parseQuestionMetadata(input: unknown, allowEmpty = false) {
  const value = record(input);
  fields(value, 'solutions', 'tags');
  const solutions = array(value.solutions ?? [], 'solutions', 8).map(entry => {
    const solution = record(entry);
    fields(solution, 'method', 'explanation', 'source_ref', 'steps', 'hints', 'discriminator');
    const steps = array(solution.steps ?? [], 'steps', 16).map((entry, index) => bounded(entry, `步骤 ${index + 1}`, 1600));
    const hints = array(solution.hints ?? [], 'hints', 3).map((entry, index) => bounded(entry, `提示 L${index + 1}`, 1600));
    return {
      method: bounded(solution.method, '解法名称', 160), explanation: bounded(solution.explanation, '解法步骤', 4000),
      ...(steps.length ? { steps } : {}),
      ...(hints.length ? { hints } : {}),
      ...(solution.discriminator === undefined ? {} : { discriminator: bounded(solution.discriminator, '最短辨别题', 4000) }),
      ...(solution.source_ref === undefined ? {} : { source_ref: source(solution.source_ref) }),
    };
  });
  const tags = array(value.tags ?? [], 'tags', 16).map(entry => {
    const tag = record(entry);
    fields(tag, 'kind', 'term', 'scope', 'source_ref', 'version', 'contrast');
    const contrast = tag.contrast === undefined ? undefined : record(tag.contrast);
    if (contrast) fields(contrast, 'change', 'before', 'after');
    const kind = tagKinds.find(kind => kind === tag.kind);
    if (!kind) throw new QuestionAuthoringError('invalid_args', 'tags', '术语标签类别无效。');
    if (contrast && kind !== 'discriminator') throw new Error('最小条件改变只属于辨别标签。');
    let discriminator;
    if (contrast) {
      const before = bounded(contrast.before, '原条件下的预测', 500);
      const after = array(contrast.after, '辨别结果', 2, 2).map(entry => bounded(entry, '改变后的预测', 500));
      if (after[0] === after[1]) throw new Error('变式后的两种预测必须分离。');
      discriminator = { change: bounded(contrast.change, '最小条件改变', 500), before, after };
    }
    return { kind, term: bounded(tag.term, '术语', 64), scope: bounded(tag.scope, '适用范围', 240),
      source_ref: source(tag.source_ref),
      ...(tag.version === undefined ? {} : { version: key(tag.version) }),
      ...(discriminator ? { contrast: discriminator } : {}),
    };
  });
  if (!allowEmpty && !solutions.length && !tags.length) throw new QuestionAuthoringError('invalid_args', 'append_metadata', '请填写解法或术语标签。');
  return { solutions, tags };
}

function promptPatch(input: unknown) {
  const value = record(input);
  fields(value, 'block_id', 'anchor', 'replacement');
  return {
    block_id: bounded(value.block_id, '题干块标识', 128), anchor: bounded(value.anchor, '题干锚点', 2000),
    replacement: bounded(value.replacement, '替换内容', 4000, true),
  };
}

function frozenFields(value: Record<string, unknown>) {
  return {
    ...(value.response_schema === undefined ? {} : { response_schema: array(value.response_schema, 'response_schema', 32, 1)
      .map(entry => jsonObject(entry, '作答位')) }),
    ...(value.assessment_contract === undefined ? {} : { assessment_contract: array(value.assessment_contract, 'assessment_contract', 32, 1)
      .map(entry => jsonObject(entry, '评估标准')) }),
    ...(value.interaction === undefined ? {} : { interaction: jsonObject(value.interaction, '交互块') }),
    ...(value.sources === undefined ? {} : { sources: references(value.sources, 'sources') }),
    ...(value.shared_materials === undefined ? {} : { shared_materials: references(value.shared_materials, 'shared_materials') }),
  };
}

export function parseSaveQuestion(input: unknown) {
  try {
    const value = record(input);
    const metadata = value.append_metadata === undefined ? {} : { append_metadata: parseQuestionMetadata(value.append_metadata) };
    if (value.ref === undefined) {
      fields(value, ...questionFields, 'append_metadata');
      return { kind: 'create' as const, question: {
        title: bounded(value.title, 'title', 240).trim(), prompt: bounded(value.prompt, 'prompt', 8000),
        ...frozenFields(value),
      }, ...metadata };
    }
    fields(value, 'ref', 'expected_rev', 'patch', 'append_metadata');
    const patch = value.patch === undefined ? {} : record(value.patch);
    fields(patch, ...questionFields);
    if (!Object.keys(patch).length && !('append_metadata' in metadata))
      throw new QuestionAuthoringError('invalid_args', 'patch', '请传局部修改或要追加的解法、标签。');
    return {
      kind: 'revise' as const, ref: source(value.ref), expected_rev: revision(value.expected_rev),
      patch: {
        ...(patch.title === undefined ? {} : { title: bounded(patch.title, 'title', 240).trim() }),
        ...(patch.prompt === undefined ? {} : { prompt: promptPatch(patch.prompt) }),
        ...frozenFields(patch),
      },
      ...metadata,
    };
  } catch (error) {
    if (error instanceof QuestionAuthoringError) throw error;
    throw new QuestionAuthoringError('invalid_args', 'args', '请按题库新建参数或固定版本的局部修改格式填写。');
  }
}
