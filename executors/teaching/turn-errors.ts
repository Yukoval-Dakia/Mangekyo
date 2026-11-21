import { TeachingError } from './provider.ts';

export class UncertainEffect extends Error {
  constructor(requestId: string | null) {
    super('提供方的执行结果待核对，本轮已停止自动调用。' + (requestId ? '请求标识 ' + requestId : ''));
  }
}

export class ChangedEvidence extends Error {}

export const terminalRecoveryFailure = '执行器恢复后仍无法完成本轮教学。可开始新会话。';

export function classifyTeachingFailure(error: unknown): { status: 'failed' | 'unknown'; message: string } | null {
  if (error instanceof UncertainEffect) return { status: 'unknown', message: error.message };
  if (error instanceof ChangedEvidence) return { status: 'failed', message: '作答依据已变化，本轮结果无法使用。' };
  if (error instanceof TeachingError) return { status: 'failed', message: error.message };
  return null;
}
