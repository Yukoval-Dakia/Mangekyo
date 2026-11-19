import { isOpaqueUlid } from './ref.ts';

export const coordinatorWorkflowType = 'mangekyoCoordinator';
export const coordinatorWakeSignal = 'wakeCoordinator';

export interface CoordinatorRequest {
  coordinatorRef: string;
  wakeRef?: string;
}

export type CoordinatorDecision =
  | { status: 'advanced' }
  | { status: 'waiting'; recheckAtMs?: number }
  | { status: 'disabled' };

export function isCoordinatorRef(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function isCoordinatorRequest(request: CoordinatorRequest): boolean {
  return isCoordinatorRef(request?.coordinatorRef)
    && (request.wakeRef === undefined || isOpaqueUlid(request.wakeRef));
}

export function coordinatorWorkflowId(coordinatorRef: string): string {
  return `coordinator:${coordinatorRef}`;
}

export function coordinatorRequest(coordinatorRef: string, wakeRef?: string): CoordinatorRequest {
  return wakeRef === undefined ? { coordinatorRef } : { coordinatorRef, wakeRef };
}
