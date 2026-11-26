import type { FactId, JsonObject, Revision, Tick } from '@mangekyo/kernel';
import { contentStableId } from './knowledge-entity.ts';
import { parseEdgeWrite, type KnowledgeEndpointKind, type KnowledgeSourceUse } from './knowledge-edge.ts';
import { parseTextbookBasis, parseTextbookPage, type TextbookBasis, type TextbookBlock } from './textbook-page.ts';
import { applyTextbookEdit, parseTextbookRevision, type TextbookRevision } from './textbook-edits.ts';

export class TextbookAuthoringNotFoundError extends Error {
  readonly code = 'no_sufficient_basis' as const;
  readonly status = 404 as const;
}

export class TextbookAuthoringValidationError extends Error {
  readonly code = 'invalid_draft' as const;
  readonly status = 400 as const;
}

export type AuthoringWitnessInput = {
  readonly id: string;
  readonly rev?: number;
  readonly accessEpoch?: string;
  readonly epoch?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly title?: string;
};

export type TextbookAuthoringContextInput = {
  readonly hasSufficientBasis?: boolean;
  readonly hasBasis?: boolean;
  readonly emptyReason?: string;
  readonly topic?: string;
  readonly concept?: AuthoringWitnessInput & { readonly title: string; readonly summary?: string | null };
  readonly conceptId?: string;
  readonly conceptTitle?: string;
  readonly sourceSnippets?: readonly AuthoringWitnessInput[];
  readonly snippets?: readonly AuthoringWitnessInput[];
  readonly witnesses?: readonly AuthoringWitnessInput[];
  readonly witnessFactIds?: readonly string[];
};

export type AuthoredTextbookSection = {
  readonly heading: string;
  readonly kind: 'overview' | 'explanation' | 'formula' | 'pitfall' | 'example' | 'checklist' | 'summary';
  readonly body: string;
  readonly latex?: string;
  readonly bullets?: readonly string[];
  readonly table?: readonly (readonly string[])[];
  readonly sourceIds?: readonly string[];
};

export type AuthoredTextbookDraftInput = {
  readonly mode: 'full' | 'cheatsheet';
  readonly title: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sections?: readonly AuthoredTextbookSection[];
  readonly blocks?: readonly TextbookBlock[];
};

export type CompanionTextbookRevisionInput = {
  readonly dedupKey?: string;
  readonly changeSummary?: string;
  readonly rationale: string;
  readonly suggestedAddition?: string;
  readonly proposedAddition?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly basis?: readonly AuthoringWitnessInput[];
};

type NormalizedWitness = AuthoringWitnessInput & { readonly rev: number; readonly epoch: string; readonly type: string };
type TextbookCommand = { readonly key: string; readonly type: 'content.createTextbookPage' | 'content.createKnowledgeEdge'; readonly input: JsonObject };

function invalid(message: string, cause?: unknown): never {
  throw new TextbookAuthoringValidationError(message, { cause });
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function clean(value: unknown, field: string, limit = 8000, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) invalid(`${field}无效。`);
  const result = value.trim();
  if (!result || result.length > limit) invalid(`${field}须为 1–${limit} 字。`);
  return result;
}

function cleanList(value: readonly string[] | undefined, field: string, limit: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) invalid(`${field}最多 ${limit} 项。`);
  return [...new Set(value.map(item => clean(item, field, 8000)!))];
}

export function normalizeAuthoringWitness(input: AuthoringWitnessInput): NormalizedWitness | undefined {
  const epoch = input.accessEpoch ?? input.epoch ?? '0';
  const rev = input.rev ?? 1;
  if (!validId(input.id) || typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1 || rev > 2_147_483_647 ||
      typeof epoch !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(epoch) || BigInt(epoch) > 9223372036854775807n ||
      typeof input.type !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.type)) return undefined;
  return { ...input, rev, epoch, type: input.type };
}

export function authoringWitnessType(input: Pick<AuthoringWitnessInput, 'type' | 'kind'>): string | undefined {
  if (input.type) {
    const assetLike = input.type === 'content.asset' || input.type === 'activity.workspaceEntry';
    return assetLike && input.kind ? `${input.type}:${input.kind}` : input.type;
  }
  return ({ concept: 'content.asset:concept', question: 'content.asset:question', textbook: 'content.textbookPage',
    note: 'activity.organizerNote', notion: 'capture.source', material: 'capture.source',
    paper: 'activity.workbookAttempt', attempt: 'activity.workbookAttempt', misconception: 'companion.memoryAssertion',
    discussion: 'activity.studyTurn', work: 'activity.workbookAttempt', claim: 'companion.claim' } as Readonly<Record<string, string>>)[input.kind ?? ''];
}

export function authoringWitness(input: AuthoringWitnessInput): NormalizedWitness | undefined {
  const type = authoringWitnessType(input);
  return type === undefined ? undefined : normalizeAuthoringWitness({ ...input, type });
}

export function authoringWitnessWithType(input: AuthoringWitnessInput & { readonly type: string }): NormalizedWitness | undefined {
  return normalizeAuthoringWitness(input);
}

function collectWitnesses(context: TextbookAuthoringContextInput, extra: readonly AuthoringWitnessInput[] = []) {
  const values = new Map<string, NormalizedWitness>();
  const seenIds = new Set<string>();
  const collect = (item: AuthoringWitnessInput, type: string) => {
    if (item.rev === undefined && seenIds.has(item.id)) return;
    const witness = normalizeAuthoringWitness({ ...item, type });
    if (witness) values.set(`${witness.id}:${witness.rev}`, values.get(`${witness.id}:${witness.rev}`) ?? witness);
    if (witness) seenIds.add(witness.id);
  };
  for (const item of [...(context.witnesses ?? []), ...(context.sourceSnippets ?? []), ...(context.snippets ?? []), ...extra]) {
    const type = authoringWitnessType(item);
    if (type !== undefined) collect(item, type);
  }
  if (context.concept) collect(context.concept, authoringWitnessType(context.concept) ?? 'content.asset:concept');
  return [...values.values()];
}

function useOf(witness: NormalizedWitness): KnowledgeSourceUse {
  return { id: witness.id as FactId, rev: witness.rev as Revision, accessEpoch: witness.epoch as Tick };
}

export function authoringSourceUse(witness: NormalizedWitness): KnowledgeSourceUse { return useOf(witness); }

export function authoringEndpointKind(witness: NormalizedWitness): KnowledgeEndpointKind | undefined {
  if (witness.type === 'capture.source' && witness.kind === 'notion') return 'note';
  const [type, assetKind] = witness.type.split(':');
  if (assetKind) return assetKind === 'textbook' ? 'chapter' : assetKind === 'capture' || assetKind === 'discipline' ? 'source' : assetKind === 'page' ? 'note' : assetKind as KnowledgeEndpointKind;
  return ({ 'content.textbookPage': 'chapter', 'capture.source': 'source', 'activity.intakeDocument': 'source',
    'activity.organizerNote': 'note', 'activity.workbookAttempt': 'work', 'activity.retentionPosttestSubmission': 'work',
    'activity.recallSubmission': 'work', 'activity.studyRecord': 'work', 'companion.claim': 'claim',
    'companion.memoryAssertion': 'claim', 'content.asset': 'question' } as Readonly<Record<string, KnowledgeEndpointKind>>)[type!];
}

function tableRows(rows: readonly (readonly string[])[]) {
  const width = Math.max(0, ...rows.map(row => row.length));
  if (!width) invalid('表格至少需要一个单元格。');
  return rows.map(row => [...row.map(cell => cell.trim()), ...Array.from({ length: width - row.length }, () => '')]);
}

function sectionBlocks(section: AuthoredTextbookSection, index: number) {
  const prefix = `section-${index + 1}`;
  const kinds = ['overview', 'explanation', 'formula', 'pitfall', 'example', 'checklist', 'summary'];
  if (!kinds.includes(section.kind)) invalid(`第 ${index + 1} 节类型无效。`);
  const blocks: TextbookBlock[] = [
    { id: `${prefix}-heading`, parentId: null, body: { kind: 'text', text: clean(section.heading, '章节标题', 240)! } },
    { id: `${prefix}-body`, parentId: null, body: { kind: 'text', text: clean(section.body, '章节正文')! } },
  ];
  if (section.latex !== undefined) blocks.push({ id: `${prefix}-formula`, parentId: null, body: { kind: 'formula', latex: clean(section.latex, '公式', 4000)! } });
  const bullets = cleanList(section.bullets, '列表项', 64);
  if (bullets.length) {
    blocks.push({ id: `${prefix}-list`, parentId: null, body: { kind: 'list', order: 'bullet' } });
    bullets.forEach((text, item) => blocks.push({ id: `${prefix}-item-${item + 1}`, parentId: `${prefix}-list`, body: { kind: 'text', text: text! } }));
  }
  if (section.table !== undefined) {
    if (!Array.isArray(section.table) || section.table.length > 64 || section.table.some(row => !Array.isArray(row) || row.length > 32)) invalid('表格行列无效。');
    blocks.push({ id: `${prefix}-table`, parentId: null, body: { kind: 'table', rows: tableRows(section.table) } });
  }
  return blocks;
}

function boundedBlocks(blocks: readonly TextbookBlock[]) {
  const accepted = new Set<string>();
  return blocks.filter(block => {
    if (accepted.size >= 64 || (block.parentId !== null && !accepted.has(block.parentId))) return false;
    accepted.add(block.id);
    return true;
  });
}

async function edgeCommand(key: string, edgeId: FactId, edge: JsonObject, purpose: 'storage' | 'teaching'): Promise<TextbookCommand> {
  try {
    const parsed = parseEdgeWrite({ id: edgeId, purpose, edge });
    return { key, type: 'content.createKnowledgeEdge', input: parsed as unknown as JsonObject };
  } catch (error) { return invalid('知识边草稿无效。', error); }
}

export async function buildAuthoredTextbookCommands(input: {
  readonly requestId: string;
  readonly context: TextbookAuthoringContextInput;
  readonly draft: AuthoredTextbookDraftInput;
  readonly purpose?: 'storage' | 'teaching';
}) {
  const requestId = clean(input.requestId, 'requestId', 128)!;
  if (input.context.hasSufficientBasis === false || input.context.hasBasis === false) throw new TextbookAuthoringNotFoundError('没有足够的已授权依据。');
  const witnesses = collectWitnesses(input.context);
  if (!witnesses.length) throw new TextbookAuthoringNotFoundError('没有可用的来源或概念见证。');
  const { draft } = input;
  if (draft.mode !== 'full' && draft.mode !== 'cheatsheet') invalid('教材模式无效。');
  const purpose = input.purpose ?? 'teaching';
  if (purpose !== 'storage' && purpose !== 'teaching') invalid('教材用途无效。');
  const purposes = purpose === 'teaching' ? ['storage', 'teaching'] : ['storage'];
  if ((draft.sections === undefined) === (draft.blocks === undefined) && draft.summary === undefined) invalid('请提供教材正文或结构块。');
  if (draft.sections !== undefined && (!Array.isArray(draft.sections) || !draft.sections.length || draft.sections.length > 64)) invalid('教材章节须为 1–64 节。');
  let blocks: TextbookBlock[] = [];
  if (draft.blocks !== undefined) {
    if (!Array.isArray(draft.blocks)) invalid('教材块须为列表。');
    blocks = boundedBlocks(draft.blocks);
  } else {
    if (draft.summary?.trim()) blocks.push({ id: 'summary', parentId: null, body: { kind: 'text', text: clean(draft.summary, '摘要')! } });
    (draft.sections ?? []).forEach((section, index) => blocks.push(...sectionBlocks(section, index)));
    blocks = boundedBlocks(blocks);
  }
  const concept = witnesses.find(witness => authoringEndpointKind(witness) === 'concept' &&
    (input.context.concept?.id === witness.id || input.context.conceptId === witness.id));
  const conceptOrTopicKey = concept?.id ?? clean(input.context.conceptId ?? input.context.concept?.id ?? input.context.topic ?? input.context.conceptTitle ?? witnesses[0]!.id, '主题', 240)!;
  const pageId = await contentStableId('content.authoredTextbookPage', requestId, draft.mode, conceptOrTopicKey);
  const basis = parseTextbookBasis(witnesses.map(witness => ({ id: witness.id, rev: witness.rev, epoch: witness.epoch, type: witness.type.split(':')[0]! })));
  const tags = [...new Set([...cleanList(draft.tags, '标签', 24).map(tag => tag!.slice(0, 120)), draft.mode === 'cheatsheet' ? 'cheatsheet' : 'live-textbook', 'ai-authored'])].slice(0, 24);
  try {
    const page = parseTextbookPage({ title: clean(draft.title, '标题', 240), blocks, tags, basis });
    if (!page.blocks.length) invalid('教材至少需要一个有效块。');
    const commands: TextbookCommand[] = [{ key: 'page', type: 'content.createTextbookPage', input: { id: pageId, clientEditSeq: 0, purpose: purposes, page } }];
    const pageUse = { id: pageId, rev: 1 as Revision, accessEpoch: '0' as Tick };
    if (concept) commands.push(await edgeCommand('concept', await contentStableId('content.authoredTextbookEdge', pageId, 'explains', concept.id), {
      kind: 'explains', from: { kind: 'chapter', sourceUse: pageUse }, to: { kind: 'concept', sourceUse: useOf(concept) },
      sourceUses: [pageUse, useOf(concept)], scope: clean(draft.title, '标题', 240)!, }, purpose));
    const selected = new Set([...cleanList(draft.sourceIds, '来源引用', 128),
      ...(draft.sections ?? []).flatMap(section => cleanList(section.sourceIds, '章节来源引用', 128))]);
    const ordered = [...witnesses.filter(witness => selected.has(witness.id)), ...witnesses.filter(witness => !selected.has(witness.id))];
    let edgeIndex = 0;
    for (const witness of ordered) {
      const kind = authoringEndpointKind(witness);
      if (!kind || witness.id === concept?.id) continue;
      if (edgeIndex++ >= 8) break;
      commands.push(await edgeCommand(`source-${edgeIndex}`, await contentStableId('content.authoredTextbookEdge', pageId, 'derived_from', witness.id, String(witness.rev)), {
        kind: 'derived_from', from: { kind: 'chapter', sourceUse: pageUse }, to: { kind, sourceUse: useOf(witness) },
        sourceUses: [pageUse, useOf(witness)], scope: clean(draft.title, '标题', 240)!, }, purpose));
    }
    return { summary: { id: pageId, title: page.title, mode: draft.mode, blockCount: page.blocks.length, basisCount: basis.length }, commands };
  } catch (error) {
    if (error instanceof TextbookAuthoringValidationError) throw error;
    return invalid('教材草稿不符合事实契约。', error);
  }
}

export async function buildCompanionTextbookRevisionProposal(page: {
  readonly id: FactId;
  readonly rev: Revision;
  readonly blocks: readonly TextbookBlock[];
  readonly basis?: readonly TextbookBasis[];
  readonly retiredBlockIds?: readonly string[];
  readonly movedBlocks?: readonly { readonly blockId: string }[];
  readonly archived?: true;
}, update: CompanionTextbookRevisionInput) {
  const addition = clean(update.proposedAddition ?? update.suggestedAddition ?? [update.title, update.summary].filter(Boolean).join('\n\n'), '建议补充内容')!;
  const changeSummary = clean(update.changeSummary ?? update.title ?? update.summary ?? update.rationale, '修订摘要', 1000)!;
  const used = new Set([...page.blocks.map(block => block.id), ...(page.retiredBlockIds ?? []), ...(page.movedBlocks ?? []).map(move => move.blockId)]);
  let nonce = 0, blockId = '';
  do { blockId = `companion-${(await contentStableId('content.textbookProposalBlock', page.id, String(page.rev), update.dedupKey ?? changeSummary, addition, String(nonce++))).slice(-24).toLowerCase()}`; } while (used.has(blockId));
  const last = page.blocks.findLast(block => block.parentId === null);
  const edit = last ? { kind: 'insert_after' as const, blockId, afterId: last.id, body: { kind: 'text' as const, text: addition } }
    : { kind: 'insert' as const, blockId, parentId: null, beforeId: null, body: { kind: 'text' as const, text: addition } };
  const addedBasis = (update.basis ?? []).map(authoringWitness).filter((witness): witness is NormalizedWitness => witness !== undefined)
    .map(witness => ({ id: witness.id as FactId, rev: witness.rev as Revision, epoch: witness.epoch, type: witness.type.split(':')[0]! }));
  try {
    const revision = parseTextbookRevision({ id: page.id, expectedRev: page.rev, clientEditSeq: 0, edits: [edit], ...(addedBasis.length ? { basis: addedBasis } : {}) });
    applyTextbookEdit({ title: '', blocks: page.blocks, ...(page.basis === undefined ? {} : { basis: page.basis }),
      ...(page.archived === true ? { archived: true } : {}), ...(page.retiredBlockIds === undefined ? {} : { retiredBlockIds: page.retiredBlockIds }) }, revision.edits[0]!);
    return { key: update.dedupKey ?? `${page.id}:${page.rev}:${blockId}`, type: 'content.reviseTextbookPage' as const,
      actor: 'companion' as const, input: revision as TextbookRevision, blockId, changeSummary };
  } catch (error) { return invalid('教材修订提议无效。', error); }
}
