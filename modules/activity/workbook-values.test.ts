import { expect, it } from 'vitest';
import { factId, type Revision } from '@mangekyo/kernel';
import { detectWorkbookAttachmentMimeType, WorkbookAttachmentMediaError } from './workbook-attachments.ts';
import { gradeWorkbook, workbookAttempt, workbookAttemptRequest, workbookDraft, workbookPaper, workbookQuestionsView, workbookRubricGradingVersion } from './workbook-values.ts';

it('retains a pinned question alongside a copied question through paper readback', () => {
  const sourceQuestionRef = { id: '01KFS4AAA00000000000000001', rev: 2 };
  const copy = { kind: 'exact', prompt: '求均速。', answers: ['45'] };
  const draft = workbookDraft({ title: '均速', questions: [{ ...copy, sourceQuestionRef }, copy] });
  const paper = workbookPaper({ ...draft, savedAt: '2026-11-19T00:00:00.000Z' });
  const [pinned, independent] = workbookQuestionsView(paper);
  expect(pinned?.sourceQuestionRef).toEqual(sourceQuestionRef);
  expect(independent).not.toHaveProperty('sourceQuestionRef');
});

it('detects PNG/JPEG/WebP magic bytes and validates attachment-backed submissions', () => {
  expect(detectWorkbookAttachmentMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  expect(detectWorkbookAttachmentMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(detectWorkbookAttachmentMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x50, 0x50]))).toBe('image/webp');
  expect(() => detectWorkbookAttachmentMimeType(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'image/png')).toThrow(WorkbookAttachmentMediaError);
  const paperId = factId('01KFS4AAA00000000000000010'), originalId = factId('01KFS4AAA00000000000000011');
  const paper = workbookPaper({ ...workbookDraft({ title: '拍照卷', questions: [{ kind: 'rubric', prompt: '证明', rubric: '关键步' }] }), savedAt: '2026-11-19T00:00:00.000Z' });
  const req = workbookAttemptRequest({ requestId: 'req-attach-01', answers: { q1: null }, questionAttachments: { q1: [{ originalId, rev: 1 }] } }, { paperId, submittedAt: '2026-11-19T00:01:00.000Z' });
  const graded = gradeWorkbook(paper, req.answers, req.questionAttachments);
  expect(graded.feedback[0]?.result).toBe('pending');
  const stored = workbookAttempt({ paperId, requestId: req.requestId, submittedAt: req.submittedAt, gradingVersion: workbookRubricGradingVersion, paper, answers: graded.answers, questionAttachments: req.questionAttachments, basis: [{ id: originalId, rev: 1 as Revision, epoch: '0' }], feedback: graded.feedback });
  expect(stored.questionAttachments?.q1).toEqual([{ originalId, rev: 1 }]);
  expect(() => workbookAttempt({ ...stored, basis: undefined })).toThrow('依据');
});
