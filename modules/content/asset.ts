import { isJson, type Asset as KernelAsset, learnerId, parseFactRevisionBasis, type FactRevisionBasis, type FactRef, type FactSnapshot, type JsonObject, type ReadContext } from '@mangekyo/kernel';
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
const assetBasisLimit = 128;

export function parseTextbookBasis(input: unknown): readonly TextbookBasis[] {
  const basis = list(input).map(item => {
    const value = record(item);
    fields(value, 'id', 'rev', 'epoch', 'type');
    const epoch = text(value.epoch, '依据授权版本');
    if (!/^(0|[1-9][0-9]*)$/.test(epoch)) throw new Error('依据授权版本无效。');
    return { id: pageId(value.id), rev: revision(value.rev), epoch, type: key(value.type) };
  });
  if (basis.length > assetBasisLimit || new Set(basis.map(item => `${item.id}:${item.rev}`)).size !== basis.length)
    throw new Error('教材依据重复或超过上限。');
  return basis;
}

export async function checkTextbookBasis(read: AssetReader, basis: readonly AssetBasis[]) {
  for (const {id, rev, epoch, type} of basis) {
    const fact = await read.fact(id, {mode:'pinned', rev});
    if (fact.type !== type || fact.accessEpoch !== epoch) {
      const widened = await isPurposeWidenedContinuation(read, fact, epoch);
      if (!widened || widened.type !== type) throw new AssetBasisError('教材依据已变更。');
    }
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length &&
    leftKeys.every(k => Object.hasOwn(right, k) && sameJsonValue(Reflect.get(left, k), Reflect.get(right, k)));
}

const purposeWideningStepLimit = 16;

function strictlyWidens(prev: readonly string[], next: readonly string[]): boolean {
  const covers = (superset: readonly string[], p: string) => superset.includes(p) || superset.includes('all');
  if (!prev.every(p => covers(next, p))) return false;
  return next.some(p => !covers(prev, p));
}

/**
 * A pure `set_purpose` write bumps `current_rev` and `access_epoch` by 1 while
 * keeping the data bytes identical and writing a strictly wider revision
 * purpose. When a basis/use was pinned at (rev, epoch) and the fact has since
 * been widened one or more times, follow the chain rev-by-rev and confirm
 * every hop is a monotone widening (no content edit, no narrowing, no skipped
 * rev). Returns the latest snapshot when the whole chain is a widening; else
 * returns undefined so the caller must reject.
 */
export async function isPurposeWidenedContinuation(
  read: AssetReader,
  pinned: FactSnapshot,
  expectedEpoch: string,
): Promise<FactSnapshot | undefined> {
  const current = await read.fact(pinned.ref.id, { mode: 'following' });
  if (current.ref.learner !== pinned.ref.learner || current.ref.id !== pinned.ref.id ||
      current.type !== pinned.type) return undefined;
  const steps = current.ref.rev - pinned.ref.rev;
  if (steps <= 0 || steps > purposeWideningStepLimit) return undefined;
  if (BigInt(current.accessEpoch) - BigInt(expectedEpoch) !== BigInt(steps)) return undefined;
  if (!sameJsonValue(current.value, pinned.value)) return undefined;
  let previous = pinned;
  for (let hop = 0; hop < steps; hop++) {
    const next = hop === steps - 1 ? current
      : await read.fact(pinned.ref.id, { mode: 'pinned', rev: (pinned.ref.rev + hop + 1) as FactRef['rev'] });
    if (next.ref.rev !== pinned.ref.rev + hop + 1 || !sameJsonValue(next.value, previous.value) ||
        !strictlyWidens(previous.purpose, next.purpose)) return undefined;
    previous = next;
  }
  return current;
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
    fields(value, ...common, 'tags', 'aliases', 'embedding', 'merged_into', 'mergedInto', 'kliProfile');
    const unit = parseUnit(value);
    const { canonicalName: _, ...entity } = parseKnowledgeEntity({
      kind, canonicalName: unit.title, aliases: value.aliases ?? [], merged_into: value.merged_into, mergedInto: value.mergedInto,
      ...(value.embedding === undefined ? {} : { embedding: value.embedding }),
      ...(value.kliProfile === undefined ? {} : { kliProfile: value.kliProfile }),
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
    if (!blocks.some(block => block.id === anchor.blockId)) throw new AssetBasisError(`内容块不存在：${anchor.blockId}`);
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

type QuestionSource =
  | ({ readonly mode: 'pinned' } & AssetBasis)
  | ({ readonly mode: 'following' } & FactRevisionBasis);

/** Frozen bank items expose their licensed question and source versions as Asset witnesses. */
export function frozenBankQuestionBasis(input: unknown) {
  const { sourceQuestionRef, sourceAccessEpoch, sourceBasis } = record(input);
  const { id, rev } = record(sourceQuestionRef);
  const [question] = parseTextbookBasis([{ id, rev, epoch: sourceAccessEpoch, type: assetType }]);
  return [question!, ...parseTextbookBasis(sourceBasis)] as const;
}

function frozenWorkbookBasis(value: unknown): AssetBasis[] {
  const { materialId, questions } = record(value);
  if (materialId != null) throw new AssetBasisError('来源卷缺少材料的固定授权见证。');
  return list(questions).flatMap(input => {
    const item = record(input);
    if (item.kind === 'bank') return frozenBankQuestionBasis(item);
    if (item.sourceQuestionRef != null) throw new AssetBasisError('来源卷缺少题目的固定授权见证。');
    return [];
  });
}

function questionSources(fact: FactSnapshot): QuestionSource[] {
  if (fact.type === 'activity.workspaceEntry') {
    return list(record(fact.value).basis).map(input => ({ mode: 'following', ...parseFactRevisionBasis(input) }));
  }
  const basis = fact.type === assetType ? parseAsset(fact.value).basis
    : fact.type === textbookPageType ? textbookPageFrom(fact).basis
    : fact.type === 'activity.workbookPaper' ? frozenWorkbookBasis(fact.value)
    : fact.type === 'activity.workbookAttempt' ? frozenWorkbookBasis(record(fact.value).paper) : undefined;
  return (basis ?? []).map(source => ({ mode: 'pinned', ...source }));
}

export async function checkQuestionTeachingSources(read: AssetReader, asset: Pick<QuestionAsset, 'basis'>) {
  const pending: QuestionSource[] = (asset.basis ?? []).map(source => ({ mode: 'pinned', ...source }));
  const checked = new Map<string, FactSnapshot>();
  const unavailable = () => new AssetBasisError('题目来源未授权教学用途或依据已变化。');

  while (pending.length) {
    const source = pending.pop()!;
    const key = `${source.mode}:${source.id}:${source.rev}`;
    const previous = checked.get(key);
    if (!previous && checked.size >= assetBasisLimit) throw unavailable();
    const fact = previous ?? await read.fact(source.id, source.mode === 'pinned'
      ? { mode: 'pinned', rev: source.rev, requirePurpose: 'teaching' }
      : { mode: 'following' });
    if (fact.ref.id !== source.id || fact.ref.rev !== source.rev || fact.accessEpoch !== source.epoch ||
        (source.mode === 'pinned' && fact.type !== source.type) ||
        (!fact.purpose.includes('teaching') && !fact.purpose.includes('all'))) throw unavailable();
    if (previous) continue;

    checked.set(key, fact);
    try { pending.push(...questionSources(fact)); }
    catch { throw unavailable(); }
  }
}

export async function refreshPurposeOnlyTeachingSources(
  read: AssetReader,
  sources: NonNullable<QuestionAsset['basis']>,
): Promise<NonNullable<QuestionAsset['basis']>> {
  return Promise.all(sources.map(async source => {
    const current = await read.fact(source.id, { mode: 'following' });
    if (current.ref.rev === source.rev && current.accessEpoch === source.epoch) return source;
    const prior = await read.fact(source.id, { mode: 'pinned', rev: source.rev });
    if (current.type !== source.type || current.ref.rev <= source.rev ||
        BigInt(current.accessEpoch) <= BigInt(source.epoch) ||
        JSON.stringify(current.value) !== JSON.stringify(prior.value) ||
        (!current.purpose.includes('teaching') && !current.purpose.includes('all'))) {
      throw new AssetBasisError('题目来源未授权教学用途或依据已变化。');
    }
    return { ...source, rev: current.ref.rev, epoch: current.accessEpoch };
  }));
}

export function questionPrompt(asset: QuestionAsset) {
  const body = locateTextbookBlock(asset.blocks, asset.promptBlockId)?.block.body;
  if (body?.kind !== 'text') throw new Error('题目缺少题干。');
  return body.text;
}

export function assetSummary(asset: Pick<Asset, 'blocks'>, limit = 200): string | null {
  const content = asset.blocks
    .map(block => block.body.kind === 'text' ? block.body.text : block.body.kind === 'formula' ? block.body.latex : '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return content ? content.slice(0, limit) : null;
}

export type QuestionSolutionFields = {
  readonly answer?: string;
  readonly rubric?: string;
};

const answerLabelPattern = /^(?:参考答案|标准答案|答案)\s*[：:]\s*(.*)$/;
const rubricLabelPattern = /^(?:评分要点|评分标准|解析|解题思路|要点|说明)\s*[：:]\s*(.*)$/;

export function questionSolutionFields(asset: QuestionAsset): QuestionSolutionFields {
  const answerParts: string[] = [];
  const rubricParts: string[] = [];
  for (const block of asset.blocks) {
    if (block.id === asset.promptBlockId) continue;
    const raw = block.body.kind === 'text' ? block.body.text : block.body.kind === 'formula' ? block.body.latex : '';
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let section: 'answer' | 'rubric' | null = null;
    const blockAnswers: string[] = [];
    const blockRubrics: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const answerMatch = answerLabelPattern.exec(line.trim());
      if (answerMatch) {
        section = 'answer';
        if (answerMatch[1]?.trim()) blockAnswers.push(answerMatch[1].trim());
        continue;
      }
      const rubricMatch = rubricLabelPattern.exec(line.trim());
      if (rubricMatch) {
        section = 'rubric';
        if (rubricMatch[1]?.trim()) blockRubrics.push(rubricMatch[1].trim());
        continue;
      }
      if (section === 'answer' && line.trim()) blockAnswers.push(line.trim());
      else if (section === 'rubric' && line.trim()) blockRubrics.push(line.trim());
    }
    if (blockAnswers.length || blockRubrics.length) {
      if (blockAnswers.length) answerParts.push(blockAnswers.join('\n'));
      if (blockRubrics.length) rubricParts.push(blockRubrics.join('\n'));
    } else if (block.id === 'answer' || block.id === 'solution') {
      answerParts.push(trimmed);
    } else {
      rubricParts.push(trimmed);
    }
  }
  const answer = answerParts.join('\n').trim().slice(0, 4000);
  const rubric = rubricParts.join('\n').trim().slice(0, 8000);
  return { ...(answer ? { answer } : {}), ...(rubric ? { rubric } : {}) };
}

export type QuickPaperDraftQuestion = {
  readonly kind: string;
  readonly prompt: string;
  readonly rubric?: string | undefined;
  readonly answers?: readonly string[] | undefined;
  readonly explanation?: string | null | undefined;
  readonly sourceQuestionRef?: { readonly id: string; readonly rev: number } | undefined;
};

export function applyAssetQuestionSolutions<Q extends QuickPaperDraftQuestion>(
  draft: { readonly title: string; readonly questions: readonly Q[] },
  solutions: ReadonlyMap<string, QuestionSolutionFields>,
): { readonly title: string; readonly questions: (Q | QuickPaperDraftQuestion)[] } {
  return {
    title: draft.title,
    questions: draft.questions.map((question): Q | QuickPaperDraftQuestion => {
      const ref = question.sourceQuestionRef;
      if (!ref) return question;
      const solution = solutions.get(ref.id);
      if (!solution || (!solution.answer && !solution.rubric)) return question;
      if (solution.rubric) {
        const rubric = solution.answer ? `参考答案：${solution.answer}\n评分要点：${solution.rubric}` : solution.rubric;
        return { kind: 'rubric', prompt: question.prompt, rubric: rubric.slice(0, 8000), ...(solution.answer ? { explanation: solution.answer } : {}), sourceQuestionRef: ref };
      }
      return { kind: 'exact', prompt: question.prompt, answers: [solution.answer!], sourceQuestionRef: ref };
    }),
  };
}

export type AssetWorkspaceDisplay = {
  readonly title: string;
  readonly excerpt: string;
  readonly text: string;
  readonly kind?: string;
  readonly tags?: readonly string[];
  readonly question?: { prompt: string; answer?: string; rubric?: string };
};

function cleanDisplayText(raw: string): string {
  return raw.replace(/\u0000/g, '');
}

function compactExcerpt(raw: string, limit = 240): string {
  const compact = cleanDisplayText(raw).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit) + '…' : compact;
}

function renderAssetBlocks(blocks: readonly Block[]): string {
  return blocks.flatMap(({ body }) => {
    if (body.kind === 'text') return [body.text];
    if (body.kind === 'formula') return [body.latex];
    if (body.kind === 'table') return body.rows.map(row => row.join(' ｜ '));
    return [];
  }).filter(Boolean).join('\n\n');
}

export function assetWorkspaceDisplay(value: unknown): AssetWorkspaceDisplay {
  const asset = parseAsset(value);
  if (asset.kind === 'question') {
    const prompt = questionPrompt(asset);
    const { answer, rubric } = questionSolutionFields(asset);
    const text = cleanDisplayText([
      prompt,
      answer ? `参考答案\n${answer}` : '',
      rubric ? `评分要点\n${rubric}` : '',
    ].filter(Boolean).join('\n\n'));
    return {
      title: asset.title, kind: 'question', text, excerpt: compactExcerpt(prompt || asset.title),
      question: { prompt, ...(answer ? { answer } : {}), ...(rubric ? { rubric } : {}) },
    };
  }
  if (asset.kind === 'discipline') {
    const ctx = asset.discipline_context;
    const parts = [
      ctx?.learningScope ? `学习范围：${ctx.learningScope}` : '',
      ctx?.mastery ? `掌握标准：${ctx.mastery}` : '',
      ctx?.assessment?.length ? `评估方式：${ctx.assessment.join('；')}` : '',
      ctx?.boundaries?.length ? `教学边界：${ctx.boundaries.join('；')}` : '',
      renderAssetBlocks(asset.blocks),
    ].filter(Boolean);
    const text = cleanDisplayText(parts.join('\n\n') || asset.title);
    return { title: asset.title, kind: 'discipline', text, excerpt: compactExcerpt(text), ...(asset.tags ? { tags: asset.tags } : {}) };
  }
  if (asset.kind === 'concept' || asset.kind === 'method' || asset.kind === 'archetype') {
    const body = renderAssetBlocks(asset.blocks);
    const aliases = asset.aliases.length ? `别名：${asset.aliases.join('、')}` : '';
    const text = cleanDisplayText([body, aliases].filter(Boolean).join('\n\n') || asset.title);
    return { title: asset.title, kind: asset.kind, text, excerpt: compactExcerpt(body || text), ...(asset.tags ? { tags: asset.tags } : {}) };
  }
  const body = cleanDisplayText(renderAssetBlocks(asset.blocks) || asset.title);
  return {
    title: asset.title, ...(asset.kind === 'textbook' ? { kind: 'page' } : {}),
    text: body, excerpt: compactExcerpt(body), ...(asset.tags ? { tags: asset.tags } : {}),
  };
}
