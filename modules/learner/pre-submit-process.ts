import type { FactSnapshot } from '@mangekyo/kernel';
import { allows } from './memory-evidence.ts';

// Activity writes this flag after binding the selected anchor, the learner's
// changed answer and the formal independence judgment to the submission.
// Command input, draft values and absent fields are not process observations.
export function preSubmitRevisionWitness(fact: FactSnapshot, purpose: string) {
  const {value} = fact;
  if (fact.type !== 'activity.workbookAttempt' || !allows(fact.purpose, purpose) || !value ||
      typeof value !== 'object' || Array.isArray(value) || !('preSubmitRevised' in value) ||
      value.preSubmitRevised !== true) return;
  return {id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch};
}
