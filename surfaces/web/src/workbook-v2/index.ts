// Wave 3 独立做题台装配口：Wave 1 合入后由 Wave 3 直接装配，父文件零改动。
import './workbook-v2.css';

export { WorkbookSurface } from './WorkbookSurface.tsx';
export { FocusedQuestionCard } from './FocusedQuestionCard.tsx';
export { ExamTimeValueBar } from './ExamTimeValueBar.tsx';
export { PreSubmitCheckCard } from './PreSubmitCheckCard.tsx';
export { ConfidenceSelector } from './ConfidenceSelector.tsx';
export {
  QuestionAttachmentUploader,
  ReviewAttachmentWall,
  summarizeAttachments,
  usePaperAttachments,
} from './QuestionAttachmentUploader.tsx';
export { OwnWordsHint, OwnWordsTakeawayEditor } from './OwnWordsTakeaway.tsx';
export { DualBacktraceDrawer } from './DualBacktraceDrawer.tsx';

export type {
  AttachmentScope,
  AttachmentReceipt,
  AttachmentUploadState,
  PendingAttachment,
  ReviewAttachment,
  ReviewAttachmentsMap,
  QuestionAttachmentsPayload,
  TakeawayReview,
  TakeawaySaveReceipt,
  TakeawayUndoReceipt,
  OwnWordsConceptWitness,
  OwnWordsOpening,
  Confidence,
  FocusedQuestion,
  ExamTimeValueState,
  ExamTimeValueItem,
  ExamTimeValueView,
  PreSubmitPitfall,
  PreSubmitRevisionPayload,
  WorkbookV2Detail,
  WorkbookV2Attempt,
  WorkbookV2Feedback,
  WorkbookV2Expected,
  OpenedHintState,
  SavedTakeawayState,
  CompanionCitation,
  L0Source,
  DualBacktraceHelpExposure,
  DualBacktraceIndependentHelpExposure,
  DualBacktraceMistakeMatchBasis,
  DualBacktraceSuccessMatchBasis,
  DualBacktraceTarget,
  DualBacktraceEvidence,
  DualBacktraceSimilarMistake,
  DualBacktraceIndependentSuccess,
  DualBacktraceResult,
  DualBacktraceDrawerProps,
} from './types.ts';

export type {
  PaperAttachmentController,
  PaperUploadLock,
  UploadSummary,
} from './QuestionAttachmentUploader.tsx';

export {
  loadPaper,
  loadPreSubmitPitfalls,
  uploadAttachment,
  submitAttempt,
  saveTakeaway,
  undoTakeaway,
  openOwnWords,
  confirmOwnWordsDisplay,
  loadTakeawayReview,
  loadDualBacktrace,
  reviewAttachmentsOf,
  isNotFound,
  requestId,
  ApiError,
} from './api.ts';
