import { FactNotFoundError } from '../declarations/read-errors.ts';
import { isJson } from '../declarations/define.ts';
import type { FactId, LearnerId, Revision, Tick } from '../declarations/ids.ts';
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
import { followingRevisionFloor } from './purpose-witness.ts';

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
  readonly rev: number | null;
  readonly data: unknown;
  readonly revision_purpose: unknown;
  readonly kind: string;
  readonly equivalent_rev: number;
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

async function readFact(
  tx: ReadTransaction,
  purpose: string,
  id: FactId,
  options: FactReadOptions,
): Promise<FactSnapshot> {
  const factId = requireFactId(id);
  const parsed = parseFactOptions(options);

  const factResult = await tx.query<FactRow>(
    `SELECT f.type, f.current_rev, f.access_epoch, f.purpose, f.retracted_rev,
            r.rev, r.kind, r.purpose AS revision_purpose, r.data,
            CASE WHEN $3::integer IS NULL THEN ${followingRevisionFloor('f', '$4::text')}
              ELSE f.current_rev END AS equivalent_rev
     FROM facts f LEFT JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev) =
       (f.learner_id,f.id,COALESCE($3::integer, f.current_rev))
     WHERE f.learner_id=$1 AND f.id=$2 AND NOT EXISTS
       (SELECT 1 FROM tombstones WHERE learner_id=$1 AND kind='fact' AND id=$2)`,
    [tx.learner, factId, parsed.mode === 'pinned' ? parsed.rev : null, purpose],
  );
  const fact = factResult.rows[0];
  if (fact === undefined) {
    throw new FactNotFoundError(`Fact ${factId} does not exist for this learner`);
  }
  if (fact.retracted_rev !== null) {
    throw new FactReadDeniedError('retracted', `Fact ${factId} is retracted`);
  }

  const targetRev = parsed.mode === 'following' ? fact.current_rev : parsed.rev;
  if (fact.rev === null) {
    if (parsed.mode === 'pinned') {
      throw new FactNotFoundError(`Fact ${factId} has no revision ${targetRev}`);
    }
    throw new Error(`Fact ${factId} current revision ${targetRev} is missing`);
  }
  if (fact.kind !== 'value') {
    throw new FactReadDeniedError(
      'retracted',
      `Fact ${factId} revision ${targetRev} is a retraction`,
    );
  }

  const currentPurpose = toPurposeList(fact.purpose, 'facts.purpose');
  const revisionPurpose = toPurposeList(fact.revision_purpose, 'fact_revs.purpose');
  if (!purposeAllows(currentPurpose, purpose) || !purposeAllows(revisionPurpose, purpose)) {
    throw new FactReadDeniedError(
      'purpose',
      `Fact ${factId} does not allow read purpose ${purpose}`,
    );
  }

  const data = fact.data;
  if (!isJson(data)) {
    throw new Error(`Fact ${factId} revision ${targetRev} data is not valid JSON`);
  }

  return {
    ref: { learner: tx.learner, id: factId, rev: fact.rev as Revision },
    type: fact.type,
    accessEpoch: toTick(fact.access_epoch),
    ...(parsed.mode === 'following' && fact.equivalent_rev < fact.rev
      ? {equivalentSince: {purpose, rev: fact.equivalent_rev as Revision}} : {}),
    value: data,
    purpose: revisionPurpose,
  };
}

export function createCommandReadContext(tx: ReadTransaction, purpose: string): ReadContext {
  const actor = {purpose: requirePurpose(purpose), maySend: () => true};
  return {
    fact: <Value = Json>(id: FactId, options: FactReadOptions) =>
      guardAccess(tx, {...options, id}, actor) as Promise<FactSnapshot<Value>>,
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

export type FactAccessActor = {
  readonly purpose: string;
  readonly maySend: (fact: FactSnapshot) => boolean;
};

export type FactAccessRef = {
  readonly id: FactId;
  readonly learner?: LearnerId;
  readonly accessEpoch?: Tick;
  readonly type?: string;
} & (
  | {readonly mode: 'following'; readonly rev?: number}
  | {readonly mode: 'pinned'; readonly rev: number}
);

/** The host binds the learner transaction, purpose and recipient before accepting a reference. */
export async function guardAccess(tx: ReadTransaction, ref: FactAccessRef, actor: FactAccessActor) {
  if (!ref || typeof ref !== 'object') throw new InvalidReadRequestError('Expected a fact reference');
  if (ref.learner !== undefined && ref.learner !== tx.learner) {
    throw new FactReadDeniedError('recipient', 'Fact is unavailable to the recipient');
  }
  const options = ref.mode === 'pinned' ? {mode: ref.mode, rev: ref.rev as Revision} : {mode: ref.mode};
  const snapshot = await readFact(tx, requirePurpose(actor.purpose), ref.id, options);
  if (actor.maySend(snapshot) !== true) {
    throw new FactReadDeniedError('recipient', 'Fact is unavailable to the recipient');
  }
  if ((ref.accessEpoch !== undefined && snapshot.accessEpoch !== ref.accessEpoch) ||
      (ref.rev !== undefined && snapshot.ref.rev !== ref.rev) ||
      (ref.type !== undefined && snapshot.type !== ref.type)) {
    throw new FactReadDeniedError('changed', 'Fact witness no longer matches');
  }
  return snapshot;
}

/** Execution-layer reader for a single snapshot or locked transaction. */
export function createAuthorizedFactReader(
  tx: ReadTransaction,
  purpose: string,
  maySend: (fact: FactSnapshot) => boolean,
) {
  const actor = {purpose: requirePurpose(purpose), maySend};
  return {
    fact: (id: FactId, options: FactReadOptions) => guardAccess(tx, {...options, id}, actor),
    async reopen(witness: FactWitness) {
      if (witness.rev === undefined || witness.accessEpoch === undefined) {
        throw new InvalidReadRequestError('Reopening a witness requires revision and access epoch');
      }
      return guardAccess(tx, witness, actor);
    },
  };
}
