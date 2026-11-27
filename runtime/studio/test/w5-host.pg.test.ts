import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { createCommandReadContext } from '../../../kernel/src/index.ts';
import { requestWork } from '../../../kernel/src/work/index.ts';
import { factId } from '../../../kernel/src/declarations/ids.ts';
import { runCodeSandbox } from '../../../executors/code-sandbox/index.ts';
import { presentationTool } from '../../../executors/teaching/workspace-tools.ts';
import {
  builtInStudyMethodTemplateById, instantiateStudyMethodPlan, parseStudyMethodPlanInstance, parseStudyMethodTemplate,
} from '../../../modules/content/study-method-template.ts';
import { evaluateCodeSandboxCriterion } from '../../../modules/activity/code-sandbox-assessment.ts';
import { assessmentSubmission } from '../../../modules/activity/assessment-values.ts';
import { workbookAssessmentValue, workbookAttemptView } from '../../../modules/activity/workbook-assessment-values.ts';
import { validateBankItem } from '../../../modules/activity/question-assessment.ts';
import { summarizeRetentionReplay } from '../../../modules/learner/retention-replay.ts';
import { workbookAttemptType, workbookGradingVersion, workbookPaperType } from '../../../modules/activity/workbook-values.ts';
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
async function seedFact(tx: any, tick: any, id: string, type: string, data: unknown, purpose = ['teaching']) {
  await tx.insert('facts', { learner_id: studioLearner, purpose, id, type, current_rev: 1, created_tick: tick, changed_tick: tick });
  await tx.insert('fact_revs', { learner_id: studioLearner, purpose, sticky: false, fact_id: id, rev: 1, kind: 'value', author: 'learner', command_id: id, tick, data: JSON.stringify(data) });
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

type Api = (method: string, path: string, payload?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
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
  const api: Api = async (method, path, payload, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, payload === undefined
      ? { method, headers }
      : { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { api, close: () => new Promise(resolve => server.close(() => resolve())) };
}

it.skipIf(!testDatabaseUrl)('W5 host: study-method library, cross-template undo isolation, re-save after undo, post-erasure & classroom freeze', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    const { api, close } = await startW5Server(db, { retentionComparison: { get: async () => undefined } });
    try {
      const initial = await api('GET', '/api/study-method-templates');
      expect(initial.status).toBe(200);
      expect(initial.body.templates.map((t: any) => t.templateId).sort()).toEqual(
        Object.keys(builtInStudyMethodTemplateById).sort());

      const violation = await api('POST', '/api/study-method-templates',
        templatePayload({ steps: [step(1, 'teach_companion'), step(2, 'reflection_summary')] }));
      expect([violation.status, violation.body?.code]).toEqual([400, 'study_method_invariant']);

      // P0-2: frontend bare undoToken (`...:v1` without `:create`) + post-erasure save/undo work cleanly without Catch-22.
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await tx.insert('erasure_requests', { learner_id: studioLearner, request_id: 'er-1', root_id: stableId('er', 'r1'), expected_rev: 1, generation: tick });
      }));
      const staleWm = await api('POST', '/api/study-method-templates', { ...templatePayload(), deletionWatermark: '0' });
      expect([staleWm.status, staleWm.body?.code]).toEqual([409, 'deletion_watermark_stale']);

      const barePayload = templatePayload({ undoToken: 'undo:method-template:w5_custom_method:v1' });
      const saved = await api('POST', '/api/study-method-templates', barePayload);
      expect(saved.status).toBe(200);
      expect(saved.body.undoToken).toBe('undo:method-template:w5_custom_method:v1');

      // P0-1: saving another custom template `w5_peer_method` v1 is NOT affected by undoing `w5_custom_method` v1.
      const peerSaved = await api('POST', '/api/study-method-templates', templatePayload({ templateId: 'w5_peer_method', name: '同伴独立模板' }));
      expect(peerSaved.status).toBe(200);

      expect((await api('POST', '/api/study-method-templates', barePayload)).status).toBe(200);
      expect((await api('POST', '/api/study-method-templates', templatePayload({ name: '另一内容' }))).status).toBe(409);
      expect((await api('POST', '/api/study-method-templates', templatePayload({ version: 3, replacesVersion: 2, name: '链错误' }))).status).toBe(409);

      const v2 = await api('POST', '/api/study-method-templates', templatePayload({ version: 2, replacesVersion: 1, name: '预测独立检验第二版' }));
      expect(v2.status).toBe(200);
      expect(v2.body.undoToken).toBe('undo:method-template:w5_custom_method:v2:from-v1');

      const sessionId = stableId('w5c', 's1'), classroomId = factId(stableId('classroom', sessionId));
      const frozenPlan = instantiateStudyMethodPlan(parseStudyMethodTemplate(saved.body.template), {
        instanceId: 'w5-plan-1', instantiatedAtIso: '2026-01-01T00:00:00.000Z',
      });
      // P2-3: parseStudyMethodPlanInstance enforces teach_companion invariant symmetrically.
      expect(() => parseStudyMethodPlanInstance({
        ...frozenPlan, steps: [{ ...step(1, 'teach_companion'), stepIndex: 0, status: 'pending' }],
      })).toThrow();
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await seedTurn(tx, tick, sessionId, stableId('w5c', 'fb1'), { sessionId, parentId: null, answer: 'x', classroom: { mode: 'start', evidence: [] } }, { classroomPlan: ['第一步：先独立预测'] });
        await seedFact(tx, tick, classroomId, 'activity.classroom', {
          topic: '函数单调性', minutes: 20, sessionId, status: 'active', steps: [], plans: [],
          lastTurnId: sessionId, studyMethodPlan: frozenPlan, pending: { turnId: sessionId, kind: 'start' },
        });
      }));
      expect((await api('GET', `/api/classrooms/${classroomId}`)).body.studyMethodPlan).toEqual(frozenPlan);

      // P1-2: undo v2 -> re-save v2 with new content -> undo v2 again -> undo v1 -> re-save v1 cleanly.
      const undoV2 = await api('POST', '/api/study-method-templates/undo', { undoToken: v2.body.undoToken });
      expect(undoV2.status).toBe(200);
      expect(undoV2.body).toMatchObject({ status: 'undone', templateId: 'w5_custom_method', restoredVersion: 1 });
      expect((await api('POST', '/api/study-method-templates/undo', { undoToken: v2.body.undoToken })).status).toBe(409);

      const v2Again = await api('POST', '/api/study-method-templates', templatePayload({ version: 2, replacesVersion: 1, name: '撤销后重写第二版' }));
      expect(v2Again.status).toBe(200);
      expect((await api('POST', '/api/study-method-templates/undo', { undoToken: v2Again.body.undoToken })).status).toBe(200);

      const undoV1 = await api('POST', '/api/study-method-templates/undo', { undoToken: saved.body.undoToken });
      expect(undoV1.status).toBe(200);
      expect(undoV1.body).toMatchObject({ status: 'undone', restoredVersion: null });
      const afterUndo = await api('GET', '/api/study-method-templates');
      expect(afterUndo.body.templates.some((t: any) => t.templateId === 'w5_custom_method')).toBe(false);
      // P0-1 assertion: peer custom template survived completely intact!
      expect(afterUndo.body.templates.some((t: any) => t.templateId === 'w5_peer_method' && t.version === 1)).toBe(true);

      // P1-2 (R2) & P2-3: flat payload with requestId succeeds; non-string deletionWatermark returns 400.
      const recreateV1 = await api('POST', '/api/study-method-templates', { ...templatePayload({ name: '撤销后重建第一版' }), requestId: 'flat-recreate-001' });
      expect(recreateV1.status).toBe(200);
      expect((await api('POST', '/api/study-method-templates', { ...templatePayload({ name: '坏水位' }), deletionWatermark: 0 })).status).toBe(400);
      expect((await api('GET', '/api/study-method-templates')).body.templates.some((t: any) => t.templateId === 'w5_custom_method')).toBe(true);

      expect((await api('POST', '/api/study-method-templates/undo', { undoToken: 'undo:method-template:predict_counterexample_check:v1' })).status).toBe(409);
      expect((await api('POST', '/api/study-method-templates/undo', { undoToken: 'undo:method-template:no_such_template:v9' })).status).toBe(404);
      expect((await api('GET', `/api/classrooms/${classroomId}`)).body.studyMethodPlan).toEqual(frozenPlan);

      expect((await api('POST', '/api/classrooms', {
        topic: '测试', minutes: 10, requestId: 'w5-classroom-ref-1', studyMethodTemplateId: 'no_such_template', studyMethodTemplateVersion: 1,
      })).status).toBe(404);
      expect((await api('POST', '/api/classrooms', {
        topic: '测试', minutes: 10, requestId: 'w5-classroom-ref-2', studyMethodTemplateId: 'w5_custom_method',
      })).status).toBe(400);
    } finally {
      await close();
    }
  }));

it.skipIf(!testDatabaseUrl)('W5 host: code-test-suite@1 sandbox strips expectations, validates workbookAssessmentValue and surfaces partial sandboxResult', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    void db;
    const item = {
      itemId: 'q1',
      promptRef: { id: factId(stableId('w5sb', 'paper')), rev: 1 },
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
    const release = { releaseRef, items: [{ ...item, criteria: [criterion] }] } as any;
    const submission = assessmentSubmission({
      releaseRef, submissionRef,
      answers: [{
        itemId: 'q1', slotId: 'answer', path: '', schemaVersion: 'v1',
        value: { kind: 'text', value: `let s='';for await(const c of process.stdin)s+=c;const v=parseInt(s.trim(),10);if(v===2)console.log('4');else console.log(v);` },
      }],
    }, release);

    const unconfigured = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, submission);
    expect(unconfigured).toMatchObject({ state: 'ungradable' });

    let captured: any;
    const outcome = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, submission,
      async input => { captured = input; return runCodeSandbox(input as never); });
    expect(captured.cases).toEqual([{ caseId: 'visible', input: '2' }, { caseId: 'hidden', input: '3' }]);
    expect(outcome).toMatchObject({ state: 'scored', earned: 1 });
    // P0-3: full workbookAssessmentValue validation must admit `sandboxResult` without throwing.
    const formalValue = workbookAssessmentValue(release, submission, [{ outcome }]);
    expect((formalValue.result.outcomes[0] as any).sandboxResult).toBeTruthy();
    const hiddenCase = (outcome as any).sandboxResult.caseOutcomes.find((row: any) => row.caseId === 'hidden');
    expect(hiddenCase).toMatchObject({ passed: false, diagnostic: '隐藏用例未通过。' });
    expect(hiddenCase.stderr).toBeUndefined();
    expect((outcome as any).sandboxResult.qualitativeDimensions).toEqual([
      expect.objectContaining({ dimension: 'code_quality', state: 'unknown', countsTowardMastery: false }),
    ]);

    // P1-3: partial code-sandbox outcome keeps pending status AND surfaces sandboxResult on workbookAttemptView.
    const partialOutcome = await evaluateCodeSandboxCriterion({ ...item, criteria: [criterion] }, criterion, submission,
      async () => ({ executorKind: 'isolated-code-sandbox', language: 'javascript', runId: 'r-partial',
        results: [{ caseId: 'visible', status: 'passed', actualOutput: '4' }] }));
    expect(partialOutcome.state).toBe('partial');
    const partialFormal = workbookAssessmentValue(release, submission, [{ outcome: partialOutcome }]);
    const view = workbookAttemptView(submissionRef.id, {
      requestId: 'r1', paperId: releaseRef.id, paperRev: 1, submittedAt: '2026-01-01T00:00:00.000Z', gradingVersion: 'v1',
      answers: { q1: 'code' },
      feedback: [{ questionId: 'q1', result: 'pending', expected: null, explanation: null }],
      paper: { title: 'Code Paper', materialId: null, savedAt: '2026-01-01T00:00:00.000Z',
        questions: [{ id: 'q1', kind: 'bank', prompt: 'p', sourceQuestionRef: { id: factId(stableId('w5sb', 'q')), rev: 1 } }],
        assessmentRelease: release },
    } as any, [], partialFormal.result);
    expect(view.feedback[0]).toMatchObject({ result: 'pending' });
    expect((view.feedback[0] as any).sandboxResult).toMatchObject({ state: 'partial', passedCount: 1 });
  }));

it.skipIf(!testDatabaseUrl)('W5 host: calc bindings enforce teaching purpose, deduplicate shared sources, replay after revoke, and never leak narrowed hashes', { timeout: 120_000 }, () =>
  withLearnerDatabase(studioLearner, async db => {
    // P0-4 & P1-1: tool schema exposes calcBindings; canonical digest ignores undefined keys like PG jsonb.
    expect((presentationTool({}, '').function.parameters.properties as Record<string, unknown>).calcBindings).toBeTruthy();
    expect(await calcOutputDigest({ media: 'series_json', points: [1, 2], note: undefined })).toBe(
      await calcOutputDigest({ media: 'series_json', points: [1, 2] }));

    const sourceId = factId(stableId('w5calc', 'source'));
    const calcData = { media: 'series_json', points: [1, 2, 3] };
    const digest = await calcOutputDigest(calcData);
    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await seedFact(tx, tick, sourceId, 'content.calcOutput', calcData, ['teaching', 'storage']);
    }));

    const view = {
      version: 1, id: 'v1', revision: 'r1', title: '图', fallback: '图 @calc_speed 和 @calc_copy。',
      sections: [{ id: 's1', title: '段', layout: 'stack', nodes: [{ kind: 'text', id: 'n1', text: '曲线 @calc_speed 与 @calc_copy。' }] }],
    };
    const binding = (overrides: Record<string, unknown> = {}) => ({
      handle: '@calc_speed', artifactId: sourceId, artifactRev: 1, outputSha256: digest,
      producer: 'python_calculation_sandbox', mediaKind: 'series_json', frozenAtIso: '2026-01-01T00:00:00.000Z', ...overrides,
    });
    const dualBindings = [binding(), binding({ handle: '@calc_copy' })];
    await expect(db.snapshot({ learner: studioLearner }, (tx: any) =>
      freezeCalcBindingsForMount(createCommandReadContext(tx, 'teaching'), view as never, [binding({ seriesSummary: { pointCount: 3, answer: '42' } }), binding({ handle: '@calc_copy' })])))
      .rejects.toMatchObject({ name: 'CalcArtifactSpoilerError' });

    const t1 = stableId('w5calc', 't1');
    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await seedTurn(tx, tick, t1, stableId('w5calc', 'fb'), { sessionId: t1, parentId: null, answer: 'x' }, {});
    }));
    const check = (async () => {}) as any;
    const authorize = async () => ({ version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: '1', inputs: [] }) as any;
    const args = { view, calcBindings: dualBindings };
    expect(await mountArtifact(db, t1, 1, { ...args, calcBindings: [] }, authorize)).toMatchObject({ code: 'invalid_args' });

    // P1-1: multi-handle binding referencing the same artifactId mounts and reads without duplicate-id 500.
    const mounted = await mountArtifact(db, t1, 3, args, authorize);
    expect(mounted).toMatchObject({ state: 'done' });
    const mountId = (mounted as any).mountId as string;
    const read = () => db.snapshot({ learner: studioLearner }, (tx: any) => turnArtifacts(tx, t1, t1, check));
    expect((await read()).snapshots.find((row: any) => row.mountId === mountId)?.calcVerification)
      .toMatchObject({ status: 'exact', preservedFrozen: true });

    // P1-1: narrowing purpose from ['teaching','storage'] to ['storage'] on rev 2 MUST degrade to missing_keep_frozen without leaking rev 2 hash!
    const v2Data = { media: 'series_json', points: [9, 9] };
    const v2Digest = await calcOutputDigest(v2Data);
    await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
      await tx.query(`UPDATE facts SET current_rev=2, purpose=ARRAY['storage'], changed_tick=$2 WHERE learner_id=$1 AND id=$3`, [studioLearner, tick, sourceId]);
      await tx.insert('fact_revs', { learner_id: studioLearner, purpose: ['storage'], sticky: false, fact_id: sourceId, rev: 2, kind: 'value', author: 'learner', command_id: 'narrow', tick, data: JSON.stringify(v2Data) });
    }));
    const narrowedSnap = (await read()).snapshots.find((row: any) => row.mountId === mountId)!;
    expect(narrowedSnap.calcVerification).toMatchObject({ status: 'missing_keep_frozen', preservedFrozen: true });
    expect(JSON.stringify(narrowedSnap)).not.toContain(v2Digest);

    // P1-1 & P2-3: idempotent replay after source revocation succeeds ONLY for identical bindings; tampered/spoiler replay fails!
    expect(await mountArtifact(db, t1, 3, args, authorize)).toMatchObject({ state: 'done', mountId });
    expect(await mountArtifact(db, t1, 3, {
      ...args, calcBindings: [binding({ outputSha256: v2Digest }), binding({ handle: '@calc_copy', outputSha256: v2Digest })],
    }, authorize)).toMatchObject({ code: 'invalid_args' });
  }));

it.skipIf(!testDatabaseUrl)('W5 host: shadow-pk avoids pending starvation/nested tx and exam-pacing sends authorized CanonicalEvidenceSliceV1', { timeout: 120_000 }, () =>
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
        return { kind: 'ok', outcome: { kind: 'value', value: { method_version: 'plan/exam-pacing@1', attempts: [], strategy: { kind: 'unknown', reason: 'insufficient-comparable-attempts' } } } };
      },
    };
    const { api, close } = await startW5Server(db, { retentionComparison, pythonHost });
    try {
      expect((await api('GET', '/api/retention/shadow-pk')).body).toMatchObject({ verdict: 'insufficient_sample', memoryLayerBoundary: 'read_only_proposal' });

      // P2-2: 10 newer pending rows must not starve the older satisfied comparison.
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await tx.insert('slot_state', { learner_id: studioLearner, slot_type: retentionComparisonWork, slot_key: key, scope_keys: '{}', changed_tick: 1 });
        await requestWork(tx, 1 as never, { slotType: retentionComparisonWork, slotKey: key, deriver: 'learner/retention-comparison@1' });
        await tx.query(`UPDATE work SET state='satisfied' WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3`, [studioLearner, retentionComparisonWork, key]);
        for (let i = 0; i < 10; i += 1) {
          const pk = stableId('w5shadow', `pend${i}`);
          await tx.insert('slot_state', { learner_id: studioLearner, slot_type: retentionComparisonWork, slot_key: pk, scope_keys: '{}', changed_tick: tick });
          await requestWork(tx, tick, { slotType: retentionComparisonWork, slotKey: pk, deriver: 'learner/retention-comparison@1' });
        }
      }));
      const withData = await api('GET', '/api/retention/shadow-pk');
      expect(withData.status).toBe(200);
      expect(withData.body).toMatchObject({ memoryLayerBoundary: 'read_only_proposal', shadow: { eligible: 20 } });
      expect(withData.body.verdict).not.toBe('insufficient_sample');

      expect((await api('GET', '/api/papers/exam-pacing')).body).toMatchObject({ status: 'unknown', methodVersion: 'plan/exam-pacing@1' });

      // P0-5 & P1-1 (R2): authorized paper + attempt with per-item pacing + 0ms attempt + retracted attempt + retracted-materialId paper -> only authorized attempts in slice.
      const p1 = factId(stableId('w5pace', 'paper1')), pRevokedMat = factId(stableId('w5pace', 'paperMat'));
      const revokedMat = factId(stableId('w5pace', 'revokedMat'));
      const paperDoc = {
        title: '节奏测试卷', materialId: null, savedAt: '2026-01-01T00:00:00.000Z',
        questions: [{ id: 'q1', kind: 'numeric', prompt: '1+1=?', answer: 2, tolerance: 0, unit: null, explanation: null }],
      };
      const revokedMatPaper = { ...paperDoc, materialId: revokedMat };
      const attempt1 = factId(stableId('w5pace', 'a1')), attempt0 = factId(stableId('w5pace', 'a0'));
      const attempt2 = factId(stableId('w5pace', 'a2')), attemptRevMat = factId(stableId('w5pace', 'aMat'));
      await db.tx({ learner: studioLearner }, (tx: any) => tx.withLearnerWrite(async (tick: any) => {
        await seedFact(tx, tick, p1, workbookPaperType, paperDoc, ['storage', 'teaching']);
        await seedFact(tx, tick, revokedMat, 'capture.source', { kind: 'upload', title: 'm' }, ['storage', 'teaching']);
        await tx.query('UPDATE facts SET retracted_rev=1 WHERE learner_id=$1 AND id=$2', [studioLearner, revokedMat]);
        await seedFact(tx, tick, pRevokedMat, workbookPaperType, revokedMatPaper, ['storage', 'teaching']);
        const baseAttempt = { requestId: 'request-001', paperId: p1, paperRev: 1, gradingVersion: workbookGradingVersion, answers: { q1: 2 },
          feedback: [{ questionId: 'q1', result: 'correct', answer: 2, expected: { kind: 'numeric', value: 2, tolerance: 0, unit: null }, explanation: null }], paper: paperDoc };
        await seedFact(tx, tick, attempt1, workbookAttemptType, {
          ...baseAttempt, effectiveDurationMs: 12000, submittedAt: '2026-01-01T00:00:00.000Z',
          pacing: { version: 1, items: [{ questionId: 'q1', effectiveDurationMs: 5000, skipped: false, returned: false }] },
        }, ['storage', 'teaching']);
        await seedFact(tx, tick, attempt0, workbookAttemptType, {
          ...baseAttempt, requestId: 'request-000', effectiveDurationMs: 0, submittedAt: '2026-01-02T00:00:00.000Z',
        }, ['storage', 'teaching']);
        await seedFact(tx, tick, attempt2, workbookAttemptType, {
          ...baseAttempt, requestId: 'request-002', effectiveDurationMs: 9000, submittedAt: '2026-01-03T00:00:00.000Z',
        }, ['storage', 'teaching']);
        await tx.query('UPDATE facts SET retracted_rev=1 WHERE learner_id=$1 AND id=$2', [studioLearner, attempt2]);
        await seedFact(tx, tick, attemptRevMat, workbookAttemptType, {
          ...baseAttempt, requestId: 'request-003', paperId: pRevokedMat, paper: revokedMatPaper, effectiveDurationMs: 7000, submittedAt: '2026-01-04T00:00:00.000Z',
        }, ['storage', 'teaching']);
      }));

      expect((await api('GET', '/api/papers/exam-pacing')).status).toBe(200);
      const lastInput = derivedInputs.at(-1) as any;
      expect(lastInput?.deriver).toBe('plan/exam-pacing@1');
      expect(lastInput?.input).toMatchObject({
        clock_watermark: expect.stringMatching(/^\d+$/),
        as_of_at: expect.stringMatching(/Z$/),
        constraints: { budget_min: null, locks: [], deadlines: [] },
        candidate_pool: [],
      });
      const pacingEvents = lastInput.input.events.filter((e: any) => e.exam_pacing);
      expect(pacingEvents.map((e: any) => e.ref).sort()).toEqual([attempt0, attempt1].sort());
      expect(pacingEvents.find((e: any) => e.ref === attempt1)).toMatchObject({
        effective_duration_ms: 12000, exam_pacing: { paper_key: JSON.stringify([p1, 1]) },
      });
      // 0ms attempt omits effective_duration_ms so plan/exam-pacing@1 never rejects the slice!
      expect(pacingEvents.find((e: any) => e.ref === attempt0)?.effective_duration_ms).toBeUndefined();
      // Within-attempt item pacing events are emitted!
      expect(lastInput.input.events.some((e: any) => e.exam_pacing_item?.item_id === 'q1')).toBe(true);
      expect((await api('GET', '/api/papers/exam-pacing?paperId=not-a-ulid')).status).toBe(400);
    } finally {
      await close();
    }
  }));
