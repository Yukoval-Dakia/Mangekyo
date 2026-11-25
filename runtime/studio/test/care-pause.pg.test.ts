import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { slotType, stableId, studioLearner } from '../identity.ts';
import { openCarePause } from '../care-pause.ts';
import { factId, openClassrooms } from '../classroom.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
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

const f0 = { learner_id: studioLearner, purpose: ['teaching'] };
async function seedFact(tx: any, tick: any, id: string, type: string, data: unknown) {
  await tx.insert('facts', { ...f0, id, type, current_rev: 1, created_tick: tick, changed_tick: tick });
  await tx.insert('fact_revs', { ...f0, sticky: false, fact_id: id, rev: 1, kind: 'value', author: 'learner', command_id: id, tick, data: JSON.stringify(data) });
}
async function seedTurn(tx: any, tick: any, id: string, fb: string, turn: Record<string, unknown>, reply: Record<string, unknown>) {
  await seedFact(tx, tick, id, 'activity.studyTurn', { caseId: 'companion', model: 'm', baseUrl: 'http://x', ...turn });
  await tx.insert('derivations', { learner_id: studioLearner, id: fb, slot_type: slotType, slot_key: id, deriver: 'd', scope_keys: '{}', value: JSON.stringify({ action: 'companion_reply', model: 'm', ...reply }), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick, inputs: [] }) });
  await tx.insert('slot_state', { learner_id: studioLearner, slot_type: slotType, slot_key: id, current_id: fb, scope_keys: '{}' });
}

it.skipIf(!testDatabaseUrl)('isolates D10 carePause turns', () => withLearnerDatabase(studioLearner, async db => {
  const seed = (key: string, answer: string, crisis: boolean) => db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    const id = stableId('d10t', key);
    await seedTurn(tx, tick, id, stableId('d10f', key), { sessionId: id, parentId: null, answer }, crisis ? { carePause: { triggered: true } } : {});
    return id;
  }));
  const crisis = await seed('crisis', '我活不下去了', true), normal = await seed('normal', '讲讲双曲线渐近线', false);
  const list = await recentConversations(db), title = (id: string) => list.find(r => r.id === id)?.title;
  expect([title(crisis), title(normal)]).toEqual(['安全支持对话', expect.stringContaining('渐近线')]);
  const [crisisTurns, normalTurns] = await Promise.all([loadHistory(db, crisis), loadHistory(db, normal)]);
  expect([crisisTurns[0]?.backgroundUnderstanding, normalTurns[0]?.backgroundUnderstanding]).toEqual([undefined, expect.anything()]);
  const ai = await openTransparency(db).aiActivity();
  expect(ai.recentTools.some(t => t.turnId === crisis)).toBe(false); expect(ai.recentTools.some(t => t.turnId === normal)).toBe(true);
}));

it.skipIf(!testDatabaseUrl)('handles D10 carePause in classroom start and adjust', () => withLearnerDatabase(studioLearner, async db => {
  const k = (n: string) => stableId('d10c', n), s1 = k('s1'), s2 = k('s2'), s3 = k('s3'), f2 = k('f2'), a2 = k('a2');
  const c1 = factId(stableId('classroom', s1)), c2 = factId(stableId('classroom', s2));
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    await seedTurn(tx, tick, s1, k('f1'), { sessionId: s1, parentId: null, answer: 'x', classroom: { mode: 'start', evidence: [] } }, { carePause: { triggered: true } });
    await seedFact(tx, tick, c1, 'activity.classroom', { topic: '我活不下去了', minutes: 20, sessionId: s1, status: 'active', steps: [], plans: [], lastTurnId: s1, pending: { turnId: s1, kind: 'start' } });
    await seedTurn(tx, tick, s2, f2, { sessionId: s2, parentId: null, answer: 'x', classroom: { mode: 'start', evidence: [] } }, { classroomPlan: ['第一步'] });
    await seedTurn(tx, tick, a2, k('fa'), { sessionId: s2, parentId: s2, answer: 'x', classroom: { mode: 'adjust', evidence: [], noteOnly: true, evidenceTurn: s2 } }, { carePause: { triggered: true } });
    await seedFact(tx, tick, c2, 'activity.classroom', { topic: '微积分', minutes: 20, sessionId: s2, status: 'active', steps: [{ id: 'step-1', title: '第一步', status: 'active', turnId: s2 }], plans: [{ turnId: s2, derivationId: f2 }], lastTurnId: a2, pending: { turnId: a2, kind: 'adjust' } });
    await seedTurn(tx, tick, s3, k('f3'), { sessionId: s2, parentId: a2, answer: 'x', classroom: { mode: 'advance', evidence: [] } }, {});
  }));
  const rooms = openClassrooms(db, {} as never, {} as never), adj = await rooms.get(c2);
  expect(await rooms.get(c1)).toMatchObject({ carePause: true, generation: 'ready', steps: [], topic: '安全支持对话' });
  expect([adj.carePause, adj.adjustmentFailed, adj.steps.length, (await rooms.listActive()).items.length]).toEqual([true, undefined, 1, 0]);
  const commands = openClassrooms(db, await loadStudioTestModule('activity'), createStudioCommandHooks());
  await commands.mutate(c1, 'finish', { requestId: 'd10-finish-1', expectedRev: 1 });
  await commands.mutate(c1, 'archive', { requestId: 'd10-archive-1', expectedRev: 2 });
  expect(await rooms.get(c1)).toMatchObject({ status: 'archived', carePause: true, topic: '安全支持对话' });
  await db.tx({ learner: studioLearner }, tx => tx.withLearnerWrite(async tick => {
    const steps = [{ id: 'step-1', title: '第一步', status: 'presented', turnId: s2 }, { id: 'step-2', title: '第二步', status: 'active', turnId: s3 }];
    const data = { topic: '微积分', minutes: 20, sessionId: s2, status: 'active', steps, plans: [{ turnId: s2, derivationId: f2 }], lastTurnId: s3 };
    await tx.query('UPDATE facts SET current_rev=2,changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, c2]);
    await tx.insert('fact_revs', { ...f0, sticky: false, fact_id: c2, rev: 2, kind: 'value', author: 'learner', command_id: 'advance-1', tick, data: JSON.stringify(data) });
  }));
  expect(await rooms.get(c2)).toMatchObject({ carePause: true });
  expect((await rooms.listActive()).items).toEqual([]);
}));
