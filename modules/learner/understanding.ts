import type { FactId, Revision, Tick } from '@mangekyo/kernel';
import { learnerPreference, type PreferenceScope } from './preference-values.ts';

export type UnderstandingKind = 'preference' | 'claim' | 'state' | 'observation' | 'misconception' | 'playbook';
export type UnderstandingRef = { id: FactId; rev: Revision; accessEpoch: Tick };
export type Understanding<Scope, Evidence> = {
  kind: UnderstandingKind;
  text: string;
  scope: Scope;
  ttl: string | null;
  evidence_refs: readonly Evidence[];
  sticky: boolean;
};

export function preferenceUnderstanding(value: unknown): Understanding<PreferenceScope, never> {
  const { text, scope } = learnerPreference(value);
  return { kind: 'preference', text, scope, ttl: null, evidence_refs: [], sticky: true };
}
