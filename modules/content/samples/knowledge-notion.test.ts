import { FactNotFoundError, factId, learnerId, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';
import { readQuestionNotionLinks } from '@mangekyo/module-content/facts/knowledge-reads';
import { expect, test } from 'vitest';

const id = (n: number) => factId(String(n).padStart(26, '0'));
const learner = learnerId(id(1));
const use = (n: number, rev = 1, epoch = '0') => ({ id: id(n), rev: rev as Revision, accessEpoch: epoch as Tick });
const note = { kind: 'note', sourceUse: use(2), blockId: 'block' } as const;
const concept = { kind: 'concept', sourceUse: use(3) } as const;
const question = { kind: 'question', sourceUse: use(4) } as const;
const root = { ...note, sourceUse: use(2, 2) };

function fact(source: ReturnType<typeof use>, type: string, value: FactSnapshot['value']): FactSnapshot {
  return { ref: { learner, id: source.id, rev: source.rev }, type, value, accessEpoch: source.accessEpoch, purpose: ['teaching'] };
}

test('a following note root reaches an older edge only through the original authorized block pin', async () => {
  const block = { id: 'block', parentId: null, body: { kind: 'text', text: '题干' } };
  const noteValue = { kind: 'notion', unit: { blocks: [block] } };
  const rows = [
    fact(note.sourceUse, 'capture.source', noteValue), fact(root.sourceUse, 'capture.source', noteValue),
    fact(concept.sourceUse, 'content.asset', { kind: 'concept', title: '概念', blocks: [] }),
    fact(question.sourceUse, 'content.asset', { kind: 'question', title: '题目', promptBlockId: 'block', blocks: [block] }),
    fact(use(5), 'content.knowledgeEdge', { kind: 'explains', from: note, to: concept, sourceUses: [note.sourceUse, concept.sourceUse], scope: 'scope' }),
    fact(use(6), 'content.knowledgeEdge', { kind: 'targets_concept', from: question, to: concept, sourceUses: [question.sourceUse, concept.sourceUse], scope: 'scope' }),
  ];
  const open = (mode: 'following' | 'pinned', unchanged: boolean) => readQuestionNotionLinks({
    learner, purpose: 'teaching', recipient: 'tutor', isUnavailable: () => false,
    read: { async fact(id, options) {
      const row = rows.find(f => f.ref.id === id && (options.mode === 'following' || f.ref.rev === options.rev));
      if (!row) throw new FactNotFoundError();
      return row;
    } },
  }, { root, mode, edgeIds: [id(5), id(6)] }, async witness =>
    witness.rev === root.sourceUse.rev || unchanged ? { text: '题干' } : undefined);

  expect(await open('following', true)).toMatchObject([{
    kind: 'question', question: question.sourceUse,
    trail: [{ edge: { id: id(5), rev: 1 } }, { edge: { id: id(6), rev: 1 } }],
  }]);
  expect(await open('following', false)).toEqual([]);
  expect(await open('pinned', true)).toEqual([]);
});
