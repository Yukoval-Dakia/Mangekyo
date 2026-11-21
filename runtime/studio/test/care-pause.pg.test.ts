import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { studioLearner } from '../identity.ts';
import { openCarePause } from '../care-pause.ts';
import { carePauseScope, carePauseTtlMs } from '../../../modules/companion/care-pause.ts';
import { loadStudioTestModule } from './modules.ts';

it.skipIf(!testDatabaseUrl)('records a short-lived removable care pause gate and resumes', () =>
  withLearnerDatabase(studioLearner, async db => {
    const companion = await loadStudioTestModule('companion');
    const gate = openCarePause(db, companion);
    expect((await gate.read()).active).toBe(false);

    const paused = await gate.pause('turn-1');
    expect(paused).toMatchObject({ active: true, scope: carePauseScope });
    expect(Date.parse(paused.expiresAt!) - Date.now()).toBeLessThanOrEqual(carePauseTtlMs);
    expect(JSON.stringify(paused)).not.toContain('turn-1');

    await expect(db.snapshot({ learner: studioLearner }, tx => gate.paused(tx))).resolves.toBe(true);
    // A second signal inside the TTL does not extend or duplicate the gate.
    await expect(gate.pause('turn-2')).resolves.toMatchObject({ revision: paused.revision });

    const resumed = await gate.resume();
    expect(resumed.active).toBe(false);
    await expect(db.snapshot({ learner: studioLearner }, tx => gate.paused(tx))).resolves.toBe(false);
    await expect(gate.resume()).resolves.toMatchObject({ active: false });

    await gate.pause('turn-3');
    const past = Date.now() + carePauseTtlMs + 1000;
    await expect(db.snapshot({ learner: studioLearner }, tx => gate.status(tx, past))).resolves.toMatchObject({ active: false });
  }));
