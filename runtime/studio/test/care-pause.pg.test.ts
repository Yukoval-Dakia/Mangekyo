import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { slotType, stableId, studioLearner } from '../identity.ts';
import { openCarePause } from '../care-pause.ts';
import { recentConversations, loadHistory } from '../sessions.ts';
import { openTransparency } from '../transparency.ts';
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

it.skipIf(!testDatabaseUrl)('isolates D10 carePause turns', () => withLearnerDatabase(studioLearner, async db => {
  const seed = async (key: string, answer: string, crisis: boolean) => db.tx({learner: studioLearner}, tx => tx.withLearnerWrite(async tick => {
    const id = stableId('d10t', key), fb = stableId('d10f', key), f0 = {learner_id: studioLearner, purpose: ['teaching']};
    await tx.insert('facts', {...f0, id, type: 'activity.studyTurn', current_rev: 1, created_tick: tick, changed_tick: tick});
    await tx.insert('fact_revs', {...f0, sticky: false, fact_id: id, rev: 1, kind: 'value', author: 'learner', command_id: id, tick,
      data: JSON.stringify({sessionId: id, caseId: 'companion', parentId: null, answer, model: 'm', baseUrl: 'http://x'})});
    await tx.insert('derivations', {learner_id: studioLearner, id: fb, slot_type: slotType, slot_key: id, deriver: 'd', scope_keys: '{}',
      value: JSON.stringify({action: 'companion_reply', model: 'm', ...(crisis ? {carePause: {triggered: true}} : {})}),
      lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick,
      manifest: JSON.stringify({version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: []})});
    await tx.insert('slot_state', {learner_id: studioLearner, slot_type: slotType, slot_key: id, current_id: fb, scope_keys: '{}'});
    return id; }));
  const crisis = await seed('crisis', '我活不下去了', true), normal = await seed('normal', '讲讲双曲线渐近线', false);
  const list = await recentConversations(db), title = (id: string) => list.find(r => r.id === id)?.title;
  expect([title(crisis), title(normal)]).toEqual(['安全支持对话', expect.stringContaining('渐近线')]);
  const [crisisTurns, normalTurns] = await Promise.all([loadHistory(db, crisis), loadHistory(db, normal)]);
  expect([crisisTurns[0]?.backgroundUnderstanding, normalTurns[0]?.backgroundUnderstanding]).toEqual([undefined, expect.anything()]);
  const ai = await openTransparency(db).aiActivity();
  expect(ai.recentTools.some(t => t.turnId === crisis)).toBe(false); expect(ai.recentTools.some(t => t.turnId === normal)).toBe(true);
}));
