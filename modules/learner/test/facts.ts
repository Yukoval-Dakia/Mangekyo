import { commandId, factId, learnerId, type BusWitness, type FactSnapshot, type FactWrite, type Json, type LearnerId, type Revision, type Tick } from '@mangekyo/kernel';
import { applyFactWrites } from '../../../kernel/src/commands/writes.ts';
import type { Db } from '../../../kernel/src/db/types.ts';

export const id = (n: number) => factId(String(n).padStart(26, '0'));
export const command = (n: number) => commandId(id(n));
export const learner = learnerId(id(1));
export const ref = (n: number, epoch = '0') => ({id: id(n), rev: 1 as Revision, accessEpoch: epoch as Tick});
export const use = (n: number, type: string): BusWitness => ({...ref(n), learner, type, mode: 'following'});
export const snapshot = (ref: BusWitness, value: FactSnapshot['value'] = {}, purpose: readonly string[] = ['teaching']): FactSnapshot =>
  ({type: ref.type, ref, accessEpoch: ref.accessEpoch, value, purpose});

/** Seed arbitrary evidence types while exercising the kernel's transactional writes and access epochs. */
export const factWriter = (db: Db, scope: { learner: LearnerId; purpose: string }) =>
  (writes: readonly FactWrite[], n: number) => db.tx(scope, tx => tx.withLearnerWrite(tick =>
    applyFactWrites(tx, tick, writes, {actor: 'learner', purpose: scope.purpose, commandId: command(n)},
      type => ({type, schema: {parse: (value: Json) => value}}))));
