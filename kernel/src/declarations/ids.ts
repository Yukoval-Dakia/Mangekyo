export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type LearnerId = Brand<string, 'LearnerId'>;
export type FactId = Brand<string, 'FactId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type DerivationId = Brand<string, 'DerivationId'>;
export type Tick = Brand<string, 'Tick'>;
export type Revision = Brand<number, 'Revision'>;

function ulid<Id extends string>(value: string, kind: string): Id {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) {
    throw new Error(`${kind} must be a ULID`);
  }
  return value as Id;
}

export function learnerId(value: string): LearnerId {
  return ulid(value, 'Learner ID');
}

export function factId(value: string): FactId {
  return ulid(value, 'Fact ID');
}

export function commandId(value: string): CommandId {
  return ulid(value, 'Command ID');
}

export function derivationId(value: string): DerivationId {
  return ulid(value, 'Derivation ID');
}
