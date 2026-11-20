import type { Experience } from '@mangekyo/kernel';
import { instant, type Witness } from './memory-evidence.ts';

export type RunTrace = {
  runId: string; agentId: string; objective: string; strategyId: string | null;
  environmentVersion: string | null; startedAt: string; finishedAt: string | null; tokenCost: number | null;
};
export type ActionTrace = {runId: string; actionRef: Witness; observationRefs: readonly Witness[]};
export type OutcomeTrace = {
  runId: string; outcome: 'success' | 'failure' | 'partial' | 'unknown';
  verificationRefs: readonly Witness[]; userFeedbackRefs: readonly Witness[];
};

// Inputs are the bus-authorized trace rows for one learner. No parallel ledger
// is written. Missing telemetry and unfinished runs retain their unknowns.
export function projectExperience(run: RunTrace, actions: readonly ActionTrace[], outcomes: readonly OutcomeTrace[]): RunTrace & Experience<Witness, OutcomeTrace['outcome']> {
  const selected = actions.filter(action => action.runId === run.runId);
  const results = outcomes.filter(outcome => outcome.runId === run.runId);
  const dispositions = new Set(results.map(result => result.outcome));
  const start = Date.parse(instant(run.startedAt));
  const latencyMs = run.finishedAt === null ? null : Date.parse(instant(run.finishedAt)) - start;
  if (latencyMs !== null && latencyMs < 0 || run.tokenCost !== null && (!Number.isFinite(run.tokenCost) || run.tokenCost < 0))
    throw new Error('运行耗时或花费无效。');
  return {...run, actionRefs: selected.map(action => action.actionRef), observationRefs: selected.flatMap(action => action.observationRefs),
    outcome: dispositions.size === 1 ? results[0]!.outcome : 'unknown' as const,
    verificationRefs: results.flatMap(result => result.verificationRefs),
    userFeedbackRefs: results.flatMap(result => result.userFeedbackRefs), latencyMs};
}
