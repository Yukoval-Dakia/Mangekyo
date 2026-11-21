import { expect, it } from 'vitest';
import { questionExposureReceiptVersion, questionNegativeRefs, questionScope } from './question-read-receipts.ts';

it('rejects old assertions of unexposed questions, including filtered rows', () => {
  const id = '0123456789ABCDEFGHJKMNPQRS';
  const receipt = (questionExposure: number, questionNegatives: string[]) => JSON.stringify({
    values: [{scope: questionScope, items: []}], questionExposure, questionNegatives,
  });
  expect(questionNegativeRefs([receipt(1, [])])).toBeUndefined();
  expect(questionNegativeRefs([receipt(2, [id])])).toBeUndefined();
  expect(questionNegativeRefs([receipt(2, [])])).toEqual(new Set());
  expect(questionNegativeRefs([receipt(questionExposureReceiptVersion, [id])])).toEqual(new Set([id]));
});
