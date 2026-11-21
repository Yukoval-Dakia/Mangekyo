import { FactNotFoundError, type CommandContext, type FactId, type FactWrite } from '@mangekyo/kernel';
import {
  assetBodyReference, assetType, checkTextbookBasis, mergeTextbookBasis, parseAssetBlocks, parseTextbookBasis,
  checkQuestionTeachingSources, freezeQuestionAssessment, questionAsset, requireTextbookBodyBasis, verifyAssetBlockReference, type Block, type QuestionAsset,
} from './asset.ts';
import { fields, pageId, record, revision, text } from './parse.ts';
import { parseSaveQuestion } from './question-authoring.ts';
import { questionMetaDraftId, questionMetaDraftType, questionStateId, questionStateType, readQuestionState } from './question-state.ts';
import { arithmeticPractice, arithmeticQuestion, arithmeticQuestionId, openArithmeticPractice } from './arithmetic-practice.ts';

export const saveQuestionCommand = 'content.saveQuestion';
export const correctQuestionCommand = 'content.correctQuestion';
export const undoQuestionCommand = 'content.undoQuestionWrite';
export const proposeQuestionMetaCommand = 'content.proposeQuestionMeta';

const patchFields = ['title', 'prompt', 'response_schema', 'assessment_contract', 'interaction', 'sources', 'shared_materials'] as const;

export function parseQuestionWrite(input: unknown) {
  const value = record(input);
  const id = pageId(value.id);
  if (value.arithmeticPractice !== undefined) {
    fields(value, 'id', 'arithmeticPractice');
    const practice = arithmeticPractice(value.arithmeticPractice);
    return {id, asset: arithmeticQuestion(practice).asset, teaching: true, arithmeticPractice: practice};
  }
  if (value.expectedRev === undefined) {
    fields(value, 'id', 'asset', 'purpose');
    if (value.purpose !== undefined && value.purpose !== 'storage' && value.purpose !== 'teaching') {
      throw new Error('题目用途无效。');
    }
    return { id, asset: questionAsset(value.asset), teaching: value.purpose === 'teaching' };
  }
  fields(value, 'id', 'expectedRev', 'patch', 'basis');
  const patch = record(value.patch);
  fields(patch, ...patchFields);
  if (!Object.keys(patch).length) throw new Error('题目修改需要局部差异。');
  return { id, expectedRev: revision(value.expectedRev), patch, basis: parseTextbookBasis(value.basis ?? []) };
}

function patchAsset(asset: QuestionAsset, { patch, basis }: Extract<ReturnType<typeof parseQuestionWrite>, { expectedRev: number }>) {
  const { prompt, sources, shared_materials, interaction, ...contract } = patch;
  const original = asset.blocks.find(block => block.id === asset.promptBlockId)!;
  let blocks = [...asset.blocks];
  if (prompt !== undefined) {
    const edit = record(prompt);
    fields(edit, 'block_id', 'anchor', 'replacement');
    if (edit.block_id !== original.id || original.body.kind !== 'text') throw new Error('题干块与固定题版不符。');
    const anchor = text(edit.anchor, '题干锚点');
    const start = original.body.text.indexOf(anchor);
    if (start < 0 || start !== original.body.text.lastIndexOf(anchor)) throw new Error('题干锚点须恰好匹配一次。');
    const replacement = text(edit.replacement, '题干替换文字', true);
    const revised: Block = { ...original, body: { kind: 'text',
      text: original.body.text.slice(0, start) + replacement + original.body.text.slice(start + anchor.length) } };
    blocks = blocks.map(block => block === original ? revised : block);
  }
  for (const [input, kind] of [[sources, 'reference'], [shared_materials, 'sharedMaterial'], [interaction, 'interaction']] as const) {
    if (input === undefined) continue;
    const edits = parseAssetBlocks(input);
    if (edits.some(block => block.body.kind !== kind || block.parentId !== null)) throw new Error('替换块类型不匹配。');
    blocks = [...blocks.filter(block => block.body.kind !== kind), ...edits];
  }
  return questionAsset({ ...asset, ...contract, blocks, basis: mergeTextbookBasis(asset.basis, basis) });
}

async function verifyQuestion(ctx: CommandContext, id: FactId, rev: ReturnType<typeof revision>, asset: QuestionAsset) {
  if (asset.response_schema !== undefined && asset.assessment_contract !== undefined) {
    freezeQuestionAssessment(asset, { id, rev });
  }
  const basis = asset.basis ?? [];
  if (basis.some(use => use.id === id) || asset.blocks.some(block => assetBodyReference(block.body)?.fact.id === id))
    throw new Error('题目不能引用自身。');
  await checkTextbookBasis(ctx.read, basis);
  for (const block of asset.blocks) {
    requireTextbookBodyBasis(block.body, basis);
    await verifyAssetBlockReference(ctx, block.body);
  }
}

async function newQuestionMeta(ctx: CommandContext, id: FactId, rev: ReturnType<typeof revision>, purpose: readonly string[]): Promise<FactWrite> {
  return { kind: 'create', id: await questionMetaDraftId({ learner: ctx.learner, id, rev }),
    factType: questionMetaDraftType, purpose, data: { id, expectedRev: rev, append_metadata: null, basis: [], sticky: false },
  };
}

export async function writeQuestion(ctx: CommandContext, input: ReturnType<typeof parseQuestionWrite>, kind: 'correct' | 'revise'):
  Promise<readonly FactWrite[]> {
  const { id } = input;
  if ('expectedRev' in input) {
    const current = await ctx.read.fact(id, { mode: 'following' });
    if (current.ref.rev !== input.expectedRev) throw new Error(`Fact revision conflict: ${id}`);
    if (current.type !== assetType) throw new Error('请选择题目资产。');
    const old = questionAsset(current.value);
    if ((await readQuestionState(ctx.read,id)).state.arithmeticPractice)
      throw new Error('封闭练习题版固定，请新建更正后的练习题。');
    await checkTextbookBasis(ctx.read, old.basis ?? []);
    const next = patchAsset(old, input);
    await verifyQuestion(ctx, id, revision(input.expectedRev + 1), next);
    if (current.purpose.includes('teaching') || current.purpose.includes('all')) await checkQuestionTeachingSources(ctx.read, next);
    const meta = await newQuestionMeta(ctx, id, revision(input.expectedRev + 1), current.purpose);
    return [{ kind, id, expectedRev: input.expectedRev, data: next }, meta];
  }
  if (kind === 'correct') throw new Error('本人更正需要固定基版本。');
  const practice = 'arithmeticPractice' in input ? input.arithmeticPractice : undefined;
  if (practice) {
    if (id !== await arithmeticQuestionId(practice)) throw new Error('整数练习来源与题目定义不匹配。');
    const current = await ctx.read.fact(id,{mode:'following'}).catch(error => {
      if (!(error instanceof FactNotFoundError)) throw error;
    });
    if (current) {
      if (!await openArithmeticPractice(ctx.read,id,current)) throw new Error('当前版本不可用于整数练习。');
      return [];
    }
  }
  await verifyQuestion(ctx, id, revision(1), input.asset);
  if (input.teaching) await checkQuestionTeachingSources(ctx.read, input.asset);
  const purpose = input.teaching ? ['storage', 'teaching'] : ['storage'];
  return [
    { kind: 'create', id, factType: assetType, data: input.asset, purpose },
    { kind: 'create', id: await questionStateId(id), factType: questionStateType, purpose,
      data: { questionId: id, restrictions: [], last: null, recheck: 0,
        ...(practice ? {arithmeticPractice:practice} : {}) } },
    await newQuestionMeta(ctx, id, revision(1), purpose),
  ];
}

export function parseQuestionUndo(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'priorRev');
  return { id: pageId(value.id), expectedRev: revision(value.expectedRev),
    priorRev: value.priorRev === null ? null : revision(value.priorRev) };
}

export async function undoQuestion(ctx: CommandContext, { id, expectedRev, priorRev }: ReturnType<typeof parseQuestionUndo>):
  Promise<readonly FactWrite[]> {
  const current = await ctx.read.fact(id, { mode: 'following' });
  if (current.ref.rev !== expectedRev) throw new Error(`Fact revision conflict: ${id}`);
  if (current.type !== assetType) throw new Error('请选择题目资产。');
  questionAsset(current.value);
  if (expectedRev === 1 && priorRev === null) {
    const { snapshot, state } = await readQuestionState(ctx.read, id);
    const last = { action: 'withdraw', scope: 'all', reason: '学习者撤回题目。' } as const;
    return [{ kind: 'correct', id: snapshot.ref.id, expectedRev: snapshot.ref.rev,
      data: { ...state, last, restrictions: [last, ...state.restrictions.filter(entry => entry.scope !== 'all')] },
    }];
  }
  if (priorRev !== expectedRev - 1) throw new Error('撤回凭据与题版不符。');
  const previous = await ctx.read.fact(id, { mode: 'pinned', rev: priorRev });
  const asset = questionAsset(previous.value);
  await verifyQuestion(ctx, id, revision(expectedRev + 1), asset);
  if (current.purpose.includes('teaching') || current.purpose.includes('all')) await checkQuestionTeachingSources(ctx.read, asset);
  return [{ kind: 'correct', id, expectedRev, data: asset },
    await newQuestionMeta(ctx, id, revision(expectedRev + 1), current.purpose)];
}

export function parseQuestionMetaProposal(input: unknown) {
  const value = record(input);
  fields(value, 'id', 'expectedRev', 'append_metadata', 'basis');
  const id = pageId(value.id), expectedRev = revision(value.expectedRev);
  const parsed = parseSaveQuestion({ ref: id, expected_rev: expectedRev, append_metadata: value.append_metadata });
  if (!parsed.append_metadata) throw new Error('题目元信息提议为空。');
  return { id, expectedRev, append_metadata: parsed.append_metadata, basis: parseTextbookBasis(value.basis) };
}
