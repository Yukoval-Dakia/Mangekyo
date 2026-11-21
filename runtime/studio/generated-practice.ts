import { randomInt } from 'node:crypto';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { arithmeticBounds, arithmeticPractice, arithmeticQuestionId, independentArithmeticV1 } from '../../modules/content/arithmetic-practice.ts';
import { RequestError } from './sessions.ts';

export function parsePracticeAdmission(definition: Record<string, unknown>) {
  if (definition.generate !== true) {
    if ('generation' in definition) throw new Error('生成方式由练习服务分配。');
    return arithmeticPractice(definition);
  }
  const {operation} = definition;
  if (Object.keys(definition).length !== 2 || (operation !== 'add' && operation !== 'subtract' && operation !== 'multiply'))
    throw new Error('随机练习只需要指定运算。');
  return { generate: true, operation } as const;
}

export async function resolvePracticeAdmission(tx: ReadTransaction, command: string,
  requested: ReturnType<typeof parsePracticeAdmission>) {
  if (!('generate' in requested)) return requested;
  const {rows:[prior]} = await tx.query<{practice: unknown}>(`SELECT input#>'{input,arithmeticPractice}' AS practice
    FROM commands WHERE learner_id=$1 AND id=$2`, [tx.learner,command]);
  const {operation} = requested;
  if (prior) {
    const previous = prior.practice ? arithmeticPractice(prior.practice) : undefined;
    if (!previous || previous.generation !== independentArithmeticV1 || previous.operation !== operation)
      throw new RequestError(409,'同一个请求标识已经用于不同练习。');
    return previous;
  }
  const [minimum, upper] = arithmeticBounds(operation);
  for (let attempt = 0; attempt < 4; attempt++) {
    const practice = arithmeticPractice({operation, generation:independentArithmeticV1,
      left:randomInt(minimum,upper), right:randomInt(minimum,upper)});
    const id = await arithmeticQuestionId(practice);
    const existing = await tx.query(`SELECT 1 FROM facts WHERE learner_id=$1 AND id=$2
      UNION ALL SELECT 1 FROM tombstones WHERE learner_id=$1 AND kind='fact' AND id=$2`, [tx.learner,id]);
    if (!existing.rowCount) return practice;
  }
  throw new RequestError(503,'暂时无法生成新的练习，请重试。');
}
