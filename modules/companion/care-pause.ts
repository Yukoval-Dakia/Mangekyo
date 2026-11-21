import { factId, type FactId, type FactWrite, type ReadContext, type Revision } from '@mangekyo/kernel';

export const carePauseType = 'companion.carePause';
export const pauseCare = 'companion.pauseCare';
export const resumeCare = 'companion.resumeCare';
/** Short-lived gate only: never a permanent learner-risk profile, never raw quotes. */
export const carePausePurpose = 'storage';
export const carePauseTtlMs = 24 * 60 * 60 * 1000;
export const carePauseScope = 'nudges_and_paid_background';

export type CarePauseStatus = Readonly<{
  active: boolean;
  scope: typeof carePauseScope;
  expiresAt: string | null;
  revision: Revision;
}>;

const inactiveStatus: CarePauseStatus = Object.freeze({
  active: false,
  scope: carePauseScope,
  expiresAt: null,
  revision: 0 as Revision,
});

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('暂停状态格式无效。');
  return value as Record<string, unknown>;
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('暂停到期时间无效。');
  return new Date(value).toISOString();
}

export function carePauseValue(value: unknown) {
  const { active, scope, expiresAt } = object(value);
  if (typeof active !== 'boolean' || scope !== carePauseScope) throw new Error('暂停状态格式无效。');
  return { active, scope: carePauseScope, expiresAt: instant(expiresAt) } as const;
}
export type CarePauseValue = ReturnType<typeof carePauseValue>;

function revision(value: unknown, minimum = 1): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('暂停状态版本无效。');
  return value as Revision;
}

export async function readCarePause(read: ReadContext, id: FactId, now = Date.now()): Promise<CarePauseStatus> {
  const fact = await read.fact(id, { mode: 'following' }).catch(() => null);
  if (!fact) return inactiveStatus;
  const value = carePauseValue(fact.value);
  const expiresAtMs = Date.parse(value.expiresAt);
  return value.active && expiresAtMs > now
    ? { active: true, scope: carePauseScope, expiresAt: value.expiresAt, revision: fact.ref.rev }
    : { active: false, scope: carePauseScope, expiresAt: value.expiresAt, revision: fact.ref.rev };
}

export function pauseCareInput(value: unknown) {
  const input = object(value);
  return { id: factId(String(input.id)), revision: revision(input.revision, 0), now: instant(input.now) };
}

export function pauseCareWrite(
  current: CarePauseValue | null,
  id: FactId,
  now: string,
  currentRev?: Revision,
): readonly FactWrite[] {
  const data: CarePauseValue = { active: true, scope: carePauseScope, expiresAt: new Date(Date.parse(now) + carePauseTtlMs).toISOString() };
  if (!current) {
    return [{ kind: 'create', id, factType: carePauseType, purpose: [carePausePurpose], data }];
  }
  if (current.active && Date.parse(current.expiresAt) > Date.parse(now)) return [];
  return [{ kind: 'correct', id, expectedRev: currentRev as Revision, data }];
}

export function resumeCareInput(value: unknown) {
  const input = object(value);
  return { id: factId(String(input.id)), revision: revision(input.revision) };
}

export function resumeCareWrite(prior: CarePauseValue, id: FactId, expected: Revision): readonly FactWrite[] {
  if (!prior.active) return [];
  return [{ kind: 'correct', id, expectedRev: expected, data: { active: false, scope: carePauseScope, expiresAt: prior.expiresAt } as CarePauseValue }];
}
