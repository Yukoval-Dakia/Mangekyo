import { factId, learnerId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { checkTextbookBasis, isPurposeWidenedContinuation } from '../asset.ts';
import { KnowledgeEdgeBasisError, readKnowledgeUse } from '../knowledge-edge.ts';

const learner = learnerId('01KFS4AAA00000000000000000');
const id = factId('01KFS4AAA00000000000000002');
const value = { kind: 'capture', title: 'material', blocks: [] };
type Store = { revs: { data: unknown; purpose: string[] }[]; epoch: number };
const read = (store: Store) => ({ fact: async (fid: typeof id, o: { mode: 'pinned' | 'following'; rev?: number }) => {
  if (fid !== id) throw new Error('unexpected');
  const rev = (o.mode === 'pinned' ? o.rev! : store.revs.length) as Revision;
  const row = store.revs[rev - 1];
  if (!row) throw new Error('missing rev');
  return { ref: { learner, id, rev }, type: 'content.asset', accessEpoch: String(store.epoch) as Tick,
    value: row.data, purpose: row.purpose } as FactSnapshot;
}});
const ctx = (store: Store) => ({ learner, read: read(store) });
const use = { id, rev: 1 as Revision, accessEpoch: '0' as Tick };
const basis = [{ id, rev: 1 as Revision, epoch: '0', type: 'content.asset' }];

const widen = (rev: number, epoch: number): Store => ({
  revs: [{ data: value, purpose: ['storage'] }, { data: value, purpose: ['storage', 'teaching'] }].slice(0, rev), epoch });

it('accepts pure widening and rejects narrowing, epoch drift, or content edits', async () => {
  await expect(readKnowledgeUse(ctx(widen(2, 1)), use)).resolves.toMatchObject({ ref: { rev: 2 }, accessEpoch: '1' });
  await expect(checkTextbookBasis(read(widen(2, 1)), basis)).resolves.toBeUndefined();
  await expect(readKnowledgeUse(ctx(widen(1, 0)), use)).resolves.toMatchObject({ ref: { rev: 1 } });
  const shrunk: Store = { revs: [{ data: value, purpose: ['storage'] }, { data: value, purpose: ['storage', 'teaching'] },
    { data: value, purpose: ['storage'] }], epoch: 2 };
  await expect(readKnowledgeUse(ctx(shrunk), use)).rejects.toBeInstanceOf(KnowledgeEdgeBasisError);
  await expect(checkTextbookBasis(read(shrunk), basis)).rejects.toThrow('教材依据已变更');
  const widenedThenShrunk: Store = { revs: [{ data: value, purpose: ['storage'] },
    { data: value, purpose: ['storage', 'teaching', 'research'] }, { data: value, purpose: ['storage', 'teaching'] }], epoch: 2 };
  await expect(readKnowledgeUse(ctx(widenedThenShrunk), use)).rejects.toBeInstanceOf(KnowledgeEdgeBasisError);
  await expect(readKnowledgeUse(ctx({ revs: widen(1, 0).revs, epoch: 1 }), use))
    .rejects.toBeInstanceOf(KnowledgeEdgeBasisError);
  const edited: Store = { revs: [{ data: value, purpose: ['storage'] },
    { data: { ...value, title: 'edited' }, purpose: ['storage', 'teaching'] }], epoch: 1 };
  await expect(readKnowledgeUse(ctx(edited), use)).rejects.toBeInstanceOf(KnowledgeEdgeBasisError);
  const twoStep: Store = { revs: [{ data: value, purpose: ['storage'] }, { data: value, purpose: ['storage', 'teaching'] },
    { data: value, purpose: ['storage', 'teaching', 'research'] }], epoch: 2 };
  await expect(readKnowledgeUse(ctx(twoStep), use)).resolves.toMatchObject({ ref: { rev: 3 }, accessEpoch: '2' });
  const pinned = await read(widen(2, 1)).fact(id, { mode: 'pinned', rev: 1 });
  await expect(isPurposeWidenedContinuation(read(widen(2, 2)), pinned, '0')).resolves.toBeUndefined();
});
