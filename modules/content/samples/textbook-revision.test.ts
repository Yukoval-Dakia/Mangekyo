import { expect, it } from 'vitest';
import { factId, learnerId, type FactSnapshot, type ReadContext, type Revision, type Tick } from '@mangekyo/kernel';
import { previewTextbookRevision, selectTextbookEdits } from '../textbook-edits.ts';
import { textbookPageType } from '../textbook-page.ts';

it('keeps a later block change selectable when the first block is missing', async () => {
  const learner = learnerId('01KFS4AAA00000000000000000');
  const id = factId('01KFS4AAA00000000000000001');
  const snapshot: FactSnapshot = {
    type: textbookPageType, ref: { learner, id, rev: 2 as Revision },
    accessEpoch: '0' as Tick, purpose: ['storage'],
    value: { title: '平均速度', blocks: [
      { id: 'formula', parentId: null, body: { kind: 'formula', latex: 's/t' } },
    ] },
  };
  const unavailable = async (): Promise<never> => { throw new Error('Only fact reads are expected'); };
  const read: ReadContext = { fact: async <Value>() => snapshot as FactSnapshot<Value>, slot: unavailable, range: unavailable };
  const rewrite = { kind: 'rewrite', blockId: 'formula', body: { kind: 'formula', latex: '\\Delta s/\\Delta t' } };
  const preview = await previewTextbookRevision({ learner, read }, {
    id, expectedRev: 2, clientEditSeq: 4,
    edits: [{ ...rewrite, blockId: 'missing' }, rewrite],
  });
  expect(preview.items.map(item => item.state)).toEqual(['invalid', 'ready']);
  expect(preview.items[1]?.before?.block.body).toEqual({ kind: 'formula', latex: 's/t' });
  expect(selectTextbookEdits(preview, ['formula'])).toEqual({ id, expectedRev: 2, clientEditSeq: 4, edits: [rewrite] });
  expect(() => selectTextbookEdits(preview, ['missing'])).toThrow('请选择有效');
});
