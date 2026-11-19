import { expect, it } from 'vitest';
import { workbookDraft, workbookPaper, workbookQuestionsView } from './workbook-values.ts';

it('retains a pinned question alongside a copied question through paper readback', () => {
  const sourceQuestionRef = { id: '01KFS4AAA00000000000000001', rev: 2 };
  const copy = { kind: 'exact', prompt: '求均速。', answers: ['45'] };
  const draft = workbookDraft({ title: '均速', questions: [{ ...copy, sourceQuestionRef }, copy] });
  const paper = workbookPaper({ ...draft, savedAt: '2026-11-19T00:00:00.000Z' });
  const [pinned, independent] = workbookQuestionsView(paper);
  expect(pinned?.sourceQuestionRef).toEqual(sourceQuestionRef);
  expect(independent).not.toHaveProperty('sourceQuestionRef');
});
