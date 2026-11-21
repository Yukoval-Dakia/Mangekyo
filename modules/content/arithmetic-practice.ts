import type { FactId, FactSnapshot, ReadContext } from '@mangekyo/kernel';
import { assetType, freezeQuestionAssessment, questionAsset, questionPrompt } from './asset.ts';
import { fields, record } from './parse.ts';
import { readQuestionState } from './question-state.ts';
import { contentStableId } from './knowledge-entity.ts';

export const arithmeticPracticeV1 = 'sealed-arithmetic-practice-v1';
export const independentArithmeticV1 = 'independent-arithmetic-v1';

export function arithmeticBounds(operation: 'add' | 'subtract' | 'multiply') {
  return operation === 'multiply' ? [10_000_000, 90_000_000] as const
    : [100_000_000_000_000, 300_000_000_000_000] as const;
}

export function arithmeticPractice(input: unknown) {
  const row = record(input);
  fields(row, 'operation', 'left', 'right', 'generation');
  const {operation, left, right, generation} = row;
  if (operation !== 'add' && operation !== 'subtract' && operation !== 'multiply')
    throw new Error('练习支持加、减或乘。');
  if (generation !== undefined && generation !== independentArithmeticV1) throw new Error('练习生成方式无效。');
  const [minimum, upper] = generation ? arithmeticBounds(operation) : [1, 1000];
  if (typeof left !== 'number' || !Number.isSafeInteger(left) || left < minimum || left >= upper ||
      typeof right !== 'number' || !Number.isSafeInteger(right) || right < minimum || right >= upper)
    throw new Error('练习操作数不在当前生成方式的范围中。');
  const operands = operation !== 'subtract' && left > right ? {left:right,right:left} : {left,right};
  return {operation,...operands,...(generation && {generation})};
}

export function arithmeticQuestionId({operation,left,right,generation}: ReturnType<typeof arithmeticPractice>) {
  return contentStableId(generation ?? arithmeticPracticeV1,operation,String(left),String(right));
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
  const practice = arithmeticPractice(state.arithmeticPractice);
  const {asset, expected, prompt} = arithmeticQuestion(practice);
  // Every admitted question has exactly one generated prompt and exactly one local scoring contract.
  const actual = questionAsset(source.value);
  if (questionPrompt(actual) !== prompt || actual.title !== asset.title || actual.blocks.length !== 1 ||
      actual.basis?.length || JSON.stringify(freezeQuestionAssessment(actual,source.ref)) !==
      JSON.stringify(freezeQuestionAssessment(asset,source.ref))) return;
  return {source, state: snapshot, title: asset.title, prompt, expected, practice};
}
