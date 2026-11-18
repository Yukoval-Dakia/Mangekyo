import { activityInfo } from '@temporalio/activity';
import { setTimeout } from 'node:timers/promises';

export const executions = {
  recovery: '01ARZ3NDEKTSV4RRFFQ69G5FAT',
  fresh: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  closed: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  failure: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  terminal: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
};
export const privateBody = 'PRIVATE_BODY_MUST_NEVER_REACH_TEMPORAL_HISTORY';

export async function executeWork(executionRef: string): Promise<string> {
  const attempt = activityInfo().attempt;
  if (executionRef === executions.failure && attempt === 1) {
    throw new Error(privateBody);
  }
  if (executionRef === executions.terminal) {
    throw new Error(privateBody);
  }
  if (executionRef === executions.recovery && attempt === 1) {
    await setTimeout(60000);
  }
  return privateBody;
}

export async function onTerminalFailure(executionRef: string): Promise<void> {
  if (executionRef !== executions.terminal || activityInfo().attempt === 1) {
    throw new Error(privateBody);
  }
}
