import type { FactId, FactSnapshot, ReadContext } from '@mangekyo/kernel';
import { assetType, freezeQuestionAssessment, questionAsset, questionPrompt } from './asset.ts';
import { fields, record } from './parse.ts';
import { readQuestionState } from './question-state.ts';
import { contentStableId } from './knowledge-entity.ts';

export const arithmeticPracticeV1 = 'sealed-arithmetic-practice-v1';

export function arithmeticPractice(input: unknown) {
  const row = record(input);
  fields(row, 'operation', 'left', 'right');
  const {operation, left, right} = row;
  if ((operation !== 'add' && operation !== 'subtract' && operation !== 'multiply') ||
      typeof left !== 'number' || !Number.isSafeInteger(left) || left < 1 || left > 999 ||
      typeof right !== 'number' || !Number.isSafeInteger(right) || right < 1 || right > 999)
    throw new Error('练习需要两个 1 至 999 的整数，以及加、减或乘。');
  if (operation !== 'subtract' && left > right) return {operation,left:right,right:left} as const;
  return {operation,left,right} as const;
}

export function arithmeticQuestionId({operation,left,right}: ReturnType<typeof arithmeticPractice>) {
  return contentStableId(arithmeticPracticeV1,operation,String(left),String(right));
}

export function arithmeticQuestion(practice: ReturnType<typeof arithmeticPractice>) {
  const {operation, left, right} = practice;
  const [symbol, expected] = operation === 'add' ? ['+', left + right] as const
    : operation === 'subtract' ? ['−', left - right] as const : ['×', left * right] as const;
  const prompt = `计算 ${left} ${symbol} ${right}。`;
  const asset = questionAsset({
    kind: 'question', title: '整数运算', promptBlockId: 'question',
    blocks: [{id:'question',parentId:null,body:{kind:'text',text:prompt}}],
    response_schema: [{slotId:'answer',schemaVersion:'1',fields:[{path:'',kind:'numeric'}]}],
    assessment_contract: [{criterionId:'result',inputs:[{slotId:'answer',path:''}],
      evaluator:{id:'exact-integer',version:'1'},parameters:{expected},maximum:1,missingEvidence:'insufficient-evidence'}],
  });
  return {asset, expected, prompt};
}

/** The dedicated practice release admits only the deterministic source born under this policy. */
export async function openArithmeticPractice(read: {fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot>},
  id: FactId, question?: FactSnapshot, use: 'storage' | 'teaching' = 'teaching') {
  const source = question ?? await read.fact(id,{mode:'following'});
  if (source.type !== assetType || source.ref.id !== id || !source.purpose.some(granted => granted === use || granted === 'all')) return;
  const {state, snapshot} = await readQuestionState(read,id);
  if (!state.arithmeticPractice || state.recheck !== 0 ||
      state.restrictions.some(item => ['all','practice',use].includes(item.scope))) return;
  const {asset, expected, prompt} = arithmeticQuestion(arithmeticPractice(state.arithmeticPractice));
  // Every admitted question has exactly one generated prompt and exactly one local scoring contract.
  const actual = questionAsset(source.value);
  if (questionPrompt(actual) !== prompt || actual.title !== asset.title || actual.blocks.length !== 1 ||
      actual.basis?.length || JSON.stringify(freezeQuestionAssessment(actual,source.ref)) !==
      JSON.stringify(freezeQuestionAssessment(asset,source.ref))) return;
  return {source, state: snapshot, title: asset.title, prompt, expected};
}
