import { expect, it } from 'vitest';
import { parseAsset } from '../asset.ts';
import saveDiscipline from '../commands/save-discipline-context.ts';

it('declares an unfamiliar discipline through generic assessment data', () => {
  const context = {
    learningScope: '使用充足材料修复不同弦乐弓',
    mastery: '给出能复核的材料、工序与验收条件',
    assessment: ['比较修复前后的稳定性'],
    boundaries: ['音色偏好不可客观评分'],
  };
  const parsed = saveDiscipline.schema.parse({
    id: '01KFS4AAA00000000000000031',
    title: '弦乐弓修复',
    discipline_context: context,
  });
  expect(parseAsset(parsed.asset)).toMatchObject({
    kind: 'discipline', title: '弦乐弓修复', discipline_context: context,
  });
  expect(() => saveDiscipline.schema.parse({
    id: '01KFS4AAA00000000000000031', title: '弦乐弓修复',
  })).toThrow('学科语境');
});
