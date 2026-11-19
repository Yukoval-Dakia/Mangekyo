import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { coordinatorRequest, isCoordinatorRequest, type CoordinatorDecision, type CoordinatorRequest } from './coordinator.ts';

export type AdvanceCoordinator = (request: CoordinatorRequest, signal: AbortSignal) => Promise<CoordinatorDecision>;

function coordinatorFailure(type: string, nonRetryable: boolean): ApplicationFailure {
  const failure = ApplicationFailure.create({ message: 'Coordinator activity failed', type, nonRetryable });
  delete failure.stack;
  return failure;
}

function projectDecision(decision: CoordinatorDecision): CoordinatorDecision | undefined {
  switch (decision?.status) {
    case 'advanced':
      return { status: 'advanced' };
    case 'disabled':
      return { status: 'disabled' };
    case 'waiting': {
      const { recheckAtMs } = decision;
      if (recheckAtMs === undefined) return { status: 'waiting' };
      if (Number.isSafeInteger(recheckAtMs) && recheckAtMs > 0) return { status: 'waiting', recheckAtMs };
    }
  }
  return undefined;
}

export function createCoordinatorActivity(advance: AdvanceCoordinator) {
  return async (request: CoordinatorRequest): Promise<CoordinatorDecision> => {
    if (!isCoordinatorRequest(request)) throw coordinatorFailure('InvalidCoordinatorRequest', true);
    const { coordinatorRef, wakeRef } = request;
    const timer = setInterval(() => heartbeat(), 3000);
    timer.unref();
    let decision: CoordinatorDecision | undefined;
    try {
      decision = projectDecision(await advance(coordinatorRequest(coordinatorRef, wakeRef), cancellationSignal()));
    } catch {
      throw coordinatorFailure('CoordinatorAdvanceFailed', false);
    } finally {
      clearInterval(timer);
    }
    if (decision === undefined) throw coordinatorFailure('InvalidCoordinatorDecision', true);
    return decision;
  };
}
