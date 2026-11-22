import {
  canRetryVisionExtraction,
  intakeResearchPurpose,
  materialTextLimit,
  retryableVisionPages,
  type IntakeDocument,
  type IntakeExtraction,
  type IntakeExtractionStage,
  type IntakePageExtraction,
  type IntakePageOriginal,
  type IntakeRequestedExtraction,
} from './intake-values.ts';
import { visionOcrSupports, type StructuredPaperDrafts } from './vision-paper-ocr.ts';

export type IntakeMetadata = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly characterCount: number;
  readonly truncated: boolean;
  readonly fullText: string | null;
  readonly extraction: IntakeExtraction;
  readonly requestedExtraction?: IntakeRequestedExtraction;
  readonly intakeStatus: IntakeExtractionStage;
  readonly drafts?: StructuredPaperDrafts;
  readonly original: { readonly name: string; readonly mediaType: string; readonly size: number; readonly sha256: string };
  readonly originals?: readonly IntakePageOriginal[];
  readonly pageCount: number | null;
  readonly pageExtractions?: readonly IntakePageExtraction[];
  readonly retryableVisionPages: readonly number[];
  readonly corrected: boolean;
  readonly canRetryVision: boolean;
  readonly backgroundResearch?: 'allowed' | 'private' | 'all';
  readonly revision: number;
};

function projectIntakeStatus(document: IntakeDocument): IntakeExtractionStage {
  const { extraction } = document;
  if (extraction.status === 'pending') return extraction.stage ?? 'queued';
  if (extraction.status === 'failed') return 'failed';
  if (extraction.method === 'vision_fallback' || extraction.stage === 'fallback') return 'fallback';
  return 'ready';
}

export function projectIntakeMetadata(document: IntakeDocument, material: {title: string; text: string},
  revision: number, purpose: readonly string[]): IntakeMetadata {
  const fullText = document.extraction.status === 'failed' || document.extraction.status === 'pending'
    ? null : document.extraction.text;
  const truncated = document.extraction.truncated || (fullText !== null && fullText.length > materialTextLimit);
  const pageCount = document.extraction.pages ?? document.originals?.length ??
    (visionOcrSupports(document.original.mediaType) ? 1 : null);
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
    intakeStatus: projectIntakeStatus(document),
    ...(document.extraction.drafts ? { drafts: document.extraction.drafts } : {}),
    original: document.original,
    ...(document.originals ? { originals: document.originals } : {}),
    pageCount,
    ...(document.extraction.pageExtractions ? { pageExtractions: document.extraction.pageExtractions } : {}),
    retryableVisionPages: retryableVisionPages(document),
    corrected: document.extraction.status === 'corrected',
    canRetryVision: canRetryVisionExtraction(document),
    ...(document.extraction.status === 'corrected' && document.extraction.method === 'learner' ? {
      backgroundResearch: purpose.includes('all') ? 'all' : purpose.includes(intakeResearchPurpose) ? 'allowed' : 'private',
    } : {}),
  };
}
