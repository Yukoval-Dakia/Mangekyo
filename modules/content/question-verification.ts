import {
  type EffectRequest, type FactId, type GatherContext, type GatherInput,
  type Json, type JsonObject, type Outcome, type Revision,
} from '@mangekyo/kernel';
import {
  assetType, checkQuestionTeachingSources, freezeQuestionAssessment, parseAsset, questionAsset, questionPrompt,
  type AssetReadContext, type AssetReference, type Block, type BlockBody, type QuestionAsset,
} from './asset.ts';
import { pageId, record, revision } from './parse.ts';
import type { AnswerSlot } from './assessment-values.ts';
import { publicAnswerControls } from './question-controls.ts';
import { jsonObject, readQuestionVerificationEffect, sameEffectInput, verificationSteps, type QuestionEffectReceipt, type SealedQuestionEffects } from './question-effects.ts';
import {
  evaluateQuestionVerification, questionVerificationMethodVersion, questionVerificationReview,
  type QuestionVerification, type QuestionVerificationBasis, type VerificationReceipt,
} from './question-state.ts';

export { openQuestionForRelease, questionVerificationKey, questionVerificationMethodVersion, questionVerificationType } from './question-state.ts';
export type { QuestionVerification, QuestionVerificationBasis } from './question-state.ts';
export { questionVerificationEffectResult } from './question-effects.ts';
export type { QuestionEffectReceipt as QuestionVerificationEffectReceipt } from './question-effects.ts';

type QuestionVerificationPlanData = QuestionVerificationBasis & { readonly blockedReason?: string };

type QuestionVerificationKey = { readonly id: FactId; readonly rev: Revision; readonly recheck?: number };
export async function gather(
  ctx: GatherContext, { id, rev, recheck = 0 }: QuestionVerificationKey,
): Promise<GatherInput<QuestionVerificationPlanData>> {
  const question = await ctx.read.fact(id, { mode: 'following' });
  if (question.type !== assetType || question.ref.rev !== rev) throw new Error('只核验当前题版。');
  const asset = questionAsset(question.value);
  if (!question.purpose.includes('teaching') && !question.purpose.includes('all')) throw new Error('题目未授权教学用途。');
  await checkQuestionTeachingSources(ctx.read, asset);
  if (!Number.isSafeInteger(recheck) || recheck < 0) throw new Error('复验代次无效。');
  const data = { id, rev, accessEpoch: question.accessEpoch, recheck, methodVersion: questionVerificationMethodVersion };
  const blocked = (reason: string): GatherInput<QuestionVerificationPlanData> => ({
    kind: 'input', data: { ...data, blockedReason: reason }, effects: [],
  });
  if (!asset.response_schema || !asset.assessment_contract) return blocked('题目缺少完整作答与评分契约。');

  const contract = freezeQuestionAssessment(asset, { id, rev });
  const slots = contract.items[0]!.slots;
  const projection = await projectQuestionPrompt(ctx.read, asset, slots);
  if (projection.kind === 'blocked') return blocked(projection.reason);
  // These inputs remain local until the host reapplies purpose, recipient and
  // spoiler checks to the current witnesses before dispatch or ledger replay.
  const publicInput = { ...projection.content, response_schema: slots, ref: { id, rev }, verification: data };
  const effects: EffectRequest[] = verificationSteps.map(step => ({
    ...step, input: step.stepKey === 'contract' ? { ...publicInput, contract } : publicInput,
  }));
  return { kind: 'input', data, effects };
}

export async function projectQuestionPrompt(read: AssetReadContext['read'], asset: QuestionAsset, slots?: readonly AnswerSlot[]) {
  const controls = [];
  for (const { body } of asset.blocks) {
    if (body.kind !== 'interaction') continue;
    const projection = slots && publicAnswerControls(body.view, questionPrompt(asset), slots);
    if (!projection || controls.length) return { kind: 'blocked', reason: '交互块无法投影为明确的公开作答选项。' } as const;
    controls.push(projection);
  }
  if (asset.blocks.some(block => block.body.kind !== 'interaction' && needsUnsupportedProjection(block.body))) {
    return { kind: 'blocked', reason: '题目含未能安全投影的交互、图像或嵌套题。' } as const;
  }
  const sharedMaterials = [];
  for (const block of asset.blocks) {
    if (block.body.kind !== 'sharedMaterial') continue;
    const material = await projectSharedMaterial(read, asset, block);
    if (!material) return { kind: 'blocked', reason: '题目有未能安全投影的必需共享材料。' } as const;
    sharedMaterials.push(material);
  }
  return { kind: 'ready', content: { prompt: questionPrompt(asset), sharedMaterials, controls } } as const;
}

function needsUnsupportedProjection(body: BlockBody) {
  return body.kind === 'image' || body.kind === 'interaction' || (body.kind === 'reference' && body.role === 'question');
}

function isPublicCaptureLayer(body: JsonObject) {
  return body.kind === 'capture' && (body.layer === 'material' || body.layer === 'prompt');
}

function captureMaterial(value: Json, anchor: AssetReference['anchor']) {
  if (!jsonObject(value) || !jsonObject(value.unit) || !Array.isArray(value.unit.blocks) || anchor.kind === 'path') {
    return undefined;
  }
  const byId = new Map<string, JsonObject>();
  for (const block of value.unit.blocks) {
    if (!jsonObject(block) || typeof block.id !== 'string' || byId.has(block.id)) return undefined;
    byId.set(block.id, block);
  }
  const selected = anchor.kind === 'block' ? [byId.get(anchor.blockId)]
    : [...byId.values()].filter(block => jsonObject(block.body) && block.body.layer === 'material');
  const result = [];
  for (const block of selected) {
    if (!block || typeof block.id !== 'string' || !jsonObject(block.body) || !isPublicCaptureLayer(block.body) ||
        block.body.status !== 'known' || typeof block.body.text !== 'string' || !block.body.text.trim()) return undefined;
    const seen = new Set([block.id]);
    let parentId = block.parentId;
    while (parentId !== null) {
      if (typeof parentId !== 'string' || seen.has(parentId)) return undefined;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || !jsonObject(parent.body) || !isPublicCaptureLayer(parent.body) || parent.body.status !== 'known') return undefined;
      parentId = parent.parentId;
    }
    result.push({ blockId: block.id, text: block.body.text });
  }
  return result.length ? result : undefined;
}

async function projectSharedMaterial(read: AssetReadContext['read'], question: QuestionAsset, block: Block) {
  if (block.body.kind !== 'sharedMaterial') return undefined;
  const { source: { fact: ref, type, anchor } } = block.body;
  const basis = question.basis?.find(entry => entry.id === ref.id && entry.rev === ref.rev && entry.type === type);
  if (!basis || anchor.kind === 'path') return undefined;
  const fact = await read.fact(ref.id, { mode: 'pinned', rev: ref.rev });
  if (fact.ref.learner !== ref.learner || fact.ref.id !== ref.id || fact.ref.rev !== ref.rev ||
      fact.type !== type || fact.accessEpoch !== basis.epoch) return undefined;
  let pieces;
  if (fact.type === 'capture.source') {
    pieces = captureMaterial(fact.value, anchor);
  } else if (fact.type === assetType) {
    const material = parseAsset(fact.value);
    if (material.kind !== 'question' || (anchor.kind === 'block' && anchor.blockId !== material.promptBlockId) ||
        material.blocks.some(({ body }) => body.kind === 'sharedMaterial' || needsUnsupportedProjection(body))) return undefined;
    await checkQuestionTeachingSources(read, material);
    pieces = [{ blockId: material.promptBlockId, text: questionPrompt(material) }];
  }
  if (!pieces) return undefined;
  return { blockId: block.id, source: { id: ref.id, rev: ref.rev, type, accessEpoch: basis.epoch }, pieces };
}

function readBasis(input: Json): QuestionVerificationBasis {
  const value = record(input);
  const { accessEpoch, recheck, methodVersion } = value;
  if (typeof accessEpoch !== 'string' || typeof recheck !== 'number' ||
      !Number.isSafeInteger(recheck) || recheck < 0 || typeof methodVersion !== 'string') {
    throw new Error('封存计划的题版或复验依据无效。');
  }
  return { id: pageId(value.id), rev: revision(value.rev), accessEpoch, recheck, methodVersion };
}

/** Match ledger receipts to the exact sealed requests before applying the consensus rules. */
export function settle(
  sealed: SealedQuestionEffects, receipts: readonly QuestionEffectReceipt[],
): Outcome<QuestionVerification> {
  const basis = readBasis(sealed.plan.data);
  const review = (reason: string) => ({ kind: 'value' as const, value: questionVerificationReview(basis, reason) });
  if (basis.methodVersion !== questionVerificationMethodVersion || sealed.plan.effects.length !== verificationSteps.length) {
    const reason = jsonObject(sealed.plan.data) ? sealed.plan.data.blockedReason : undefined;
    return review(typeof reason === 'string' ? reason : '封存计划缺少当前方法的完整验题请求。');
  }
  if (receipts.length !== verificationSteps.length) return review('验题效果回执缺失或重复。');

  const checks: VerificationReceipt[] = [];
  for (const step of verificationSteps) {
    const request = sealed.plan.effects.find(effect => effect.stepKey === step.stepKey);
    if (!request || request.label !== step.label || !jsonObject(request.input) ||
        !request.input.verification || !sameEffectInput(request.input.verification, basis)) {
      return review('封存请求与题版或复验代次不一致。');
    }
    const receipt = receipts.find(entry => entry.request.stepKey === step.stepKey);
    const checked = readQuestionVerificationEffect(sealed.id, request, receipt);
    if (checked.kind !== 'done') return review(checked.reason);
    checks.push({ invocationId: checked.invocationId, result: checked.result, execution: checked.execution });
  }
  return { kind: 'value', value: evaluateQuestionVerification(basis, checks) };
}
