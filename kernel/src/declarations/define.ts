import type { Json, JsonObject, ValueSchema } from './types.ts';

export type DeclarationKind = 'fact' | 'slot' | 'command' | 'deriver';
const declarationKind = Symbol.for('@mangekyo/kernel.declaration.v1');

type Declaration<Kind extends DeclarationKind> = {
  readonly [declarationKind]: Kind;
};

const typeName = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;
const moduleName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const deriverName = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const jsonPointer = /^(?:\/(?:[^~/]|~0|~1)*)*$/;

function assertName(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertSchema(schema: ValueSchema<unknown>): void {
  if (typeof schema.parse !== 'function') {
    throw new Error('A declaration schema must provide parse');
  }
}

export function defineFact<Value>(
  definition: {
    readonly type: string;
    readonly schema: ValueSchema<Value>;
    readonly correctableFields?: (fact: Value) => readonly string[];
  },
) {
  assertName(definition.type, typeName, 'fact type');
  assertSchema(definition.schema);
  return { ...definition, [declarationKind]: 'fact' } as const;
}

export type FactDefinition<Value = unknown> = ReturnType<typeof defineFact<Value>>;

export type Trigger =
  | { readonly kind: 'fact'; readonly factType: string }
  | { readonly kind: 'slot'; readonly slotType: string }
  | { readonly kind: 'always' };

export function defineSlot<Key extends JsonObject, Candidate, Presented = Candidate>(
  definition: {
    readonly type: string;
    readonly key: (input: Key) => string;
    readonly triggers: readonly Trigger[];
    readonly policy: 'eager' | 'lazy';
    readonly accept?: (
      ctx: Pick<import('./types.ts').CommandContext, 'learner'>,
      candidate: import('./types.ts').Outcome<Candidate>,
      current: import('./types.ts').DerivationSnapshot<Candidate> | null,
    ) => { readonly ok: true } | { readonly ok: false; readonly reason: string };
    readonly adopt?: (value: Candidate) => readonly import('./types.ts').CommandInput[];
    readonly present?: (value: Candidate, at: string) => Presented;
  },
) {
  assertName(definition.type, typeName, 'slot type');
  if (typeof definition.key !== 'function' || !['eager', 'lazy'].includes(definition.policy)) {
    throw new Error('A slot requires a key function and a valid policy');
  }
  if (!Array.isArray(definition.triggers)) throw new Error('Slot triggers must be an array');
  for (const callback of [definition.accept, definition.adopt, definition.present]) {
    if (callback !== undefined && typeof callback !== 'function') throw new Error('Slot callbacks must be functions');
  }
  for (const trigger of definition.triggers) {
    if (!trigger || !['fact', 'slot', 'always'].includes(trigger.kind)) throw new Error('Invalid slot trigger');
    if (trigger.kind === 'fact') assertName(trigger.factType, typeName, 'trigger fact type');
    if (trigger.kind === 'slot') assertName(trigger.slotType, typeName, 'trigger slot type');
  }
  return { ...definition, [declarationKind]: 'slot' } as const;
}

export type SlotDefinition = ReturnType<typeof defineSlot>;

export function defineCommand<Input, Read = undefined, Writes extends readonly import('./types.ts').FactWrite[] = readonly import('./types.ts').FactWrite[]>(
  definition: {
    readonly type: string;
    readonly schema: ValueSchema<Input>;
    readonly destructive: boolean;
    readonly read?: (ctx: import('./types.ts').CommandContext) => Promise<Read> | Read;
    readonly write: (
      ctx: import('./types.ts').CommandContext,
      input: Input,
      read: Read,
    ) => Writes | Promise<Writes>;
  },
) {
  assertName(definition.type, typeName, 'command type');
  assertSchema(definition.schema);
  if (typeof definition.destructive !== 'boolean' || typeof definition.write !== 'function') {
    throw new Error('A command requires destructive and write declarations');
  }
  return { ...definition, [declarationKind]: 'command' } as const;
}

export type CommandDefinition = ReturnType<typeof defineCommand>;

export function defineDeriver<Key, Input extends Json, Value>(
  definition: {
    readonly name: string;
    readonly version: string;
    readonly slot: string;
    readonly gather: (
      ctx: import('./types.ts').GatherContext,
      slotKey: Key,
    ) => Promise<import('./types.ts').GatherInput<Input> | import('./types.ts').Waiting>
      | import('./types.ts').GatherInput<Input> | import('./types.ts').Waiting;
    readonly derive: (
      input: Input,
    ) => Promise<import('./types.ts').Outcome<Value>> | import('./types.ts').Outcome<Value>;
  },
) {
  assertName(definition.name, deriverName, 'deriver name');
  assertName(definition.slot, typeName, 'deriver slot type');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(definition.version)) {
    throw new Error('A deriver requires a safe version');
  }
  if (typeof definition.gather !== 'function' || typeof definition.derive !== 'function') {
    throw new Error('A deriver requires gather and derive functions');
  }
  return { ...definition, [declarationKind]: 'deriver' } as const;
}

export type DeriverDefinition = ReturnType<typeof defineDeriver>;

export function defineModule(definition: { readonly name: string }) {
  assertName(definition.name, moduleName, 'module name');
  return { ...definition, [declarationKind]: 'module' } as const;
}

export type ModuleDefinition = ReturnType<typeof defineModule>;

export function declarationOf(value: unknown, kind: DeclarationKind | 'module'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Expected a ${kind} declaration`);
  }
  const candidate = value as Record<PropertyKey, unknown>;
  if (candidate[declarationKind] !== kind) {
    throw new Error(`Expected a ${kind} declaration`);
  }
  return candidate;
}

export function validateCorrectableFields<Value>(
  definition: FactDefinition<Value>,
  fact: unknown,
): readonly string[] {
  const fields = definition.correctableFields?.(definition.schema.parse(fact)) ?? [];
  for (const field of fields) {
    if (!jsonPointer.test(field)) throw new Error(`Invalid JSON Pointer: ${field}`);
  }
  return fields;
}

export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === 'object' && Object.values(value).every(isJson);
}
