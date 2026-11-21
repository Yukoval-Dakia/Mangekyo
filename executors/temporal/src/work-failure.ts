// A fixed category is sufficient to settle a failed execution. Keep the original
// error, its provider details and any source data out of Temporal history.
export const classifiedWorkFailureTypes = {
  'remote-unavailable': 'WorkExecutionFailedRemoteUnavailable',
  execution: 'WorkExecutionFailedNonRemote',
} as const;

export type WorkFailureCause = keyof typeof classifiedWorkFailureTypes;

export function readWorkFailureCause(type: string | null | undefined): WorkFailureCause | undefined {
  if (type === classifiedWorkFailureTypes['remote-unavailable']) return 'remote-unavailable';
  return type === classifiedWorkFailureTypes.execution ? 'execution' : undefined;
}
