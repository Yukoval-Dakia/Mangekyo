import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { questionNegativeCurrent as negativeCurrent, questionReceiptsCurrent as receiptsCurrent } from '../../modules/activity/question-exposure.ts';
import { purpose } from './identity.ts';

export { arithmeticFreeProse, companionReplyStartedLabel, companionReplyTrackingLabel, learningPythonReadLabel,
  questionExposureReceiptVersion, questionScope } from '../../modules/activity/question-exposure.ts';
export const questionNegativeCurrent = (tx: ReadTransaction, id: Parameters<typeof negativeCurrent>[2], turn: string, beforeReply: boolean) =>
  negativeCurrent(tx,createCommandReadContext(tx,purpose),id,turn,beforeReply);
export const questionReceiptsCurrent = (tx: ReadTransaction, turn: string, use: Parameters<typeof receiptsCurrent>[3]) =>
  receiptsCurrent(tx,createCommandReadContext(tx,purpose),turn,use);
