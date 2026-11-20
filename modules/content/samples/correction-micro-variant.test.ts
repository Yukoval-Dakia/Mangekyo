import { FactNotFoundError, type FactId, type ReadContext, type Tick } from '@mangekyo/kernel';
import { readCorrectionMicroVariant } from '@mangekyo/module-content/facts/correction-micro-variant';
import { expect, test } from 'vitest';
import { createAuthorizedFactReader, createCommandReadContext, FactReadDeniedError } from '../../../kernel/src/commands/reads.ts';
import { readEffectiveSlotVersion } from '../../../kernel/src/derivations/revalidate.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { readActivityHelpEvents } from '../../activity/evidence-read.ts';
import { projectHelpExposure } from '../../activity/help-exposure.ts';
import { correctionMicroVariantFixture as fixture, seedCorrectionMicroVariant } from './fixtures/correction-micro-variant.ts';

const { learner, input, first, second, display } = fixture;
const unavailable = (error: unknown) => error instanceof FactNotFoundError || error instanceof FactReadDeniedError;

test('selects one current unexposed numbers-only variant using a read-only snapshot', () =>
  withLearnerDatabase(learner, async db => {
    const command = await seedCorrectionMicroVariant(db);
    const clock = async () => (await db.query<{ clock: Tick }>('SELECT clock::text FROM learners WHERE id=$1', [learner])).rows[0]!.clock;
    const displayTick = await clock();
    const open = (options: {
      deny?: FactId;
      coverage?: boolean;
      cutoff?: Tick;
      failSlots?: boolean;
    } = {}, patch: Partial<Parameters<typeof readCorrectionMicroVariant>[1]> = {}) => db.snapshot({ learner }, async tx => {
      expect((await tx.query('SHOW transaction_read_only')).rows).toEqual([{ transaction_read_only: 'on' }]);
      const cutoff = options.cutoff ?? String(BigInt(displayTick) + 1n) as Tick;
      const readFact = (purpose: string) =>
        createAuthorizedFactReader(tx, purpose, fact => fact.ref.id !== options.deny).fact as ReadContext['fact'];
      return readCorrectionMicroVariant({
        learner, purpose: 'teaching', recipient: learner, releaseUses: ['diagnose'], isUnavailable: unavailable,
        read: { fact: readFact('teaching'), async slot<Value>(ref: Parameters<ReadContext['slot']>[0]) {
          if (options.failSlots) throw new Error('verification read offline');
          const slot = await readEffectiveSlotVersion<Value>(tx, ref, fixture.deriver, 'teaching');
          if (!slot) throw new FactNotFoundError('No current verification');
          return slot.snapshot;
        } },
        async readExposure({ candidate, archetype, familyId }) {
          expect(archetype).toEqual({ learner, ...fixture.archetype });
          expect(familyId).toBe('average-speed');
          const target = fixture.target(candidate);
          const read = { ...createCommandReadContext(tx, 'storage'), fact: readFact('storage') };
          const { events, omitted } = await readActivityHelpEvents(tx, read, {
            activities: [target.activityId], mode: 'following', cutoff,
          }, undefined, unavailable);
          return projectHelpExposure({ submission: { ref: candidate, target, cutoff }, events,
            coverage: options.coverage !== false && !omitted ? { submission: candidate, target, through: cutoff } : null });
        },
      }, { ...input, ...patch });
    });

    const [firstEdge, secondEdge] = input.variantEdgeIds;
    const onlyFirst = { variantEdgeIds: [firstEdge] };
    expect(await open({ cutoff: displayTick })).toEqual(first);
    expect(await open({ cutoff: displayTick }, { variantEdgeIds: [secondEdge, firstEdge] })).toEqual(first);
    expect(await open()).toEqual(second);
    expect(await open({}, onlyFirst)).toBeUndefined();
    expect(await open({ deny: second.id })).toBeUndefined();
    expect(await open({ deny: input.archetypeEdgeIds[2] })).toBeUndefined();
    expect(await open({ coverage: false })).toBeUndefined();
    expect(await open({ deny: display.id }, onlyFirst)).toBeUndefined();
    expect(await open({}, { variantEdgeIds: [] })).toBeUndefined();
    await expect(open({ failSlots: true })).rejects.toThrow('verification read offline');
    expect(await open({}, { source: { ...input.source, accessEpoch: '1' as Tick } })).toBeUndefined();
    expect(await clock()).toBe(displayTick);

    for (const [field, value, expected] of [
      ['relation', 'single_condition', undefined],
      ['relation', 'representation_transfer', undefined],
      ['relation', 'numbers_only', second],
      ['spoilsNext', 'former', undefined],
      ['spoilsNext', 'latter', second],
    ] as const) {
      await db.query("UPDATE fact_revs SET data=jsonb_set(data,ARRAY['variant',$2],to_jsonb($3::text)) WHERE fact_id=$1",
        [secondEdge, field, value]);
      expect(await open(), value).toEqual(expected);
    }

    await command('content.disposeQuestion', { id: first.id, expectedRev: first.rev, stateRev: 1,
      disposition: { action: 'stop', scope: 'diagnose', reason: '暂停诊断' } }, '130');
    expect(await open({ cutoff: displayTick }, onlyFirst)).toBeUndefined();
    await db.query("UPDATE derivations SET freshness='behind' WHERE id=$1", [second.id]);
    expect(await open()).toBeUndefined();
    await db.query("UPDATE derivations SET freshness='current' WHERE id=$1", [second.id]);
    await db.query("UPDATE facts SET purpose='{storage}' WHERE id=$1", [second.id]);
    expect(await open()).toBeUndefined();
    await db.query("UPDATE facts SET purpose='{storage,teaching}', access_epoch=1 WHERE id=$1", [second.id]);
    expect(await open()).toBeUndefined();
  }, { postgres: Boolean(testDatabaseUrl) }), 20_000);
