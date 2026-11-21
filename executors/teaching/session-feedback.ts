import { projectArtifactMountTrace } from './artifact-trace.ts';
import type { StudyKit } from './study-kit.ts';

export type TeachingFeedback = {
  classroomPlan?: string[];
  studyKit?: StudyKit;
  trace?: string[];
  completion?: 'receipts_only';
  action: string;
  rationale: string;
  message: string;
  model: string;
  reasoningEffort?: string;
  evidenceIds: readonly string[];
  reportedModel?: string;
  reads: readonly { id: string; title: string; text: string }[];
};

export const unconfirmedReplyMessage = '暂时无法核对本轮依据，旧回复已隐藏。';
export const unavailableReplyMessage = '本轮已完成，依据已变更，旧回复已隐藏。';

export function unavailableReply(model: string, unconfirmed = false): TeachingFeedback {
  return {
    action: 'reply_unavailable',
    model,
    rationale: '',
    message: unconfirmed ? unconfirmedReplyMessage : unavailableReplyMessage,
    reads: [],
    evidenceIds: [],
  };
}

export function projectTeachingFeedback<T extends TeachingFeedback, R extends { lesson: string }>(
  { studyKit, classroomPlan: _plan, trace, ...feedback }: T,
  recall: R | undefined,
) {
  return {
    ...feedback,
    ...(trace && { trace: trace.map(projectArtifactMountTrace) }),
    ...(studyKit === undefined ? {} : { message: recall?.lesson ?? '' }),
    ...(recall ? { recall } : {}),
  };
}
