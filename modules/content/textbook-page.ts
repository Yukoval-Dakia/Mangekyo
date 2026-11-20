import { learnerId, type FactRef, type FactSnapshot, type ReadContext } from '@mangekyo/kernel';
import { fields, key, list, optionalKey, pageId, record, revision, text } from './parse.ts';

export const textbookPageType = 'content.textbookPage';
type TextbookReader = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };
export type TextbookReadContext = { learner: FactRef['learner']; read: TextbookReader };

export type TextbookAnchor =
  | { readonly kind: 'whole' }
  | { readonly kind: 'block'; readonly blockId: string }
  | { readonly kind: 'path'; readonly path: readonly string[] };

export type TextbookReference = {
  readonly fact: FactRef;
  readonly type: string;
  readonly anchor: TextbookAnchor;
};

export type TextbookBlockBody =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly order: 'bullet' | 'number' }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'formula'; readonly latex: string }
  | { readonly kind: 'image'; readonly source: TextbookReference; readonly alt: string }
  | { readonly kind: 'reference'; readonly role: 'question' | 'work' | 'citation'; readonly target: TextbookReference }
  | {
    readonly kind: 'related';
    readonly target: 'question' | 'work';
    readonly allOf: readonly {
      readonly field: 'knowledge' | 'method' | 'condition';
      readonly id: string;
    }[];
  };

export type TextbookBlock = {
  readonly id: string;
  readonly parentId: string | null;
  readonly body: TextbookBlockBody;
};

export type TextbookPage = {
  readonly title: string;
  readonly blocks: readonly TextbookBlock[];
  readonly tags?: readonly string[];
  readonly basis?: readonly TextbookBasis[];
};

export type TextbookBasis = { readonly id: FactRef['id']; readonly rev: FactRef['rev']; readonly epoch: string; readonly type: string };

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

export async function checkTextbookBasis(read: TextbookReader, basis: readonly TextbookBasis[]) {
  for (const {id, rev, epoch, type} of basis) {
    const fact = await read.fact(id, {mode:'pinned', rev});
    if (fact.type !== type || fact.accessEpoch !== epoch) throw new Error('教材依据已变更。');
  }
}

export function mergeTextbookBasis(previous: readonly TextbookBasis[] | undefined, added: readonly TextbookBasis[]) {
  return parseTextbookBasis([...new Map([...(previous ?? []), ...added].map(source => [`${source.id}:${source.rev}`, source])).values()]);
}

export function requireTextbookBodyBasis(body: TextbookBlockBody, basis: readonly TextbookBasis[]) {
  const source = textbookBodyReference(body);
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
  if (anchor.kind === 'block' && type !== textbookPageType) {
    throw new Error('教材块锚点必须指向教材页。');
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
      fields(value, 'kind', 'role', 'target');
      const { role } = value;
      if (role !== 'question' && role !== 'work' && role !== 'citation') throw new Error('引用关系无效。');
      return { kind: 'reference', role, target: parseTextbookReference(value.target) };
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

export function checkTextbookTree(blocks: readonly TextbookBlock[]): void {
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

export function parseTextbookPage(input: unknown): TextbookPage {
  const value = record(input);
  fields(value, 'title', 'blocks', 'tags', 'basis');
  const title = text(value.title, '标题').trim();
  if (title.length > 240) throw new Error('标题超过 240 字。');
  const blocks = list(value.blocks).map(input => {
    const block = record(input);
    fields(block, 'id', 'parentId', 'body');
    return { id: key(block.id), parentId: optionalKey(block.parentId), body: parseTextbookBlockBody(block.body) };
  });
  checkTextbookTree(blocks);
  const tags = value.tags === undefined ? undefined : list(value.tags).map(tag => text(tag, '标签').trim());
  if (tags && (tags.length > 24 || tags.some(tag => tag.length > 120) || new Set(tags).size !== tags.length))
    throw new Error('教材标签重复或超过上限。');
  return { title, blocks, ...(tags ? {tags} : {}), ...(value.basis === undefined ? {} : {basis:parseTextbookBasis(value.basis)}) };
}

export function textbookPageFrom(fact: FactSnapshot): TextbookPage {
  if (fact.type !== textbookPageType) throw new Error('目标事实不是教材页。');
  return parseTextbookPage(fact.value);
}

export function locateTextbookBlock(blocks: readonly TextbookBlock[], blockId: string) {
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

async function pinnedFact(read: TextbookReader, ref: FactRef): Promise<FactSnapshot> {
  const fact = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
  if (fact.ref.learner !== ref.learner || fact.ref.id !== ref.id || fact.ref.rev !== ref.rev) {
    throw new Error('引用与打开的事实版本不一致。');
  }
  return fact;
}

export async function openTextbookBlock(
  read: TextbookReader,
  ref: FactRef,
  blockId: string,
  mode: 'pinned' | 'following' = 'pinned',
) {
  const original = blockAt(await pinnedFact(read, ref), blockId);
  if (mode === 'pinned') return original;
  const current = await read.fact(ref.id, { mode: 'following' });
  return blockAt(current, blockId);
}

export async function openTextbookReference(read: TextbookReader, reference: TextbookReference) {
  const { anchor } = reference;
  const fact = await pinnedFact(read, reference.fact);
  if (fact.type !== reference.type) throw new Error('引用的事实类型不符。');
  if (anchor.kind === 'block') blockAt(fact, anchor.blockId);
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

export function textbookBodyReference(body: TextbookBlockBody) {
  return body.kind === 'image' ? body.source : body.kind === 'reference' ? body.target : null;
}

export async function verifyTextbookBodyReference(ctx: TextbookReadContext, body: TextbookBlockBody) {
  const reference = textbookBodyReference(body);
  if (reference === null) return null;
  if (reference.fact.learner !== ctx.learner) throw new Error('教材引用必须属于当前学习者。');
  return openTextbookReference(ctx.read, reference);
}
