import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { factId } from '../../../kernel/src/declarations/ids.ts';
import { runCodeSandbox } from '../../../executors/code-sandbox/index.ts';
import { builtInStudyMethodTemplateById, instantiateStudyMethodPlan, parseStudyMethodTemplate } from '../../../modules/content/study-method-template.ts';
import { evaluateCodeSandboxCriterion } from '../../../modules/activity/code-sandbox-assessment.ts';
import { assessmentSubmission } from '../../../modules/activity/assessment-values.ts';
import { validateBankItem } from '../../../modules/activity/question-assessment.ts';
import { summarizeRetentionReplay } from '../../../modules/learner/retention-replay.ts';
import { workbookAttemptType } from '../../../modules/activity/workbook-values.ts';
import { calcOutputDigest, freezeCalcBindingsForMount } from '../../../modules/content/calc-binding-host.ts';
import { stableId, studioLearner } from '../identity.ts';
import { openClassrooms } from '../classroom.ts';
import { mountArtifact, turnArtifacts } from '../presentation-store.ts';
import { openCarePause } from '../care-pause.ts';
import { retentionComparisonWork } from '../retention-comparison.ts';
import { workbookAssessmentSlot } from '../workbook-assessment.ts';
import { serve } from '../http.ts';
import { w5RoutePack } from '../w5-routes.ts';
import { createStudioCommandHooks } from '../command-hooks.ts';
import { loadStudioTestModule } from './modules.ts';

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject).listen(0, '127.0.0.1', () => {
    const addr = probe.address();
    probe.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
  });
});

const f0 = { learner_id: studioLearner, purpose: ['teaching'] };
async function seedFact(tx: any, tick: any, id: string, type: string, data: unknown, rev = 1) {
  await tx.insert('facts', { ...f0, id, type, current_rev: rev, created_tick: tick, changed_tick: tick });
  await tx.insert('fact_revs', { ...f0, sticky: false, fact_id: id, rev: 1, kind: 'value', author: 'learner', command_id: id, tick, data: JSON.stringify(data) });
}
async function seedTurn(tx: any, tick: any, id: string, fb: string, turn: Record<string, unknown>, reply: Record<string, unknown>) {
  await seedFact(tx, tick, id, 'activity.studyTurn', { caseId: 'companion', model: 'm', baseUrl: 'http://x', ...turn });
  await tx.insert('derivations', { learner_id: studioLearner, id: fb, slot_type: 'activity.teachingFeedback', slot_key: id, deriver: 'd', scope_keys: '{}', value: JSON.stringify({ action: 'companion_reply', model: 'm', ...reply }), lifecycle: 'effective', freshness: 'current', gather_tick: tick, effective_tick: tick, manifest: JSON.stringify({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: String(tick), inputs: [] }) });
  await tx.insert('slot_state', { learner_id: studioLearner, slot_type: 'activity.teachingFeedback', slot_key: id, current_id: fb, scope_keys: '{}' });
}

const step = (n: number, kind: string, blocksSpoiler = false) => ({
  stepId: `s${n}`, kind, title: `第${n}步`, promptHint: `提示${n}`, observationRequired: true, blocksSpoiler,
});
const templatePayload = (overrides: Record<string, unknown> = {}) => ({
  templateId: 'w5_custom_method', version: 1, name: '预测独立检验', goal: '先独立预测再核验',
  disciplineTags: ['数学'], steps: [step(1, 'predict'), step(2, 'independent_check', true)],
  observationRequirements: ['作答结果'], author: 'learner', ...overrides,
});
const invariantViolationPayload = () => ({
  ...templatePayload({ steps: [step(1, 'teach_companion'), step(2, 'reflection_summary')] }),
});

type Api = (method: string, path: string, payload?: unknown) => Promise<{ status: number; body: any }>;
async function startW5Server(db: any, deps: { retentionComparison: any; pythonHost?: any }): Promise<{ api: Api; close: () => Promise<void> }> {
  const companion = await loadStudioTestModule('companion');
  const activity = await loadStudioTestModule('activity');
  const carePause = openCarePause(db, companion);
  const classrooms = openClassrooms(db, activity, createStudioCommandHooks());
  const pack = w5RoutePack(db, {
    retentionComparison: deps.retentionComparison, assessmentSlotType: workbookAssessmentSlot,
    ...(deps.pythonHost === undefined ? {} : { pythonHost: deps.pythonHost }),
  });
  const port = await freePort();
  const server = serve(db, { classrooms } as never, {} as never, {} as never, { carePause, routePacks: [pack] } as never, port);
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const api: Api = async (method, path, payload) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, payload === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { api, close: () => new Promise(resolve => server.close(() => resolve())) };
}

it.skipIf(!testDatabaseUrl)('W5 host: study-method template library, chain, undo and classroom freeze', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const { api, close } = await startW5Server(db, { retentionComparison: { get: async () => undefined } });
    try {
      const initial = await api('GET', '/api/study-method-templates');
      expect(initial.status).toBe(200);
      expect(initial.body.templates.map((t: any) => t.templateId).sort()).toEqual(
        Object.keys(builtInStudyMethodTemplateById).sort());

      const violation = await api('POST', '/api/study-method-templates', invariantViolationPayload());
      expect([violation.status, violation.body?.code]).toEqual([400, 'study_method_invariant']);

      const payload = templatePayload();
      const saved = await api('POST', '/api/study-method-templates', payload);
      expect(saved.status).toBe(200);
      expect(saved.body.undoToken).toBe('undo:method-template:w5_custom_method:v1:create');
      expect(saved.body.template.version).toBe(1);

      const replay = await api('POST', '/api/study-method-templates', payload);
      expect(replay.status).toBe(200);
      expect(replay.body.undoToken).toBe(saved.body.undoToken);

      const divergent = await api('POST', '/api/study-method-templates', templatePayload({ name: '另一内容' }));
      expect(divergent.status).toBe(409);
      const wrongChain = await api('POST', '/api/study-method-templates',
        templatePayload({ version: 3, replacesVersion: 2, name: '链错误' }));
      expect(wrongChain.status).toBe(409);

      const listed = await api('GET', '/api/study-method-templates');
      const custom = listed.body.templates.find((t: any) => t.templateId === 'w5_custom_method');
      expect(custom).toMatchObject({ version: 1, name: '预测独立检验' });

      const v2Payload = templatePayload({ version: 2, replacesVersion: 1, name: '预测独立检验第二版' });
      const v2 = await api('POST', '/api/study-method-templates', v2Payload);
      expect(v2.status).toBe(200);
      expect(v2.body.undoToken).toBe('undo:method-template:w5_custom_method:v2:from-v1');

      const sessionId = stableId('w5c', 's1'), classroomId = factId(stableId('classroom', sessionId));
      const frozenPlan = instantiateStudyMethodPlan(parseStudyMethodTemplate(saved.body.template), {
        instanceId: 'w5-plan-1', instantiatedAtIso: '2026-01-01T00:00:00.000Z',
      });
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await seedTurn(tx, tick, sessionId, stableId('w5c', 'fb1'), { sessionId, parentId: null, answer: 'x', classroom: { mode: 'start', evidence: [] } }, { classroomPlan: ['第一步：先独立预测'] });
        await seedFact(tx, tick, classroomId, 'activity.classroom', {
          topic: '函数单调性', minutes: 20, sessionId, status: 'active', steps: [], plans: [],
          lastTurnId: sessionId, studyMethodPlan: frozenPlan, pending: { turnId: sessionId, kind: 'start' },
        });
      }));
      const read1 = await api('GET', `/api/classrooms/${classroomId}`);
      expect(read1.status).toBe(200);
      expect(read1.body.studyMethodPlan).toEqual(frozenPlan);

      const undoV2 = await api('POST', '/api/study-method-templates/undo', { undoToken: v2.body.undoToken });
      expect(undoV2.status).toBe(200);
      expect(undoV2.body).toMatchObject({ status: 'undone', templateId: 'w5_custom_method', restoredVersion: 1 });
      const undoV2Replay = await api('POST', '/api/study-method-templates/undo', { undoToken: v2.body.undoToken });
      expect(undoV2Replay.status).toBe(200);
      const undoV2Repeat = await api('POST', '/api/study-method-templates/undo', { undoToken: v2.body.undoToken, requestId: 'w5-undo-again-1' });
      expect(undoV2Repeat.status).toBe(409);

      const undoV1 = await api('POST', '/api/study-method-templates/undo', { undoToken: saved.body.undoToken });
      expect(undoV1.status).toBe(200);
      expect(undoV1.body).toMatchObject({ status: 'undone', restoredVersion: null });
      const finalList = await api('GET', '/api/study-method-templates');
      expect(finalList.body.templates.some((t: any) => t.templateId === 'w5_custom_method')).toBe(false);

      const undoBuiltIn = await api('POST', '/api/study-method-templates/undo',
        { undoToken: 'undo:method-template:predict_counterexample_check:v1:create' });
      expect(undoBuiltIn.status).toBe(409);
      const undoUnknown = await api('POST', '/api/study-method-templates/undo', { undoToken: 'undo:method-template:no_such_template:v9:create' });
      expect(undoUnknown.status).toBe(404);

      const read2 = await api('GET', `/api/classrooms/${classroomId}`);
      expect(read2.status).toBe(200);
      expect(read2.body.studyMethodPlan).toEqual(frozenPlan);

      const unknownRef = await api('POST', '/api/classrooms', {
        topic: '测试', minutes: 10, requestId: 'w5-classroom-ref-1', studyMethodTemplateId: 'no_such_template', studyMethodTemplateVersion: 1,
      });
      expect(unknownRef.status).toBe(404);
      const halfRef = await api('POST', '/api/classrooms', {
        topic: '测试', minutes: 10, requestId: 'w5-classroom-ref-2', studyMethodTemplateId: 'w5_custom_method',
      });
      expect(halfRef.status).toBe(400);
    } finally {
      await close();
    }
  }));

it.skipIf(!testDatabaseUrl)('W5 host: code-test-suite@1 sandbox evaluation strips expectations and stays fail-closed', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    void db;
    const item = {
      itemId: 'q1',
      slots: [{ slotId: 'answer', schemaVersion: 'v1', fields: [{ path: '', kind: 'text' }] }],
      criteria: [],
    } as any;
    const criterion = {
      criterionId: 'c1', inputs: [{ slotId: 'answer', path: '' }], maximum: 2,
      evaluator: { id: 'code-test-suite', version: '1' },
      parameters: {
        language: 'javascript', limits: { timeoutMs: 2000, memoryMb: 128, maxOutputBytes: 4096 },
        cases: [
          { caseId: 'visible', input: '2', expectedOutput: '4', weight: 1 },
          { caseId: 'hidden', input: '3', expectedOutput: '6', weight: 1, hidden: true },
        ],
        qualitativeDimensions: ['code_quality'],
      },
    } as any;
    expect(() => validateBankItem({ ...item, criteria: [criterion] }, { id: 'p', rev: 1 } as never)).not.toThrow();

    const releaseRef = { id: factId(stableId('w5sb', 'paper')), rev: 1 } as any, submissionRef = { id: factId(stableId('w5sb', 'sub')), rev: 1 } as any;
    const release = { releaseRef, items: [{ itemId: 'q1', slots: item.slots }] };
    const submission = assessmentSubmission({
      releaseRef, submissionRef,
      answers: [{
        itemId: 'q1', slotId: 'answer', path: '', schemaVersion: 'v1',
        value: {
          kind: 'text',
          value: `let s='';for await(const c of process.stdin)s+=c;const v=parseInt(s.trim(),10);if(v===2)console.log('4');else console.log(v);`,
        },
      }],
    }, release as never);

    const unconfigured = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, submission);
    expect(unconfigured).toMatchObject({ state: 'ungradable' });
    expect(JSON.stringify(unconfigured)).not.toContain('expectedOutput');

    let captured: any;
    const outcome = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, submission,
      async input => {
        captured = input;
        return runCodeSandbox(input as never);
      });
    expect(captured.cases).toEqual([
      { caseId: 'visible', input: '2' },
      { caseId: 'hidden', input: '3' },
    ]);
    expect(JSON.stringify(captured.cases)).not.toContain('expectedOutput');
    expect(outcome.state).toBe('scored');
    expect((outcome as any).earned).toBe(1);
    const result = (outcome as any).sandboxResult;
    expect(JSON.stringify(result)).not.toMatch(/expectedOutput/);
    const hiddenCase = result.caseOutcomes.find((row: any) => row.caseId === 'hidden');
    expect(hiddenCase).toMatchObject({ passed: false, diagnostic: '隐藏用例未通过。' });
    expect(hiddenCase.stderr).toBeUndefined();
    expect(result.qualitativeDimensions).toEqual([
      expect.objectContaining({ dimension: 'code_quality', state: 'unknown', countsTowardMastery: false }),
    ]);

    const correctSubmission = assessmentSubmission({
      releaseRef, submissionRef,
      answers: [{
        itemId: 'q1', slotId: 'answer', path: '', schemaVersion: 'v1',
        value: { kind: 'text', value: `let s='';for await(const c of process.stdin)s+=c;console.log(parseInt(s.trim(),10)*2);` },
      }],
    }, release as never);
    const passed = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, correctSubmission, runCodeSandbox as never);
    expect(passed).toMatchObject({ state: 'scored', earned: 2 });
  }));

it.skipIf(!testDatabaseUrl)('W5 host: calc bindings freeze, verify exact, drift and revoke without re-leak', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const sourceId = factId(stableId('w5calc', 'source'));
    const calcData = { media: 'series_json', points: [1, 2, 3] };
    const digest = await calcOutputDigest(calcData);
    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await seedFact(tx, tick, sourceId, 'content.calcOutput', calcData);
    }));

    const view = {
      version: 1, id: 'v1', revision: 'r1', title: '图', fallback: '回归曲线见图 @calc_speed。',
      sections: [{ id: 's1', title: '段', layout: 'stack', nodes: [{ kind: 'text', id: 'n1', text: '速度曲线见 @calc_speed。' }] }],
    };
    const binding = (overrides: Record<string, unknown> = {}) => ({
      handle: '@calc_speed', artifactId: sourceId, artifactRev: 1, outputSha256: digest,
      producer: 'python_calculation_sandbox', mediaKind: 'series_json', frozenAtIso: '2026-01-01T00:00:00.000Z', ...overrides,
    });
    await expect(db.snapshot({ learner: studioLearner }, (tx: any) =>
      freezeCalcBindingsForMount(tx, view as never, [binding({ seriesSummary: { pointCount: 3, answer: '42' } })])))
      .rejects.toMatchObject({ name: 'CalcArtifactSpoilerError' });
    await expect(db.snapshot({ learner: studioLearner }, (tx: any) =>
      freezeCalcBindingsForMount(tx, view as never, undefined))).rejects.toThrow();
    await expect(db.snapshot({ learner: studioLearner }, (tx: any) =>
      freezeCalcBindingsForMount(tx, view as never, [binding({ outputSha256: `00${digest.slice(2)}` })]))).rejects.toThrow();
    const frozen = await db.snapshot({ learner: studioLearner }, (tx: any) => freezeCalcBindingsForMount(tx, view as never, [binding()]));
    expect(frozen[0]).toMatchObject({ handle: '@calc_speed', artifactId: sourceId, artifactRev: 1, outputSha256: digest });

    const t1 = stableId('w5calc', 't1');
    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await seedTurn(tx, tick, t1, stableId('w5calc', 'fb'), { sessionId: t1, parentId: null, answer: 'x' }, {});
    }));
    const check = (async () => {}) as any;
    const authorize = async () => ({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: '1', inputs: [] }) as any;
    const args = { view, calcBindings: [binding()] };
    const spoilerMount = await mountArtifact(db, t1, 1, {
      ...args, calcBindings: [binding({ seriesSummary: { pointCount: 3, expectedOutput: '42' } })],
    }, authorize);
    expect(spoilerMount).toMatchObject({ code: 'invalid_args' });
    const missingMount = await mountArtifact(db, t1, 2, { ...args, calcBindings: [] }, authorize);
    expect(missingMount).toMatchObject({ code: 'invalid_args' });

    const mounted = await mountArtifact(db, t1, 3, args, authorize);
    expect(mounted).toMatchObject({ state: 'done' });
    if (!('mountId' in mounted)) throw new Error('作品挂载失败：' + JSON.stringify(mounted));
    const mountId = (mounted as any).mountId as string;
    const read = () => db.snapshot({ learner: studioLearner }, (tx: any) => turnArtifacts(tx, t1, t1, check));
    const first = await read();
    const snap = first.snapshots.find((row: any) => row.mountId === mountId);
    expect(snap).toBeDefined();
    expect(snap!.calcBindings).toMatchObject([{ handle: '@calc_speed', artifactRev: 1 }]);
    expect(snap!.calcVerification).toMatchObject({ status: 'exact', preservedFrozen: true });

    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await tx.query('UPDATE facts SET current_rev=2,changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, sourceId]);
      await tx.insert('fact_revs', { ...f0, sticky: false, fact_id: sourceId, rev: 2, kind: 'value', author: 'learner', command_id: 'drift', tick, data: JSON.stringify({ media: 'series_json', points: [9, 9] }) });
    }));
    const drifted = await read();
    const driftedSnap = drifted.snapshots.find((row: any) => row.mountId === mountId)!;
    expect(driftedSnap.calcVerification!).toMatchObject({ status: 'drifted_keep_frozen', preservedFrozen: true });
    expect(driftedSnap.calcVerification!.entries[0]).toMatchObject({ frozenRev: 1, currentRev: 2 });
    expect(driftedSnap.calcBindings![0]).toMatchObject({ handle: '@calc_speed', artifactRev: 1, outputSha256: digest });

    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await tx.query('UPDATE facts SET retracted_rev=2,changed_tick=$2 WHERE learner_id=$1 AND id=$3', [studioLearner, tick, sourceId]);
    }));
    const revoked = await read();
    const revokedSnap = revoked.snapshots.find((row: any) => row.mountId === mountId)!;
    expect(revokedSnap.calcVerification!).toMatchObject({ status: 'missing_keep_frozen', preservedFrozen: true });
    expect(revokedSnap.calcBindings![0]).toMatchObject({ handle: '@calc_speed', outputSha256: digest });
    expect(JSON.stringify(revokedSnap)).not.toContain('[9,9]');
  }));

it.skipIf(!testDatabaseUrl)('W5 host: shadow-pk read-only proposal and exam-pacing honest unknown projection', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const pEstimate = (probability: number) => ({
      kind: 'probabilistic' as const, probability, interval: [probability, probability] as const,
      uncertainty: 0, effectiveEvidence: 5,
      bucket: { kcId: 'kc1', representation: 'r', context: 'c', method: 'm' }, basis: null,
    });
    const replayCases = Array.from({ length: 20 }, (_, index) => ({
      forecastId: `f${index}`, exposure: 'independent' as const, observed: 'correct' as const,
      recorded: { method: { id: 'recorded-method', version: '1' }, estimate: pEstimate(0.35), status: 'matched' as const },
      shadow: { estimate: pEstimate(0.95), status: 'matched' as const },
      baseline: { probability: 0.5 },
    }));
    const summary = summarizeRetentionReplay(replayCases);
    const key = stableId('w5shadow', 'cmp');
    const retentionComparison = {
      get: async (slotKey: string) => (slotKey === key ? { state: 'complete', value: summary } : undefined),
    };
    const derivedInputs: unknown[] = [];
    const pythonHost = {
      derive: async (deriver: string, input: unknown) => {
        derivedInputs.push({ deriver, input });
        return { kind: 'ok', outcome: { kind: 'value', value: input } };
      },
    };
    const { api, close } = await startW5Server(db, { retentionComparison, pythonHost });
    try {
      const empty = await api('GET', '/api/retention/shadow-pk');
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ verdict: 'insufficient_sample', memoryLayerBoundary: 'read_only_proposal' });

      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await tx.insert('slot_state', {
          learner_id: studioLearner, slot_type: retentionComparisonWork, slot_key: key,
          scope_keys: '{}', changed_tick: tick,
        });
      }));
      const withData = await api('GET', '/api/retention/shadow-pk');
      expect(withData.status).toBe(200);
      expect(withData.body.verdict).not.toBe('insufficient_sample');
      expect(withData.body.memoryLayerBoundary).toBe('read_only_proposal');
      expect(withData.body.shadow.eligible).toBe(20);

      const emptyPacing = await api('GET', '/api/papers/exam-pacing');
      expect(emptyPacing.status).toBe(200);
      expect(emptyPacing.body).toMatchObject({ status: 'unknown', methodVersion: 'plan/exam-pacing@1' });
      expect(emptyPacing.body.missingReasons.length).toBeGreaterThan(0);

      const attempt1 = factId(stableId('w5pace', 'a1')), attempt2 = factId(stableId('w5pace', 'a2'));
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await seedFact(tx, tick, attempt1, workbookAttemptType, {
          paperId: stableId('paper', 'p1'), effectiveDurationMs: 12000, submittedAt: '2026-01-01T00:00:00.000Z',
        });
        await tx.query('UPDATE facts SET purpose=$3 WHERE learner_id=$1 AND id=$2', [studioLearner, attempt1, ['teaching', 'storage']]);
        await tx.query('UPDATE fact_revs SET purpose=$3 WHERE learner_id=$1 AND fact_id=$2', [studioLearner, attempt1, ['teaching', 'storage']]);
        await seedFact(tx, tick, attempt2, workbookAttemptType, {
          paperId: stableId('paper', 'p1'), effectiveDurationMs: 9000, submittedAt: '2026-01-02T00:00:00.000Z',
        });
        await tx.query('UPDATE facts SET retracted_rev=1 WHERE learner_id=$1 AND id=$2', [studioLearner, attempt2]);
      }));
      const pacing = await api('GET', '/api/papers/exam-pacing');
      expect(pacing.status).toBe(200);
      const lastInput = derivedInputs.at(-1) as any;
      expect(lastInput?.deriver).toBe('plan/exam-pacing@1');
      const ids = lastInput?.input?.attempts?.map((row: any) => row.id) ?? [];
      expect(ids).toEqual([attempt1]);
      expect(ids).not.toContain(attempt2);
      expect(lastInput?.input?.attempts?.[0]).toMatchObject({ effective_duration_ms: 12000 });

      const badPaper = await api('GET', '/api/papers/exam-pacing?paperId=not-a-ulid');
      expect(badPaper.status).toBe(400);
    } finally {
      await close();
    }
  }));
