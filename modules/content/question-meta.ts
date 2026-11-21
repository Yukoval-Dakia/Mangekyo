import { type FactId, type FactSnapshot, type GatherContext, type GatherInput, type Json, type JsonObject, type Revision } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, freezeQuestionAssessment, questionAsset, type AssetBasis } from './asset.ts';
import { record } from './parse.ts';
import { parseQuestionMetadata } from './question-authoring.ts';
import { jsonObject, readQuestionEffect, sameEffectInput, type QuestionEffectReceipt, type SealedQuestionEffects } from './question-effects.ts';
import {
  openQuestionMetaDraft, parseQuestionMetaDraft, questionSolutionKey, questionTagKey, type QuestionMetaDraft,
} from './question-state.ts';
import { projectQuestionPrompt } from './question-verification.ts';

export { openQuestionMetaDraft, questionKey, questionMetaType } from './question-state.ts';
export { readQuestionHintLevel, type QuestionHintAccess, type QuestionHintInput } from './question-meta-hints.ts';
export { questionEffectResult as questionMetaEffectResult } from './question-effects.ts';
export type { QuestionEffectReceipt as QuestionMetaEffectReceipt } from './question-effects.ts';

export const questionMetaMethodVersion = '3';
export const questionMetaDeriver = 'content/question-meta';
const gardeningStep = { stepKey: 'garden', label: 'question-meta-gardening' } as const;

type BoundSource = { readonly ref: string; readonly basis: AssetBasis };
type GardeningPlan = {
  readonly methodVersion: string;
  readonly question: AssetBasis;
  readonly metadata: AssetBasis;
  readonly sources: readonly BoundSource[];
};
type PlanData = { readonly draft: QuestionMetaDraft; readonly gardening?: GardeningPlan; readonly reason?: string };
type GardeningStatus =
  | { readonly status: 'skipped' | 'needs-review'; readonly reason: string }
  | { readonly status: 'suggestions'; readonly invocationId: string };

function witness({ ref, type, accessEpoch }: FactSnapshot): AssetBasis {
  return { id: ref.id, rev: ref.rev, type, epoch: accessEpoch };
}
function source(basis: AssetBasis, blockId: string): BoundSource {
  const { id, rev, type } = basis;
  const ref = JSON.stringify({ v: 1, fact: { id, rev, type }, anchor: { kind: 'block', blockId } });
  return { ref, basis };
}

export async function gather(ctx: GatherContext, { id, rev }: { id: FactId; rev: Revision }): Promise<GatherInput<PlanData>> {
  const question = await ctx.read.fact(id, { mode: 'pinned', rev });
  if (question.type !== assetType) throw new Error('目标不是题目资产。');
  const asset = questionAsset(question.value);
  const { snapshot: metadata, draft } = await openQuestionMetaDraft(ctx.read, question.ref);

  const skip = (reason: string): GatherInput<PlanData> => ({ kind: 'input', data: { draft, reason }, effects: [] });
  const current = await ctx.read.fact(id, { mode: 'following' });
  if (![question, current].every(fact => fact.purpose.includes('teaching') || fact.purpose.includes('all'))) {
    return skip('题目尚无有效的教学用途授权。');
  }
  await checkQuestionTeachingSources(ctx.read, asset);
  const slots = asset.blocks.some(({body}) => body.kind === 'interaction') && asset.response_schema && asset.assessment_contract
    ? freezeQuestionAssessment(asset, question.ref).items[0]?.slots : undefined;
  const projected = await projectQuestionPrompt(ctx.read, asset, slots);
  if (projected.kind === 'blocked') return skip(projected.reason);

  const questionBasis = witness(question);
  const sources = [source(questionBasis, asset.promptBlockId)];
  for (const material of projected.content.sharedMaterials) {
    const { id, rev, type, accessEpoch } = material.source;
    for (const piece of material.pieces) sources.push(source({ id, rev, type, epoch: accessEpoch }, piece.blockId));
  }
  const gardening = {
    methodVersion: questionMetaMethodVersion, question: questionBasis, metadata: witness(metadata),
    sources: [...new Map(sources.map(entry => [entry.ref, entry])).values()],
  };
  // The ledger and worker use the frozen binding locally. The host authorizes
  // the actual recipient before dispatch or replay and projects only these problem materials.
  return { kind: 'input', data: { draft, gardening }, effects: [{
    ...gardeningStep, input: { ...projected.content, gardening },
  }] };
}

type ConfirmedMetadata = NonNullable<QuestionMetaDraft['append_metadata']>;
type Suggested<Value> = Value & { readonly verification: 'unverified'; readonly basis: readonly AssetBasis[] };
type SuggestedMetadata = {
  readonly tags: readonly Suggested<ConfirmedMetadata['tags'][number]>[];
  readonly solutions: readonly Suggested<ConfirmedMetadata['solutions'][number]>[];
  readonly hint_ladder?: Suggested<NonNullable<ConfirmedMetadata['hint_ladder']>>;
};

function merge<Field extends JsonObject>(approved: readonly Field[], suggested: readonly Suggested<Field>[], key: (value: Field) => string) {
  const approvedByKey = new Map(approved.map(value => [key(value), value]));
  const additions = [];
  const proposals = [];
  for (const suggestion of suggested) {
    const previous = approvedByKey.get(key(suggestion));
    if (previous === undefined) additions.push(suggestion);
    else {
      const { basis: _, verification: __, ...payload } = suggestion;
      if (!sameEffectInput(previous, payload)) proposals.push(suggestion);
    }
  }
  return { additions, proposals };
}

export function projectQuestionMeta(
  draft: QuestionMetaDraft, gardening: GardeningStatus, suggested: SuggestedMetadata = { tags: [], solutions: [] },
) {
  const confirmed = draft.append_metadata ?? { tags: [], solutions: [] };
  const tags = merge(confirmed.tags, suggested.tags, questionTagKey);
  const solutions = merge(confirmed.solutions, suggested.solutions, questionSolutionKey);
  const verification = draft.sticky ? 'learner-reviewed' : 'unverified';
  const ladder = draft.append_metadata?.hint_ladder;
  return { kind: 'value' as const, value: {
    sticky: draft.sticky, basis: draft.basis, gardening,
    tags: [...confirmed.tags.map(tag => ({ ...tag, verification })), ...tags.additions],
    solutions: [...confirmed.solutions.map(solution => ({ ...solution, verification })), ...solutions.additions],
    ...(ladder && draft.sticky ? { hint_ladder: { ...ladder, verification } } : {}),
    proposals: { tags: tags.proposals, solutions: solutions.proposals,
      ...(suggested.hint_ladder ? { hint_ladder: suggested.hint_ladder } : {}) },
  } };
}

function suggestions(result: Json, sources: readonly BoundSource[]): SuggestedMetadata {
  const metadata = parseQuestionMetadata(result, true);
  const sourceByRef = new Map(sources.map(entry => [entry.ref, entry.basis]));
  function annotate<Entry extends { readonly source_ref?: string }>(items: readonly Entry[], key: (value: Entry) => string) {
    if (new Set(items.map(key)).size !== items.length) throw new Error('园艺候选重复。');
    return items.map(entry => {
      const evidence = entry.source_ref && sourceByRef.get(entry.source_ref);
      if (!evidence) throw new Error('园艺候选没有已打开的来源锚点。');
      return { ...entry, verification: 'unverified' as const, basis: [evidence] };
    });
  }
  const [ladder] = metadata.hint_ladder ? annotate([metadata.hint_ladder], item => item.source_ref) : [];
  return { tags: annotate(metadata.tags, questionTagKey), solutions: annotate(metadata.solutions, questionSolutionKey),
    ...(ladder ? { hint_ladder: ladder } : {}) };
}

/** Apply only suggestions from a ledger receipt bound to the current sealed metadata plan. */
export function settle(sealed: SealedQuestionEffects, receipts: readonly QuestionEffectReceipt[]) {
  const input = record(sealed.plan.data);
  const draft = parseQuestionMetaDraft(input.draft);
  const review = (reason: string) => projectQuestionMeta(draft, { status: 'needs-review', reason });
  if (!input.gardening && sealed.plan.effects.length === 0 && receipts.length === 0) {
    return projectQuestionMeta(draft, { status: 'skipped', reason: typeof input.reason === 'string' ? input.reason : '本次没有园艺请求。' });
  }
  const planData = sealed.plan.data;
  const binding = jsonObject(planData) ? planData.gardening : undefined;
  const request = sealed.plan.effects[0];
  if (sealed.plan.effects.length !== 1 || !request || request.stepKey !== gardeningStep.stepKey ||
      request.label !== gardeningStep.label || !jsonObject(binding) || binding.methodVersion !== questionMetaMethodVersion ||
      !jsonObject(binding.question) || binding.question.id !== draft.id || binding.question.rev !== draft.expectedRev ||
      !jsonObject(request.input) || !request.input.gardening || !sameEffectInput(request.input.gardening, binding)) {
    return review('封存园艺请求与当前方法或题版不符。');
  }
  if (receipts.length !== 1) return review('园艺效果回执缺失或重复。');
  const checked = readQuestionEffect(sealed.id, request, receipts[0]);
  if (checked.kind !== 'done') return review(checked.reason);
  try {
    // This index is frozen by gather and checked against the identical sealed request.
    const proposed = suggestions(checked.result, (binding as GardeningPlan).sources);
    return projectQuestionMeta(draft, { status: 'suggestions', invocationId: checked.invocationId }, proposed);
  } catch {
    return review('园艺结果的标签、解法或来源无效。');
  }
}
