import type {
  CommandId,
  DerivationId,
  FactId,
  LearnerId,
  Revision,
  Tick,
} from './ids.ts';

export type Json = null | boolean | number | string | readonly Json[] | {
  readonly [key: string]: Json;
};

export type JsonObject = { readonly [key: string]: Json };
export type ValueSchema<Value> = { parse(value: unknown): Value };
export type Outcome<Value> =
  | { readonly kind: 'value'; readonly value: Value }
  | { readonly kind: 'unknown'; readonly reason: string };

export type FactRef = {
  readonly learner: LearnerId;
  readonly id: FactId;
  readonly rev: Revision;
};

export type SlotRef = {
  readonly learner: LearnerId;
  readonly type: string;
  readonly key: string;
};

export type FactSnapshot<Value = Json> = {
  readonly type: string;
  readonly ref: FactRef;
  readonly accessEpoch: Tick;
  readonly equivalentSince?: { readonly purpose: string; readonly rev: Revision };
  readonly value: Value;
  readonly purpose: readonly string[];
};

export type DerivationSnapshot<Value = Json> = {
  readonly id: DerivationId;
  readonly slot: SlotRef;
  readonly outcome: Outcome<Value>;
};

export type RangeSnapshot<Value = Json> = {
  readonly watermark: Tick;
  readonly members: readonly DerivationSnapshot<Value>[];
};

export type FactReadOptions =
  | { readonly mode: 'pinned'; readonly rev: Revision; readonly requirePurpose?: string }
  | { readonly mode: 'following' };

export type ReadContext = {
  fact<Value = Json>(
    id: FactId,
    options: FactReadOptions,
  ): Promise<FactSnapshot<Value>>;
  slot<Value = Json>(
    ref: SlotRef,
    options: { readonly mode: 'pinned' | 'following' | 'asof' },
  ): Promise<DerivationSnapshot<Value>>;
  range<Value = Json>(
    slotType: string,
    scope: JsonObject,
  ): Promise<RangeSnapshot<Value>>;
};

export type WaitTarget =
  | { readonly kind: 'fact'; readonly ref: FactRef }
  | { readonly kind: 'slot'; readonly ref: SlotRef }
  | { readonly kind: 'range'; readonly slotType: string; readonly scope: JsonObject };

export type Waiting = {
  readonly kind: 'waiting';
  readonly targets: readonly [WaitTarget, ...WaitTarget[]];
};

export type GatherInput<Data extends Json> = {
  readonly kind: 'input';
  readonly data: Data;
  readonly effects: readonly EffectRequest[];
};

export type GatherContext = {
  readonly learner: LearnerId;
  readonly snapshotTick: Tick;
  readonly read: ReadContext;
};

export type EffectRequest = {
  readonly stepKey: string;
  readonly label: string;
  readonly input: Json;
};

export type EffectReceipt = {
  readonly request: EffectRequest;
  readonly state: 'done' | 'unknown';
  readonly result?: Json;
};

export type CommandInput = {
  readonly type: string;
  readonly input: Json;
};

export type FactWrite =
  | {
    readonly kind: 'create';
    readonly id: FactId;
    readonly factType: string;
    readonly data: Json;
    readonly purpose?: readonly string[];
  }
  | {
    readonly kind: 'correct' | 'revise';
    readonly id: FactId;
    readonly expectedRev: Revision;
    readonly data: Json;
  }
  | { readonly kind: 'retract'; readonly id: FactId; readonly expectedRev: Revision }
  | {
    readonly kind: 'set_purpose';
    readonly id: FactId;
    readonly expectedRev: Revision;
    readonly purpose: readonly string[];
    readonly scopedPurpose?: string;
  };

export type CommandContext = {
  readonly learner: LearnerId;
  readonly read: ReadContext;
};

export type CommandReceipt = {
  readonly commandId: CommandId;
  readonly state: 'done' | 'undone' | 'proposed' | 'rejected';
  readonly wrote: readonly FactRef[];
  readonly proposals: readonly CommandId[];
  readonly scopedPurposeChanges?: readonly { readonly id: FactId; readonly rev: Revision; readonly purpose: string }[];
  readonly output?: Json;
};
