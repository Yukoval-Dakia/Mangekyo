import { FactNotFoundError } from '../declarations/read-errors.ts';
import { isJson } from '../declarations/define.ts';
import type { FactId, Revision, Tick } from '../declarations/ids.ts';
import type {
  DerivationSnapshot,
  FactSnapshot,
  Json,
  JsonObject,
  RangeSnapshot,
  ReadContext,
  SlotRef,
} from '../declarations/types.ts';
import type { ReadTransaction } from '../db/types.ts';

const factIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const tickPattern = /^(?:0|[1-9][0-9]*)$/;
const purposeAll = 'all';

export class InvalidReadRequestError extends Error {}
export { FactNotFoundError } from '../declarations/read-errors.ts';
export class UnsupportedReadError extends Error {}

export type FactReadDenial = 'purpose' | 'retracted' | 'recipient' | 'changed';

export class FactReadDeniedError extends Error {
  readonly reason: FactReadDenial;

  constructor(reason: FactReadDenial, message: string) {
    super(message);
    this.reason = reason;
  }
}

type FactReadOptions =
  | { readonly mode: 'pinned'; readonly rev: Revision }
  | { readonly mode: 'following' };

type ParsedFactOptions =
  | { readonly mode: 'following' }
  | { readonly mode: 'pinned'; readonly rev: number };

type FactRow = {
  readonly type: string;
  readonly current_rev: number;
  readonly access_epoch: string | bigint | number;
  readonly purpose: unknown;
  readonly retracted_rev: number | null;
};

type FactRevRow = {
  readonly rev: number;
  readonly data: unknown;
  readonly purpose: unknown;
  readonly kind: string;
};

function requirePurpose(purpose: string): string {
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new InvalidReadRequestError('Read purpose must be a non-empty string');
  }
  return purpose;
}

function requireFactId(id: FactId): FactId {
  if (typeof id !== 'string' || !factIdPattern.test(id)) {
    throw new InvalidReadRequestError('Fact id must be a ULID');
  }
  return id;
}

function requireRevision(rev: Revision): number {
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) {
    throw new InvalidReadRequestError('Fact revision must be a positive integer');
  }
  return rev;
}

function parseFactOptions(options: FactReadOptions): ParsedFactOptions {
  if (options === null || typeof options !== 'object') {
    throw new InvalidReadRequestError('Fact read options must be an object');
  }
  if (options.mode === 'following') {
    return { mode: 'following' };
  }
  if (options.mode === 'pinned') {
    return { mode: 'pinned', rev: requireRevision(options.rev) };
  }
  throw new InvalidReadRequestError('Fact read mode must be pinned or following');
}

function toTick(value: string | bigint | number): Tick {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Stored access epoch is negative');
    return value.toString() as Tick;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored access epoch is invalid');
    return String(value) as Tick;
  }
  if (typeof value === 'string' && tickPattern.test(value)) {
    return value as Tick;
  }
  throw new Error('Stored access epoch is invalid');
}

function toPurposeList(value: unknown, column: string): string[] {
  if (
    !Array.isArray(value)
    || !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`Stored ${column} is not a valid purpose list`);
  }
  return value as string[];
}

function purposeAllows(purposes: readonly string[], purpose: string): boolean {
  return purposes.includes(purposeAll) || purposes.includes(purpose);
}

async function readFact<Value = Json>(
  tx: ReadTransaction,
  purpose: string,
  id: FactId,
  options: FactReadOptions,
): Promise<FactSnapshot<Value>> {
  const factId = requireFactId(id);
  const parsed = parseFactOptions(options);

  const factResult = await tx.query<FactRow>(
    `SELECT type, current_rev, access_epoch, purpose, retracted_rev
     FROM facts
     WHERE learner_id = $1 AND id = $2`,
    [tx.learner, factId],
  );
  const fact = factResult.rows[0];
  if (fact === undefined) {
    throw new FactNotFoundError(`Fact ${factId} does not exist for this learner`);
  }
  if (fact.retracted_rev !== null) {
    throw new FactReadDeniedError('retracted', `Fact ${factId} is retracted`);
  }

  const targetRev = parsed.mode === 'following' ? fact.current_rev : parsed.rev;
  const revResult = await tx.query<FactRevRow>(
    `SELECT rev, data, purpose, kind
     FROM fact_revs
     WHERE learner_id = $1 AND fact_id = $2 AND rev = $3`,
    [tx.learner, factId, targetRev],
  );
  const revision = revResult.rows[0];
  if (revision === undefined) {
    if (parsed.mode === 'pinned') {
      throw new FactNotFoundError(`Fact ${factId} has no revision ${targetRev}`);
    }
    throw new Error(`Fact ${factId} current revision ${targetRev} is missing`);
  }
  if (revision.kind !== 'value') {
    throw new FactReadDeniedError(
      'retracted',
      `Fact ${factId} revision ${targetRev} is a retraction`,
    );
  }

  const currentPurpose = toPurposeList(fact.purpose, 'facts.purpose');
  const revisionPurpose = toPurposeList(revision.purpose, 'fact_revs.purpose');
  if (!purposeAllows(currentPurpose, purpose) || !purposeAllows(revisionPurpose, purpose)) {
    throw new FactReadDeniedError(
      'purpose',
      `Fact ${factId} does not allow read purpose ${purpose}`,
    );
  }

  const data: unknown = revision.data;
  if (!isJson(data)) {
    throw new Error(`Fact ${factId} revision ${targetRev} data is not valid JSON`);
  }

  return {
    ref: { learner: tx.learner, id: factId, rev: revision.rev as Revision },
    type: fact.type,
    accessEpoch: toTick(fact.access_epoch),
    value: data as Value,
    purpose: revisionPurpose,
  };
}

export function createCommandReadContext(tx: ReadTransaction, purpose: string): ReadContext {
  const allowedPurpose = requirePurpose(purpose);
  return {
    fact: <Value = Json>(id: FactId, options: FactReadOptions) =>
      readFact<Value>(tx, allowedPurpose, id, options),
    slot: async <Value = Json>(
      _ref: SlotRef,
      _options: { readonly mode: 'pinned' | 'following' | 'asof' },
    ): Promise<DerivationSnapshot<Value>> => {
      throw new UnsupportedReadError('slot reads are not implemented in this kernel unit');
    },
    range: async <Value = Json>(
      _slotType: string,
      _scope: JsonObject,
    ): Promise<RangeSnapshot<Value>> => {
      throw new UnsupportedReadError('range reads are not implemented in this kernel unit');
    },
  };
}

type FactWitness = {
  readonly id: FactId;
  readonly rev: number;
  readonly mode: FactReadOptions['mode'];
  readonly accessEpoch: Tick;
  readonly type?: string;
};

/** Execution-layer reader for a single snapshot or locked transaction. */
export function createAuthorizedFactReader(
  tx: ReadTransaction,
  purpose: string,
  maySend: (fact: FactSnapshot) => boolean,
) {
  const read = createCommandReadContext(tx, purpose);
  async function fact(id: FactId, options: FactReadOptions) {
    const snapshot = await read.fact(id, options);
    if (!maySend(snapshot)) throw new FactReadDeniedError('recipient', 'Fact is unavailable to the recipient');
    return snapshot;
  }
  return {
    fact,
    async reopen(witness: FactWitness) {
      const { id, mode, rev, accessEpoch, type } = witness;
      const snapshot = await fact(id, mode === 'pinned' ? {mode, rev: rev as Revision} : {mode});
      if (snapshot.ref.rev !== rev || snapshot.accessEpoch !== accessEpoch || (type !== undefined && snapshot.type !== type)) {
        throw new FactReadDeniedError('changed', 'Fact witness no longer matches');
      }
      return snapshot;
    },
  };
}
