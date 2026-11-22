// Wave 3 独立做题台（workbook-v2）共享类型。
// 字段名与域 1 / 域 3 定稿契约严格一致；本目录只新建、不改既有文件。

export type AttachmentScope = 'inherit' | 'once';

export type AttachmentUploadState =
  | { phase: 'uploading'; progress: number }
  | { phase: 'error'; message: string }
  | { phase: 'done'; originalId: string; rev: number; url: string; mimeType: string; scope: AttachmentScope };

// 单题本地上传条目（提交前）。preview 用 objectURL，生命周期由组件管。
export type PendingAttachment = {
  localId: string;
  file: File;
  previewUrl: string;
  scope: AttachmentScope;
  state: AttachmentUploadState;
};

// POST /api/papers/:paperId/attachments 响应（域 1 定稿）。
export type AttachmentReceipt = {
  originalId: string;
  rev: number;
  url: string;
  mimeType: string;
  scope: AttachmentScope;
};

// POST /api/papers/:paperId/attempts 可携带的附件映射。
export type QuestionAttachmentsPayload = Record<
  string,
  readonly { originalId: string; rev: number }[]
>;

// 复盘只读响应中的附件（含实时权限重验）。
export type ReviewAttachment = {
  originalId: string;
  rev: number;
  url: string;
  available: boolean;
};
export type ReviewAttachmentsMap = Record<string, readonly ReviewAttachment[]>;

export type TakeawayUndoReceipt = { status: 'withdrawn'; id: string };
export type OwnWordsConceptWitness = { id: string; rev: number; accessEpoch: string };
export type TakeawaySaveReceipt = {
  id: string;
  rev: number;
  undo_token: string;
  sticky: true;
  purpose: readonly ['storage'] | 'storage';
};

// 能力 22 事前 L0 防剧透：open 返回的口诀本体。
export type OwnWordsOpening = { kind: 'own-words'; text: string; displayRef: string };

// 能力 22 交卷后原位对照回显。
export type TakeawayReview = {
  itemId: string;
  result: string;
  expected?: string | WorkbookV2Expected | null;
  explanation?: string | null;
  helpLevel?: 'independent' | 'hinted' | 'guided' | 'solution' | 'unknown' | number;
  text?: string | null;
  takeawayRev?: number;
  conceptId?: string;
  takeawaySavedAt?: string;
  submittedAt?: string;
  errorStage?: string | null;
};

// 把握度 1–5（完全选填）。
export type Confidence = 1 | 2 | 3 | 4 | 5;
export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  1: '很没把握',
  2: '不太有把握',
  3: '有点把握',
  4: '比较有把握',
  5: '很有把握',
};

// 单题视图（对齐 WorkbookQuestionView 的三种作答形态 + bank 渲染槽）。
export type FocusedQuestion =
  | { id: string; kind: 'numeric'; prompt: string; unit: string | null }
  | { id: string; kind: 'exact'; prompt: string; selfCheck: boolean }
  | { id: string; kind: 'rubric'; prompt: string; rubricVersion: string }
  | {
      id: string;
      kind: 'bank';
      prompt: string;
      responseSchema?: unknown;
      sharedMaterials?: readonly unknown[];
      interaction?: unknown;
    };

export type WorkbookV2Detail = {
  id: string;
  revision?: number;
  title: string;
  savedAt?: string;
  sealedPractice?: boolean;
  questions: FocusedQuestion[];
  attempts?: WorkbookV2Attempt[];
};

export type ExamTimeValueState = 'steady' | 'fast-slip' | 'time-sink' | 'recovered-skip' | 'unknown';

export type ExamTimeValueItem = {
  readonly item_id: string;
  readonly position: number;
  readonly effective_duration_ms: number;
  readonly state: ExamTimeValueState;
};

export type ExamTimeValueView = {
  readonly paper: { readonly id: string; readonly rev: number };
  readonly attempt_ref: { readonly id: string; readonly rev: number };
  readonly method_version: 'plan/exam-pacing@2';
} & (
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'observed';
      readonly total_duration_ms: number;
      readonly items: readonly ExamTimeValueItem[];
      readonly summary: string;
    }
);

export type PreSubmitPitfall = {
  readonly text: string;
  readonly anchors: readonly { readonly itemId: string; readonly number: number }[];
};

export type PreSubmitRevisionPayload = {
  readonly draftRequestId: string;
  readonly paperRev: number;
  readonly itemId: string;
  readonly originalAnswer: string | readonly unknown[] | null;
};

export type WorkbookV2Attempt = {
  id: string;
  rev?: number;
  paperRev?: number;
  requestId: string;
  submittedAt: string;
  correctCount?: number;
  total?: number;
  answers?: Record<string, unknown>;
  feedback?: readonly WorkbookV2Feedback[];
  questionAttachments?: ReviewAttachmentsMap;
  examTimeValue?: ExamTimeValueView;
  preSubmitRevised?: true;
};

export type WorkbookV2Expected =
  | { kind: 'numeric'; value: number; tolerance: number; unit: string | null }
  | { kind: 'exact'; values: string[] }
  | { kind: 'rubric'; rubric: string; rubricVersion: string };

export type WorkbookV2Feedback = {
  questionId: string;
  result: string;
  answer?: number | string | null;
  expected?: string | WorkbookV2Expected | null;
  explanation?: string | null;
  errorStage?: string | null;
};

export type OpenedHintState = {
  text: string;
  displayRef: string;
  reported: boolean;
};

export type SavedTakeawayState = {
  id: string;
  undoToken: string;
  text: string;
};

// 引用到右侧同伴（Wave 1 抽屉）的回调载荷。
export type CompanionCitation =
  | { kind: 'question'; paperId: string; itemId: string; title: string; excerpt: string }
  | { kind: 'attachment'; paperId: string; itemId: string; title: string; originalId: string; rev: number };

export type L0Source = {
  sourcePaperId: string;
  sourceAttempt: { id: string; rev: number };
  sourceItemId: string;
  issuance?: { id: string; rev: number } | string;
};
