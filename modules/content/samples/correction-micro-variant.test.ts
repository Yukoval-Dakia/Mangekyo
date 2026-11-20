import { FactNotFoundError, type FactId, type FactSnapshot, type ReadContext, type Tick } from '@mangekyo/kernel';
import { expect, test } from 'vitest';
import { createAuthorizedFactReader, FactReadDeniedError } from '../../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../../kernel/src/db/types.ts';
import { readEffectiveSlotVersion } from '../../../kernel/src/derivations/revalidate.ts';
import { withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { readActivityHelpEvents } from '../../activity/evidence-read.ts';
import { projectHelpExposure } from '../../activity/help-exposure.ts';
import { readCorrectionMicroVariant } from '../correction-micro-variant.ts';
import { questionStateId } from '../question-state.ts';
import { correctionMicroVariantFixture as fixture, seedCorrectionMicroVariant } from './fixtures/correction-micro-variant.ts';

const { learner, input, first, second } = fixture;
const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError;

function open(db: Db, options: {
  input?: typeof input;
  deny?: FactId;
  coverage?: boolean;
  cutoff?: Tick;
  failSlots?: boolean;
} = {}) {
  return db.snapshot({ learner }, async snapshot => {
    const sql: string[] = [];
    const tx: ReadTransaction = { ...snapshot, query(query, params) {
      sql.push(query);
      return snapshot.query(query, params);
    } };
    const { rows: [mode] } = await tx.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
    expect(mode?.transaction_read_only).toBe('on');
    const facts = createAuthorizedFactReader(tx, 'teaching', fact => fact.ref.id !== options.deny);
    const read: ReadContext = {
      async fact<Value>(id: FactId, opts: Parameters<ReadContext['fact']>[1]) {
        return await facts.fact(id, opts) as FactSnapshot<Value>;
      },
      async slot<Value>(ref: Parameters<ReadContext['slot']>[0]) {
        if (options.failSlots) throw new Error('verification read offline');
        const slot = await readEffectiveSlotVersion<Value>(tx, ref, fixture.deriver, 'teaching');
        if (!slot) throw new FactNotFoundError('No current verification');
        return slot.snapshot;
      },
      async range() { throw new Error('Unexpected range read'); },
    };
    const started = performance.now();
    const result = await readCorrectionMicroVariant({
      learner, purpose: 'teaching', recipient: learner, releaseUses: ['diagnose'], read, isUnavailable: unavailable,
      readExposure: async ({ candidate, archetype, familyId }) => {
        expect(archetype).toEqual({ learner, ...fixture.archetype });
        expect(familyId).toBe('average-speed');
        const cutoff = options.cutoff ?? '3' as Tick;
        const target = fixture.target({ id: candidate.id, rev: candidate.rev });
        const { events, omitted } = await readActivityHelpEvents(tx, read, {
          activities: [target.activityId], mode: 'following', cutoff,
        }, undefined, unavailable);
        return projectHelpExposure({ submission: { ref: candidate, target, cutoff }, events,
          coverage: options.coverage !== false && !omitted ? { submission: candidate, target, through: cutoff } : null });
      },
    }, options.input ?? input);
    const elapsed = performance.now() - started;
    expect(sql.every(query => /^(SELECT|SHOW)\b/i.test(query.trim()))).toBe(true);
    return { result, elapsed, queries: sql.length - 1 };
  });
}

test('selects one current unexposed single-condition variant using a read-only snapshot', async () => {
  await withLearnerDatabase(learner, async db => {
    await seedCorrectionMicroVariant(db);
    const onlySecond = { ...input, variantEdgeIds: [input.variantEdgeIds[1]!] };
    const onlyFirst = { ...input, variantEdgeIds: [input.variantEdgeIds[0]!] };
    expect((await open(db, { cutoff: '2' as Tick })).result).toEqual(first);
    expect((await open(db, { input: { ...input, variantEdgeIds: [...input.variantEdgeIds].reverse() }, cutoff: '2' as Tick })).result).toEqual(first);
    expect((await open(db, { input: onlyFirst })).result).toBeUndefined();
    expect((await open(db, { deny: second.id })).result).toBeUndefined();
    expect((await open(db, { deny: input.archetypeEdgeIds[2]! })).result).toBeUndefined();
    const unknown = await open(db, { coverage: false });
    expect(unknown.result).toBeUndefined();
    expect((await open(db, { deny: fixture.display.id, input: onlyFirst })).result).toBeUndefined();
    expect((await open(db, { input: { ...input, variantEdgeIds: [] } })).result).toBeUndefined();
    await expect(open(db, { failSlots: true })).rejects.toThrow('verification read offline');

    const runs = [];
    for (let iteration = 0; iteration < 11; iteration++) {
      const run = await open(db);
      expect(run.result).toEqual(second);
      runs.push(run);
    }
    const times = runs.map(run => run.elapsed).sort((a, b) => a - b);
    console.info('correction micro-variant PGlite fixture', { queries: runs[0]?.queries,
      medianMs: times[5]?.toFixed(2), maxMs: times.at(-1)?.toFixed(2),
      unknownQueries: unknown.queries, unknownMs: unknown.elapsed.toFixed(2) });

    await db.query(`UPDATE facts SET purpose='{storage}' WHERE id=$1`, [second.id]);
    expect((await open(db, { input: onlySecond })).result).toBeUndefined();
    await db.query(`UPDATE facts SET purpose='{teaching}' WHERE id=$1`, [second.id]);
    await db.query(`UPDATE fact_revs SET data=jsonb_set(data,'{variant,spoilsNext}','"former"') WHERE fact_id=$1`,
      [onlySecond.variantEdgeIds[0]!]);
    expect((await open(db, { input: onlySecond })).result).toBeUndefined();
    await db.query(`UPDATE fact_revs SET data=jsonb_set(data,'{variant,spoilsNext}','"latter"') WHERE fact_id=$1`,
      [onlySecond.variantEdgeIds[0]!]);
    expect((await open(db, { input: onlySecond })).result).toEqual(second);

    const state = await questionStateId(second.id);
    const { rows: [original] } = await db.query<{ data: unknown }>('SELECT data FROM fact_revs WHERE fact_id=$1', [state]);
    await db.query(`UPDATE fact_revs SET data=jsonb_set(data,'{restrictions}',$2) WHERE fact_id=$1`,
      [state, JSON.stringify([{ action: 'stop', scope: 'diagnose', reason: '暂停诊断' }])]);
    expect((await open(db, { input: onlySecond })).result).toBeUndefined();
    await db.query('UPDATE fact_revs SET data=$2 WHERE fact_id=$1', [state, JSON.stringify(original?.data)]);
    await db.query(`UPDATE derivations SET freshness='behind' WHERE slot_key LIKE $1`, [`${second.id}:%`]);
    expect((await open(db, { input: onlySecond })).result).toBeUndefined();
    await db.query(`UPDATE derivations SET freshness='current' WHERE slot_key LIKE $1`, [`${second.id}:%`]);
    await db.query(`UPDATE facts SET access_epoch=1 WHERE id=$1`, [second.id]);
    expect((await open(db, { input: onlySecond })).result).toBeUndefined();

    const { rows: [clock] } = await db.query<{ clock: string }>('SELECT clock::text FROM learners WHERE id=$1', [learner]);
    expect(clock?.clock).toBe('2');
  }, { postgres: false });
}, 20_000);
