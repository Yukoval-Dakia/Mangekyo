import { isJson, type Asset as KernelAsset, learnerId, type FactRef, type FactSnapshot, type JsonObject, type ReadContext } from '@mangekyo/kernel';
import { bindQuestionAssessment } from './assessment-values.ts';
import { parseKnowledgeEntity, type KnowledgeEntityKind } from './knowledge-entity.ts';
import { fields, key, list, optionalKey, pageId, record, revision, text } from './parse.ts';

import { parseDisciplineContext, type DisciplineContext } from './discipline-context.ts';
import { parseTextbookPageState, textbookPageStateFields, type TextbookPageState } from './textbook-page-state.ts';

export const textbookPageType = 'content.textbookPage';
export const assetType = 'content.asset';
export class AssetBasisError extends Error {}
type AssetReader = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };
export type AssetReadContext = { learner: FactRef['learner']; read: AssetReader };
export type TextbookReadContext = AssetReadContext;

export type AssetAnchor =
  | { readonly kind: 'whole' }
  | { readonly kind: 'block'; readonly blockId: string }
  | { readonly kind: 'path'; readonly path: readonly string[] };

export type AssetReference = {
  readonly fact: FactRef;
  readonly type: string;
  readonly anchor: AssetAnchor;
};
export type TextbookAnchor = AssetAnchor;
export type TextbookReference = AssetReference;

export type TextbookBlockBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly order: 'bullet' | 'number' }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'formula'; readonly latex: string }
  | { readonly kind: 'image'; readonly source: TextbookReference; readonly alt: string }
  | {
    readonly kind: 'reference';
    readonly role: 'question' | 'work' | 'citation';
    readonly target: TextbookReference;
    readonly presentation?: 'embed';
  }
  | {
    readonly kind: 'related';
    readonly target: 'question' | 'work';
    readonly allOf: readonly {
      readonly field: 'knowledge' | 'method' | 'condition';
      readonly id: string;
    }[];
  };

export type BlockBody = TextbookBlockBody
  | { readonly kind: 'interaction'; readonly view: JsonObject }
  | { readonly kind: 'sharedMaterial'; readonly source: AssetReference };

type TypedBody = { readonly kind: string };
export type Block<Body extends TypedBody = BlockBody> = {
  readonly id: string;
  readonly parentId: string | null;
  readonly body: Body;
};
export type TextbookBlock = Block<TextbookBlockBody>;
const assetKinds = ['capture', 'textbook', 'question', 'concept', 'method', 'archetype', 'discipline'] as const;
export type ContentUnit = { readonly title: string; readonly basis?: readonly AssetBasis[] } & (
  { readonly kind: 'question'; readonly promptBlockId: string; readonly response_schema?: readonly JsonObject[];
    readonly assessment_contract?: readonly JsonObject[] }
  | { readonly kind: 'discipline'; readonly tags?: readonly string[]; readonly discipline_context?: DisciplineContext }
  | { readonly kind: KnowledgeEntityKind; readonly tags?: readonly string[] } &
    Omit<ReturnType<typeof parseKnowledgeEntity>, 'kind' | 'canonicalName'>
  | { readonly kind: Exclude<(typeof assetKinds)[number], 'question' | 'discipline' | KnowledgeEntityKind>; readonly tags?: readonly string[] }
);
export type Asset = KernelAsset<ContentUnit, Block>;
export type QuestionAsset = Extract<Asset, { kind: 'question' }>;

export type TextbookPage = TextbookPageState & {
  readonly title: string;
  readonly blocks: readonly TextbookBlock[];
  readonly tags?: readonly string[];
  readonly basis?: readonly TextbookBasis[];
};

export type AssetBasis = { readonly id: FactRef['id']; readonly rev: FactRef['rev']; readonly epoch: string; readonly type: string };
export type TextbookBasis = AssetBasis;

export function parseTextbookBasis(input: unknown): readonly TextbookBasis[] {
  const basis = list(input).map(item => {
    const value = record(item);
    fields(value, 'id', 'rev', 'epoch', 'type');
    const epoch = text(value.epoch, '依据授权版本');
    if (!/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('依据授权版本无效。');
    return { id: pageId(value.id), rev: revision(value.rev), epoch, type: key(value.type) };
  });
  if (basis.length > 128 || new Set(basis.map(item => `${item.id}:${item.rev}`)).size !== basis.length)
    throw new Error('教材依据重复或超过上限。');
  return basis;
}

export async function checkTextbookBasis(read: AssetReader, basis: readonly AssetBasis[]) {
  for (const {id, rev, epoch, type} of basis) {
    const fact = await read.fact(id, {mode:'pinned', rev});
    if (fact.type !== type || fact.accessEpoch !== epoch) throw new AssetBasisError('教材依据已变更。');
  }
}

export function mergeTextbookBasis(previous: readonly TextbookBasis[] | undefined, added: readonly TextbookBasis[]) {
  return parseTextbookBasis([...new Map([...(previous ?? []), ...added].map(source => [`${source.id}:${source.rev}`, source])).values()]);
}

export function requireTextbookBodyBasis(body: BlockBody, basis: readonly AssetBasis[]) {
  const source = assetBodyReference(body);
  if (source && !basis.some(w => w.id === source.fact.id && w.rev === source.fact.rev && w.type === source.type))
    throw new Error('请先打开教材块引用的来源版本。');
}

function parseAnchor(input: unknown): TextbookAnchor {
  const value = record(input);
  switch (value.kind) {
    case 'whole':
      fields(value, 'kind');
      return { kind: 'whole' };
    case 'block':
      fields(value, 'kind', 'blockId');
      return { kind: 'block', blockId: key(value.blockId) };
    case 'path': {
      fields(value, 'kind', 'path');
      const path = list(value.path).map(part => text(part, '来源路径'));
      if (!path.length) throw new Error('来源路径不能为空。');
      return { kind: 'path', path };
    }
    default:
      throw new Error('引用锚点无效。');
  }
}

export function parseTextbookReference(input: unknown): TextbookReference {
  const value = record(input);
  fields(value, 'fact', 'type', 'anchor');
  const fact = record(value.fact);
  fields(fact, 'learner', 'id', 'rev');
  const type = key(value.type);
  const anchor = parseAnchor(value.anchor);
  if (anchor.kind === 'block' && type !== textbookPageType && type !== assetType && type !== 'capture.source') {
    throw new Error('块锚点必须指向内容资产或教材页。');
  }
  return {
    fact: { learner: learnerId(text(fact.learner, '学习者标识')), id: pageId(fact.id), rev: revision(fact.rev) },
    type,
    anchor,
  };
}

export function parseTextbookBlockBody(input: unknown): TextbookBlockBody {
  const value = record(input);
  switch (value.kind) {
    case 'text':
      fields(value, 'kind', 'text');
      return { kind: 'text', text: text(value.text, '正文') };
    case 'list':
      fields(value, 'kind', 'order');
      if (value.order !== 'bullet' && value.order !== 'number') throw new Error('列表类型无效。');
      return { kind: 'list', order: value.order };
    case 'table': {
      fields(value, 'kind', 'rows');
      const rows = list(value.rows).map(row => list(row).map(cell => text(cell, '表格单元格', true)));
      const width = rows[0]?.length;
      if (!width || rows.some(row => row.length !== width)) throw new Error('表格必须有等宽的行。');
      return { kind: 'table', rows };
    }
    case 'formula':
      fields(value, 'kind', 'latex');
      return { kind: 'formula', latex: text(value.latex, '公式') };
    case 'image':
      fields(value, 'kind', 'source', 'alt');
      return { kind: 'image', source: parseTextbookReference(value.source), alt: text(value.alt, '图片说明') };
    case 'reference': {
      fields(value, 'kind', 'role', 'target', 'presentation');
      const { role } = value;
      if (role !== 'question' && role !== 'work' && role !== 'citation') throw new Error('引用关系无效。');
      const { presentation } = value;
      if (presentation !== undefined && presentation !== 'embed') throw new Error('引用展示方式无效。');
      return { kind: 'reference', role, target: parseTextbookReference(value.target),
        ...(presentation ? { presentation } : {}) };
    }
    case 'related': {
      fields(value, 'kind', 'target', 'allOf');
      const { target } = value;
      if (target !== 'question' && target !== 'work') throw new Error('关联视图目标无效。');
      const allOf = list(value.allOf).map(input => {
        const criterion = record(input);
        fields(criterion, 'field', 'id');
        const { field } = criterion;
        if (field !== 'knowledge' && field !== 'method' && field !== 'condition') {
          throw new Error('关联条件字段无效。');
        }
        return { field, id: key(criterion.id) } as const;
      });
      if (!allOf.length) throw new Error('关联视图必须有结构条件。');
      return { kind: 'related', target, allOf };
    }
    default:
      throw new Error('教材块类型无效。');
  }
}

export function checkTextbookTree(blocks: readonly Pick<Block, 'id' | 'parentId'>[]): void {
  const parents = new Map(blocks.map(block => [block.id, block.parentId]));
  if (parents.size !== blocks.length) throw new Error('教材块标识重复。');

  const checked = new Set<string>();
  for (const block of blocks) {
    const path = new Set<string>();
    let id: string | null = block.id;
    while (id !== null && !checked.has(id)) {
      if (path.has(id)) throw new Error('教材块不能嵌套在自身或其后代中。');
      path.add(id);
      const parentId = parents.get(id);
      if (parentId === undefined) throw new Error(`教材父块不存在：${id}`);
      id = parentId;
    }
    for (const visited of path) checked.add(visited);
  }
}

function objectData(input: unknown): JsonObject {
  const value = record(input);
  if (!isJson(value) || JSON.stringify(value).length > 48_000) throw new Error('块或评估声明载荷无效。');
  return value;
}

export function parseBlockBody(input: unknown): BlockBody {
  const value = record(input);
  if (value.kind === 'interaction') {
    fields(value, 'kind', 'view');
    return { kind: 'interaction', view: objectData(value.view) };
  }
  if (value.kind === 'sharedMaterial') {
    fields(value, 'kind', 'source');
    return { kind: 'sharedMaterial', source: parseTextbookReference(value.source) };
  }
  return parseTextbookBlockBody(value);
}

export function parseAssetBlocks(input: unknown): readonly Block[];
export function parseAssetBlocks<Body extends TypedBody>(input: unknown, parseBody: (body: unknown) => Body): readonly Block<Body>[];
export function parseAssetBlocks(input: unknown, parseBody: (value: unknown) => TypedBody = parseBlockBody): readonly Block<TypedBody>[] {
  const blocks = list(input).map(input => {
    const block = record(input);
    fields(block, 'id', 'parentId', 'body');
    return { id: key(block.id), parentId: optionalKey(block.parentId), body: parseBody(block.body) };
  });
  checkTextbookTree(blocks);
  return blocks;
}

function parseUnit(value: Record<string, unknown>) {
  const title = text(value.title, '标题').trim();
  if (title.length > 240) throw new Error('标题超过 240 字。');
  return { title, ...(value.basis === undefined ? {} : { basis: parseTextbookBasis(value.basis) }) };
}

function parseTags(value: Record<string, unknown>) {
  const tags = value.tags === undefined ? undefined : list(value.tags).map(tag => text(tag, '标签').trim());
  if (tags && (tags.length > 24 || tags.some(tag => tag.length > 120) || new Set(tags).size !== tags.length))
    throw new Error('教材标签重复或超过上限。');
  return tags ? { tags } : {};
}

export function parseTextbookPage(input: unknown): TextbookPage {
  const value = record(input);
  fields(value, 'title', 'blocks', 'tags', 'basis', ...textbookPageStateFields);
  const blocks = parseAssetBlocks(value.blocks, parseTextbookBlockBody);
  return { ...parseUnit(value), blocks, ...parseTags(value), ...parseTextbookPageState(value, blocks) };
}

export function parseAsset(input: unknown): Asset {
  const value = record(input);
  const kind = assetKinds.find(kind => kind === value.kind);
  if (!kind) throw new Error('内容资产类别无效。');
  const common = ['kind', 'title', 'blocks', 'basis'];
  if (kind === 'discipline') {
    fields(value, ...common, 'tags', 'discipline_context');
    return { kind, ...parseUnit(value), blocks: parseAssetBlocks(value.blocks), ...parseTags(value),
      ...(value.discipline_context === undefined ? {} : { discipline_context: parseDisciplineContext(value.discipline_context) }) };
  }
  if (kind === 'concept' || kind === 'method' || kind === 'archetype') {
    fields(value, ...common, 'tags', 'aliases', 'embedding', 'merged_into', 'mergedInto');
    const unit = parseUnit(value);
    const { canonicalName: _, ...entity } = parseKnowledgeEntity({
      kind, canonicalName: unit.title, aliases: value.aliases ?? [], merged_into: value.merged_into, mergedInto: value.mergedInto,
      ...(value.embedding === undefined ? {} : { embedding: value.embedding }),
    });
    return { ...unit, ...entity, blocks: parseAssetBlocks(value.blocks), ...parseTags(value) };
  }
  if (kind !== 'question') {
    fields(value, ...common, 'tags');
    return { kind, ...parseUnit(value), blocks: parseAssetBlocks(value.blocks), ...parseTags(value) };
  }
  fields(value, ...common, 'promptBlockId', 'response_schema', 'assessment_contract');
  const blocks = parseAssetBlocks(value.blocks);
  const promptBlockId = key(value.promptBlockId);
  if (blocks.length > 128 || !blocks.some(block => block.id === promptBlockId && block.body.kind === 'text'))
    throw new Error('题目需要一个固定题干块。');
  function contract(input: unknown) {
    const rows = list(input);
    if (!rows.length || rows.length > 32) throw new Error('题目评估声明需要 1–32 项。');
    return rows.map(objectData);
  }
  return { kind, ...parseUnit(value), blocks, promptBlockId,
    ...(value.response_schema === undefined ? {} : { response_schema: contract(value.response_schema) }),
    ...(value.assessment_contract === undefined ? {} : { assessment_contract: contract(value.assessment_contract) }) };
}

export function textbookPageFrom(fact: FactSnapshot): TextbookPage {
  if (fact.type !== textbookPageType) throw new Error('目标事实不是教材页。');
  return parseTextbookPage(fact.value);
}

export function locateTextbookBlock<Body extends BlockBody>(blocks: readonly Block<Body>[], blockId: string) {
  const index = blocks.findIndex(block => block.id === blockId);
  const block = blocks[index];
  if (!block) return null;
  const siblingIndex = blocks.slice(0, index).filter(sibling => sibling.parentId === block.parentId).length;
  return { block, siblingIndex };
}

function blockAt(fact: FactSnapshot, blockId: string) {
  const position = locateTextbookBlock(textbookPageFrom(fact).blocks, blockId);
  if (!position) throw new Error(`教材块不存在：${blockId}`);
  return { ...position, ref: fact.ref, accessEpoch: fact.accessEpoch };
}

async function pinnedFact(read: AssetReader, ref: FactRef): Promise<FactSnapshot> {
  const fact = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
  if (fact.ref.learner !== ref.learner || fact.ref.id !== ref.id || fact.ref.rev !== ref.rev) {
    throw new Error('引用与打开的事实版本不一致。');
  }
  return fact;
}

export async function openTextbookBlock(
  read: AssetReader,
  ref: FactRef,
  blockId: string,
  mode: 'pinned' | 'following' = 'pinned',
) {
  const original = blockAt(await pinnedFact(read, ref), blockId);
  if (mode === 'pinned') return original;
  const seen = new Set<string>();
  let id = ref.id;
  while (!seen.has(`${id}:${blockId}`)) {
    seen.add(`${id}:${blockId}`);
    const current = await read.fact(id, { mode: 'following' });
    const move = textbookPageFrom(current).movedBlocks?.find(item => item.blockId === blockId);
    if (!move) return blockAt(current, blockId);
    id = move.pageId;
    blockId = move.targetBlockId ?? blockId;
  }
  throw new Error('教材块移动记录成环。');
}

export async function openAssetReference(read: AssetReader, reference: AssetReference) {
  const { anchor } = reference;
  const fact = await pinnedFact(read, reference.fact);
  if (fact.type !== reference.type) throw new Error('引用的事实类型不符。');
  if (anchor.kind === 'block') {
    const blocks = fact.type === 'capture.source'
      ? list(record(record(fact.value).unit).blocks).map(record)
      : fact.type === assetType ? parseAsset(fact.value).blocks : textbookPageFrom(fact).blocks;
    if (!blocks.some(block => block.id === anchor.blockId)) throw new Error(`内容块不存在：${anchor.blockId}`);
  }
  if (anchor.kind === 'path') {
    let fragment: unknown = fact.value;
    for (const part of anchor.path) {
      if (typeof fragment !== 'object' || fragment === null
        || (Array.isArray(fragment) && !/^(0|[1-9][0-9]*)$/.test(part)) || !Object.hasOwn(fragment, part)) {
        throw new Error('引用的事实片段不存在。');
      }
      fragment = Reflect.get(fragment, part);
    }
  }
  return { ref: fact.ref, type: fact.type, anchor, accessEpoch: fact.accessEpoch };
}

export function assetBodyReference(body: BlockBody) {
  return body.kind === 'image' || body.kind === 'sharedMaterial' ? body.source : body.kind === 'reference' ? body.target : null;
}

export async function verifyAssetBlockReference(ctx: AssetReadContext, body: BlockBody) {
  const reference = assetBodyReference(body);
  if (reference === null) return null;
  if (reference.fact.learner !== ctx.learner) throw new Error('教材引用必须属于当前学习者。');
  return openAssetReference(ctx.read, reference);
}

export function questionAsset(value: unknown): QuestionAsset {
  const asset = parseAsset(value);
  if (asset.kind !== 'question') throw new Error('目标资产不是题目。');
  return asset;
}

export function freezeQuestionAssessment(asset: QuestionAsset, { id, rev }: Pick<FactRef, 'id' | 'rev'>) {
  const ref = { id, rev };
  return { releaseRef: ref, items: [{ itemId: 'question', promptRef: ref,
    ...bindQuestionAssessment(asset.response_schema, asset.assessment_contract, ref),
  }] };
}

export async function checkQuestionTeachingSources(read: AssetReader, asset: Pick<QuestionAsset, 'basis'>) {
  for (const source of asset.basis ?? []) {
    const pinned = await read.fact(source.id, { mode: 'pinned', rev: source.rev });
    const current = await read.fact(source.id, { mode: 'following' });
    if (pinned.type !== source.type || pinned.accessEpoch !== source.epoch ||
        ![pinned, current].every(opened => opened.purpose.includes('teaching') || opened.purpose.includes('all'))) {
      throw new Error('题目来源未授权教学用途或依据已变化。');
    }
  }
}

export function questionPrompt(asset: QuestionAsset) {
  const body = locateTextbookBlock(asset.blocks, asset.promptBlockId)?.block.body;
  if (body?.kind !== 'text') throw new Error('题目缺少题干。');
  return body.text;
}
