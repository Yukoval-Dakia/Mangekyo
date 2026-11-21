import { factId, learnerId, type BusWitness, type FactSnapshot, type Revision, type Tick } from '@mangekyo/kernel';

export const id = (n: number) => factId(String(n).padStart(26, '0'));
export const learner = learnerId(id(1));
export const ref = (n: number, epoch = '0') => ({id: id(n), rev: 1 as Revision, accessEpoch: epoch as Tick});
export const use = (n: number, type: string): BusWitness => ({...ref(n), learner, type, mode: 'following'});
export const snapshot = (ref: BusWitness, value: FactSnapshot['value'] = {}, purpose: readonly string[] = ['teaching']): FactSnapshot =>
  ({type: ref.type, ref, accessEpoch: ref.accessEpoch, value, purpose});
