import {
  commandId,
  factId,
  type CommandId,
  type FactId,
  type Revision,
  type Tick,
} from '../declarations/ids.ts';
import { isJson } from '../declarations/define.ts';
import { canonicalJsonString } from './canonical.ts';
import type { FactRef, FactWrite, Json } from '../declarations/types.ts';
import type { DbTransaction } from '../db/types.ts';
import type { FactChange, FactRegistry, WriteOptions } from './contracts.ts';

type FactSchema = { parse(value: unknown): unknown };

type FactRow = {
  readonly type: string;
  readonly current_rev: number;
  readonly purpose: readonly string[];
  readonly sticky: boolean;
  readonly retracted_rev: number | null;
};

type PreparedWrite =
  | {
    readonly kind: 'create';
    readonly id: FactId;
    readonly factType: string;
    data: Json;
    readonly purpose: readonly string[];
  }
  | {
    readonly kind: 'correct';
    readonly id: FactId;
    readonly expectedRev: Revision;
    data: Json;
  }
  | {
    readonly kind: 'retract';
    readonly id: FactId;
    readonly expectedRev: Revision;
    data: null;
  }
  | {
    readonly kind: 'set_purpose';
    readonly id: FactId;
    readonly expectedRev: Revision;
    readonly purpose: readonly string[];
    data: Json;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFactSchema(value: unknown): value is FactSchema {
  return isRecord(value) && typeof value.parse === 'function';
}

function validatedRevision(value: unknown): Revision {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Fact revision must be a positive integer');
  }
  return value as Revision;
}

function validatePurpose(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const purpose = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    return entry;
  });
  if (new Set(purpose).size !== purpose.length) {
    throw new Error(`${label} entries must be unique`);
  }
  return purpose;
}

function validateJson(value: unknown, label: string): Json {
  canonicalJsonString(value);
  if (!isJson(value)) throw new Error(`${label} must be JSON`);
  return value;
}

function parseFactData(
  facts: FactRegistry,
  factType: string,
  data: unknown,
  label: string,
): Json {
  const declaration = facts.get(factType);
  if (!declaration) throw new Error(`Unknown fact type: ${factType}`);
  if (!isFactSchema(declaration.schema)) {
    throw new Error(`Fact type has no schema: ${factType}`);
  }
  return validateJson(declaration.schema.parse(validateJson(data, label)), `${label} schema result`);
}

function assertKnownFields(write: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(write).some((key) => !allowed.includes(key))) {
    throw new Error(`${write.kind} write has unknown fields`);
  }
}

function validateWrite(write: FactWrite, facts: FactRegistry, options: WriteOptions): PreparedWrite {
  if (!isRecord(write)) throw new Error('Each fact write must be an object');
  if (write.kind === 'create') {
    assertKnownFields(write, ['kind', 'id', 'factType', 'data', 'purpose']);
    if (typeof write.factType !== 'string' || !facts.has(write.factType)) {
      throw new Error('Create write must target a registry-owned fact type');
    }
    return {
      kind: 'create',
      id: factId(write.id),
      factType: write.factType,
      data: parseFactData(facts, write.factType, write.data, 'Create write data'),
      purpose: write.purpose === undefined ? ['all'] : validatePurpose(write.purpose, 'Create write purpose'),
    };
  }
  if (write.kind === 'correct') {
    assertKnownFields(write, ['kind', 'id', 'expectedRev', 'data']);
    if (options.actor !== 'learner') throw new Error('Correct writes are learner-only');
    return {
      kind: 'correct',
      id: factId(write.id),
      expectedRev: validatedRevision(write.expectedRev),
      data: validateJson(write.data, 'Correct write data'),
    };
  }
  if (write.kind === 'retract') {
    assertKnownFields(write, ['kind', 'id', 'expectedRev']);
    return {
      kind: 'retract',
      id: factId(write.id),
      expectedRev: validatedRevision(write.expectedRev),
      data: null,
    };
  }
  if (write.kind !== 'set_purpose') throw new Error('Unknown fact write kind');
  assertKnownFields(write, ['kind', 'id', 'expectedRev', 'purpose']);
  return {
    kind: 'set_purpose',
    id: factId(write.id),
    expectedRev: validatedRevision(write.expectedRev),
    purpose: validatePurpose(write.purpose, 'Set-purpose write purpose'),
    data: null,
  };
}

function factRow(row: unknown, id: FactId): FactRow {
  if (!isRecord(row)) throw new Error(`Fact does not exist: ${id}`);
  if (typeof row.type !== 'string') throw new Error('Fact type is invalid');
  if (
    typeof row.current_rev !== 'number'
    || !Number.isSafeInteger(row.current_rev)
    || row.current_rev < 1
  ) {
    throw new Error('Fact current revision is invalid');
  }
  if (typeof row.sticky !== 'boolean') throw new Error('Fact sticky flag is invalid');
  if (row.retracted_rev !== null && typeof row.retracted_rev !== 'number') {
    throw new Error('Fact retracted revision is invalid');
  }
  return {
    type: row.type,
    current_rev: row.current_rev,
    purpose: validatePurpose(row.purpose, 'Fact purpose'),
    sticky: row.sticky,
    retracted_rev: row.retracted_rev,
  };
}

function storedJson(value: unknown): Json {
  if (isJson(value)) return value;
  if (typeof value === 'string') {
    try {
      return validateJson(JSON.parse(value), 'Stored fact data');
    } catch (error) {
      if (error instanceof Error && error.message === 'Stored fact data must be JSON') throw error;
      throw new Error('Stored fact data is invalid JSON');
    }
  }
  throw new Error('Stored fact data is invalid');
}

async function readFactRow(tx: DbTransaction, id: FactId): Promise<FactRow | null> {
  const result = await tx.query<Record<string, unknown>>(
    `SELECT type, current_rev, purpose, sticky, retracted_rev
     FROM facts WHERE learner_id = $1 AND id = $2`,
    [tx.learner, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : factRow(row, id);
}

async function readCurrentData(tx: DbTransaction, id: FactId, rev: Revision): Promise<Json> {
  const result = await tx.query<{ data: unknown }>(
    `SELECT data FROM fact_revs
     WHERE learner_id = $1 AND fact_id = $2 AND rev = $3`,
    [tx.learner, id, rev],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Current fact revision is missing');
  return storedJson(row.data);
}

function validateOptions(options: WriteOptions): CommandId {
  if (options.actor !== 'learner' && options.actor !== 'companion') {
    throw new Error('Write actor is invalid');
  }
  if (typeof options.purpose !== 'string' || options.purpose.length === 0) {
    throw new Error('Write purpose must be a non-empty string');
  }
  return commandId(options.commandId);
}

export async function applyFactWrites(
  tx: DbTransaction,
  tick: Tick,
  writes: readonly FactWrite[],
  options: WriteOptions,
  facts: FactRegistry,
): Promise<readonly FactChange[]> {
  const auditedCommandId = validateOptions(options);
  if (!Array.isArray(writes)) throw new Error('Command writes must be an array');
  const initialWrites = writes;
  const validated = initialWrites.map((write) => validateWrite(write, facts, options));
  const seenFactIds = new Set<string>();
  for (const write of validated) {
    if (seenFactIds.has(write.id)) {
      throw new Error('A command cannot write the same fact more than once');
    }
    seenFactIds.add(write.id);
  }

  const rows = new Map<string, FactRow>();
  for (const write of validated) {
    const row = await readFactRow(tx, write.id);
    if (write.kind === 'create') {
      if (row !== null) throw new Error(`Fact already exists: ${write.id}`);
      continue;
    }
    if (row === null) throw new Error(`Fact does not exist: ${write.id}`);
    if (!facts.has(row.type)) throw new Error(`Fact type is not registry-owned: ${row.type}`);
    if (row.retracted_rev !== null) throw new Error(`Fact is retracted: ${write.id}`);
    if (row.current_rev !== write.expectedRev) throw new Error(`Fact revision conflict: ${write.id}`);
    const learnerManagement = options.actor === 'learner' && (write.kind === 'set_purpose' || write.kind === 'retract');
    if (!learnerManagement && !row.purpose.includes('all') && !row.purpose.includes(options.purpose)) {
      throw new Error(`Fact purpose does not allow this write: ${write.id}`);
    }
    if (write.kind === 'set_purpose') {
      const currentData = await readCurrentData(tx, write.id, validatedRevision(row.current_rev));
      write.data = currentData;
    }
    if (write.kind === 'correct') {
      write.data = parseFactData(facts, row.type, write.data, 'Correct write data');
    }
    rows.set(write.id, row);
  }

  const changes: FactChange[] = [];
  for (const write of validated) {
    if (write.kind === 'create') {
      await tx.insert('facts', {
        learner_id: tx.learner,
        id: write.id,
        type: write.factType,
        current_rev: 1,
        access_epoch: 0,
        purpose: write.purpose,
        sticky: false,
        retracted_rev: null,
        created_tick: tick,
        changed_tick: tick,
      });
      await tx.insert('fact_revs', {
        learner_id: tx.learner,
        fact_id: write.id,
        rev: 1,
        data: JSON.stringify(write.data),
        purpose: write.purpose,
        sticky: false,
        source_derivation_id: null,
        kind: 'value',
        author: options.actor,
        command_id: auditedCommandId,
        tick,
        corrects_rev: null,
      });
      changes.push({
        ref: { learner: tx.learner, id: write.id, rev: validatedRevision(1) },
        factType: write.factType,
        kind: 'create',
      });
      continue;
    }

    const row = rows.get(write.id);
    if (row === undefined) throw new Error(`Fact does not exist: ${write.id}`);
    const rev = row.current_rev + 1;
    const purpose = write.kind === 'set_purpose' ? write.purpose : row.purpose;
    const result = await tx.query(
      `UPDATE facts
       SET current_rev = $3,
           purpose = $4::text[],
           sticky = $5,
           retracted_rev = $6,
           access_epoch = access_epoch + CASE WHEN $7 THEN 1 ELSE 0 END,
           changed_tick = $8
       WHERE learner_id = $1 AND id = $2 AND current_rev = $9`,
      [
        tx.learner,
        write.id,
        rev,
        purpose,
        write.kind === 'correct' || row.sticky,
        write.kind === 'retract' ? rev : null,
        write.kind === 'retract' || write.kind === 'set_purpose',
        tick,
        row.current_rev,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Fact update conflict');
    await tx.insert('fact_revs', {
      learner_id: tx.learner,
      fact_id: write.id,
      rev,
      data: JSON.stringify(write.data),
      purpose,
      sticky: write.kind === 'correct' || row.sticky,
      source_derivation_id: null,
      kind: write.kind === 'retract' ? 'retraction' : 'value',
      author: options.actor,
      command_id: auditedCommandId,
      tick,
      corrects_rev: row.current_rev,
    });
    changes.push({
      ref: { learner: tx.learner, id: write.id, rev: validatedRevision(rev) },
      factType: row.type,
      kind: write.kind,
    });
  }
  return changes;
}
