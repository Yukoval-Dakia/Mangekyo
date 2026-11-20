import { intakeResearchPurpose, materialTextLimit, type IntakeDocument, type IntakeExtraction } from './intake-values.ts';

export type IntakeMetadata = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly characterCount: number;
  readonly truncated: boolean;
  readonly fullText: string | null;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: 'mineru';
  readonly original: { readonly name: string; readonly mediaType: string; readonly size: number; readonly sha256: string };
  readonly corrected: boolean;
  readonly backgroundResearch?: 'allowed' | 'private' | 'all';
  readonly revision: number;
};

export function projectIntakeMetadata(document: IntakeDocument, material: {title: string; text: string},
  revision: number, purpose: readonly string[]): IntakeMetadata {
  const fullText = document.extraction.status === 'failed' || document.extraction.status === 'pending'
    ? null : document.extraction.text;
  const truncated = document.extraction.truncated || (fullText !== null && fullText.length > materialTextLimit);
  return {
    id: document.materialId,
    title: material.title,
    text: material.text,
    characterCount: document.extraction.characterCount,
    truncated,
    fullText,
    revision: revision,
    extraction: document.extraction,
    ...(document.requestedExtraction ? { requestedExtraction: document.requestedExtraction } : {}),
    original: document.original,
    corrected: document.extraction.status === 'corrected',
    ...(document.extraction.status === 'corrected' && document.extraction.method === 'learner' ? {
      backgroundResearch: purpose.includes('all') ? 'all' : purpose.includes(intakeResearchPurpose) ? 'allowed' : 'private',
    } : {}),
  };
}
