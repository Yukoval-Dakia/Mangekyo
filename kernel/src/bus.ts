import type {Actor, CommandHandler} from './commands/contracts.ts';
import {
  FactNotFoundError, FactReadDeniedError, guardAccess, InvalidReadRequestError, type FactAccessActor,
} from './commands/reads.ts';
import type {Db, LearnerScope, ReadTransaction} from './db/types.ts';
import type {FactId} from './declarations/ids.ts';
import type {FactSnapshot} from './declarations/types.ts';
import type {BusMutation, BusQuery, BusReadResult, BusRef, BusWitness, PipelineBus} from './pipeline-contracts.ts';

export {guardAccess} from './commands/reads.ts';

type Project<T> = (snapshot: FactSnapshot) => T | undefined;
type BusActor<T, Preset extends string> = FactAccessActor & {
  readonly actor: Actor;
  readonly defaultPreset: Preset;
  readonly presets: ReadonlyMap<Preset, Project<T>>;
};

function readScope<T, Preset extends string>(tx: ReadTransaction, actor: BusActor<T, Preset>) {
  function projection(preset: Preset) {
    const project = actor.presets.get(preset);
    if (!project) throw new InvalidReadRequestError('Unknown read preset');
    return project;
  }

  async function open(ref: BusRef, project: Project<T>) {
    const snapshot = await guardAccess(tx, ref, actor);
    const item = project(snapshot);
    if (item === undefined) throw new FactReadDeniedError('recipient', 'Fact is unavailable in this preset');
    const witness: BusWitness = {
      ...snapshot.ref, type: snapshot.type, accessEpoch: snapshot.accessEpoch, mode: ref.mode,
    };
    return {item, witness};
  }

  async function resolve(refs: readonly BusRef[], preset: Preset): Promise<BusReadResult<T>> {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 8) {
      throw new InvalidReadRequestError('Resolve requires one to eight references');
    }
    const project = projection(preset);
    const items: T[] = [];
    const witnesses: BusWitness[] = [];
    for (const ref of refs) {
      const {item, witness} = await open(ref, project);
      items.push(item);
      witnesses.push(witness);
    }
    return {items, witnesses};
  }

  async function query(filter: BusQuery): Promise<BusReadResult<T>> {
    if (!filter || typeof filter !== 'object' || Object.keys(filter).some(key => key !== 'types' && key !== 'limit') ||
        !Array.isArray(filter.types) || !filter.types.every(type => typeof type === 'string' && type.length > 0)) {
      throw new InvalidReadRequestError('Query requires a fact type filter');
    }
    const limit = filter.limit === undefined ? 20 : filter.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidReadRequestError('Query limit must be between one and 100');
    }
    const project = projection(actor.defaultPreset);
    const items: T[] = [];
    const witnesses: BusWitness[] = [];
    let after: FactId | null = null;
    while (items.length < limit) {
      const {rows}: {rows: readonly {id: FactId}[]} = await tx.query(
        `SELECT id FROM facts WHERE learner_id=$1 AND type=ANY($2::text[])
           AND retracted_rev IS NULL AND purpose && ARRAY[$3,'all']::text[]
           AND ($4::text IS NULL OR id>$4) ORDER BY id LIMIT $5`,
        [tx.learner, filter.types, actor.purpose, after, limit],
      );
      for (const {id} of rows) {
        try {
          const {item, witness} = await open({id, mode:'following'}, project);
          items.push(item);
          witnesses.push(witness);
          if (items.length === limit) break;
        } catch (error) {
          if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
        }
      }
      if (rows.length < limit) break;
      after = rows[rows.length - 1]!.id;
    }
    return {items, witnesses};
  }

  return {query, resolve};
}

type HostScope = LearnerScope & {readonly db: Db};

export function createBusScope<T, Preset extends string>(tx: ReadTransaction, actor: BusActor<T, Preset>):
  Pick<PipelineBus<T, Preset>, 'query' | 'resolve'>;
export function createBusScope<T, Preset extends string>(host: HostScope, actor: BusActor<T, Preset>, handle: CommandHandler):
  PipelineBus<T, Preset>;
export function createBusScope<T, Preset extends string>(host: ReadTransaction | HostScope, actor: BusActor<T, Preset>, handle?: CommandHandler) {
  if (!('db' in host)) return readScope(host, actor);
  if (!handle) throw new Error('A writable bus requires the host command handler');
  const {db, learner} = host;
  const scope = {learner};
  return {
    query: (filter: BusQuery) => db.snapshot(scope, tx => readScope(tx, actor).query(filter)),
    resolve: (refs: readonly BusRef[], preset: Preset) =>
      db.snapshot(scope, tx => readScope(tx, actor).resolve(refs, preset)),
    mutate: ({id, type, input}: BusMutation) =>
      handle({learner, actor: actor.actor, purpose: actor.purpose, id, type, input}),
  };
}
