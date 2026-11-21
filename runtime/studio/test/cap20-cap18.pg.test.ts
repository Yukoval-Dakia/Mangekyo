import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createAuthorizedFactReader, createCommandReadContext, FactReadDeniedError } from '../../../kernel/src/commands/reads.ts';
import { applyFactWrites } from '../../../kernel/src/commands/writes.ts';
import { commandId, factId, type FactId, type Revision, type Tick } from '../../../kernel/src/declarations/ids.ts';
import type { Json } from '../../../kernel/src/declarations/types.ts';
import { lockLearner } from '../../../kernel/src/db/learner.ts';
import type { Db } from '../../../kernel/src/db/types.ts';
import { sealCandidate, submitCandidate } from '../../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../../kernel/src/derivations/gather.ts';
import { createPropagationHooks } from '../../../kernel/src/derivations/propagation.ts';
import { acknowledgeStartedWork } from '../../../kernel/src/work/index.ts';
import { enqueueWork } from '../../../kernel/src/work/todos.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { createPythonDeriverHost } from '../../../executors/python-deriver/host.ts';
import { examTimeValueMethod, projectWorkbookExamTimeValue } from '../../../modules/activity/exam-time-value.ts';
import { helpExposureRequest } from '../../../modules/activity/help-exposure-values.ts';
import { storagePurpose } from '../../../modules/activity/library-values.ts';
import { workbookAssessmentConsent, workbookAttemptType } from '../../../modules/activity/workbook-values.ts';
import { knowledgeEdgeType } from '../../../modules/content/knowledge-edge.ts';
import { hypothesisView } from '../../../modules/learner/belief-view.ts';
import liftDeriver from '../../../modules/learner/derivers/intervention-lift.ts';
import statusDeriver from '../../../modules/learner/derivers/understanding-status.ts';
import { interventionLiftKey } from '../../../modules/learner/intervention-lift.ts';
import { playbook, playbookType, readVerifiedPlaybook } from '../../../modules/learner/playbook.ts';
import { readMemoryGateway } from '../memory-gateway.ts';
import { purpose as teachingPurpose, stableId, studioLearner } from '../identity.ts';
import { openWorkbook } from '../workbook.ts';
import { openWorkbookAssessment, workbookTextEvaluator } from '../workbook-assessment.ts';
import { buildPreSubmitPitfallRule, type PreSubmitPitfallRuleCandidate } from '../workbook-pre-submit.ts';
import { loadStudioTestModule } from './modules.ts';

const learner = studioLearner;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const at = (seconds: number) => new Date(Date.parse('2026-11-21T08:00:00.000Z') + seconds * 1000).toISOString();

async function writeFacts(db: Db, writes: Parameters<typeof applyFactWrites>[2], key: string, purpose = storagePurpose) {
  return db.tx({ learner }, async tx => {
    await lockLearner(tx, learner);
    return tx.withLearnerWrite(async tick => {
      const receipt = await applyFactWrites(tx, tick, writes, { actor: 'learner', purpose, commandId: commandId(stableId('seed', key)) },
        type => ({ type, schema: { parse: (value: Json) => value } }));
      return { tick, receipt };
    });
  });
}

const setPurpose = (id: FactId, expectedRev: number, purpose: string[]) =>
  ({ kind: 'set_purpose' as const, id, expectedRev: expectedRev as Revision, purpose });

async function displayQuestion(workbook: ReturnType<typeof openWorkbook>, paperId: string, paperRev: number, items: string[]) {
  const permit = (await workbook.recordPresentation(paperId, {
    kind: 'question', paper: { id: paperId, rev: paperRev }, items, phase: 'permit',
  })) as { permit: string };
  await workbook.recordPresentation(paperId, {
    kind: 'question', paper: { id: paperId, rev: paperRev }, items, phase: 'displayed', permit: permit.permit,
  });
}

it.skipIf(!testDatabaseUrl)('verifies Capability 20 preSubmitRevised producer, counterexamples, rule.basis and review readback on PostgreSQL', { timeout: 30_000 }, () =>
  withLearnerDatabase(learner, async db => {
    const activity = await loadStudioTestModule('activity');
    const ids = (tag: string) => factId(stableId('c20-' + tag));
    const id1 = (tag: string) => factId(stableId('c20-' + tag));
    const conceptId = id1('concept'), q1Source = id1('q1'), q2Source = id1('q2'), edgeId = id1('edge'), turnId = id1('turn'), claimId = id1('claim');
    const allUse = [storagePurpose, teachingPurpose, 'background-research'];
    const quoteText = '审题先圈出已知条件';
    const use0 = { rev: 1, accessEpoch: '0' };
    const { tick: seededTick } = await writeFacts(db, [
      { kind: 'create', id: conceptId, factType: 'activity.workspaceEntry', data: { kind: 'concept', title: '平均速度', body: '路程÷时间', tags: [], links: [], basis: [] }, purpose: allUse },
      { kind: 'create', id: q1Source, factType: 'activity.workspaceEntry', data: { kind: 'question', title: '速度1', tags: [], links: [], basis: [], body: '已知总路程60总时间5，求速度', answer: '12' }, purpose: allUse },
      { kind: 'create', id: q2Source, factType: 'activity.workspaceEntry', data: { kind: 'question', title: '速度2', tags: [], links: [], basis: [], body: '已知时间2速度5，求路程', answer: '10' }, purpose: allUse },
      { kind: 'create', id: edgeId, factType: knowledgeEdgeType, data: { kind: 'targets_concept',
        from: { kind: 'question', sourceUse: { id: q1Source, ...use0 } }, to: { kind: 'concept', sourceUse: { id: conceptId, ...use0 } },
        sourceUses: [{ id: q1Source, ...use0 }, { id: conceptId, ...use0 }], scope: '平均速度' }, purpose: allUse },
      { kind: 'create', id: turnId, factType: 'activity.studyTurn',
        data: { caseId: 'companion', memoryVersion: 1, workspaceRevision: '0', answer: quoteText }, purpose: allUse },
      ...(['hact-1', 'hact-2'].map(tag => ({ kind: 'create' as const, id: ids(tag), factType: 'activity.workbookPaper', data: { title: '旧卷' }, purpose: allUse }))),
      ...(['hsub-1', 'hsub-2'].map(tag => ({ kind: 'create' as const, id: ids(tag), factType: workbookAttemptType, data: { ok: true }, purpose: allUse }))),
      ...(['grade-1', 'grade-2'].map(tag => ({ kind: 'create' as const, id: ids(tag), factType: 'activity.workbookFormalAssessment', data: { ok: true }, purpose: allUse }))),
      ...(['eval-1', 'eval-2'].map(tag => ({ kind: 'create' as const, id: ids(tag), factType: 'learner.evaluation', data: { ok: true }, purpose: allUse }))),
    ], 'cap20-base');
    await writeFacts(db, [setPurpose(turnId, 1, [storagePurpose, teachingPurpose])], 'turn-equiv');
    await writeFacts(db, [
      { kind: 'create', id: claimId, factType: 'companion.claim', data: { version: 1, authority: 'directive', sticky: true,
        category: 'claim', origin: 'turn', action: 'correct', valid_until: null, text: quoteText,
        evidence_refs: [{ id: turnId, rev: 2, accessEpoch: '1', start: 0, excerpt: quoteText }] }, purpose: allUse },
    ], 'claim');

    const w = (id: FactId, type: string, mode: 'following' | 'pinned' = 'following') =>
      ({ learner, id, rev: 1 as Revision, accessEpoch: '0' as Tick, type, mode });
    const ruleCandidates: PreSubmitPitfallRuleCandidate[] = [{ kind: 'sticky', id: claimId, errorStage: 'reading', conceptIds: [conceptId] }];
    const history = [ids('hsub-1'), ids('hsub-2')].map((id, index) => ({ submission: w(id, workbookAttemptType), itemId: `hq${index + 1}` }));
    const histRows = new Map([
      [ids('hsub-1'), { act: ids('hact-1'), grade: ids('grade-1'), evalId: ids('eval-1'), itemId: 'hq1' }],
      [ids('hsub-2'), { act: ids('hact-2'), grade: ids('grade-2'), evalId: ids('eval-2'), itemId: 'hq2' }],
    ] as const);
    const openItem = async (_scope: unknown, item: { submission: ReturnType<typeof w>; itemId: string }) => {
      const row = histRows.get(item.submission.id);
      if (!row || row.itemId !== item.itemId) return undefined;
      return { submission: item.submission, itemId: row.itemId, activity: w(row.act, 'activity.workbookPaper'),
        source: { ref: w(q1Source, 'activity.workspaceEntry', 'pinned'), itemId: 'question' },
        grade: w(row.grade, 'activity.workbookFormalAssessment'), admittedAt: seededTick,
        event: { ref: item.submission.id, rev: 1 as Revision, occurred_at: at(10), concept_ids: [conceptId], item_novelty: 'same' as const,
          help_level: 'independent' as const, outcome: 'incorrect' as const, claim_ids: [claimId], error_stage: 'reading' as const },
        basis: [w(claimId, 'companion.claim')],
        evaluation: { ref: w(row.evalId, 'learner.evaluation'), concept: w(conceptId, 'activity.workspaceEntry'), basis: [] } };
    };
    const workbook = openWorkbook(db, activity, {
      onResearchFactsChanged: async () => {},
      preSubmit: { loadRules: async () => ruleCandidates, loadHistory: async () => history, openItem },
    });

    const sourceQuestions = [
      { kind: 'numeric', prompt: '已知总路程60总时间5，求速度', answer: 12, tolerance: 0, sourceQuestionRef: { id: q1Source, rev: 1 } },
      { kind: 'numeric', prompt: '已知时间2速度5，求路程', answer: 10, tolerance: 0, sourceQuestionRef: { id: q2Source, rev: 1 } },
    ];
    const makePaper = async (reqId: string, extraQuestions: Record<string, unknown>[] = []) => {
      const saved = await workbook.save({ requestId: reqId, title: '自检测试卷', questions: [...sourceQuestions, ...extraQuestions] });
      await writeFacts(db, [setPurpose(factId(saved.id), 1, allUse)], 'grant-' + reqId);
      return workbook.get(saved.id);
    };
    const submitRevised = (paperId: string, paperRev: number, requestId: string, answers: Record<string, string>, original = '10') =>
      workbook.submit(paperId, { requestId, paperRev, answers,
        preSubmitRevisions: [{ draftRequestId: requestId, paperRev, itemId: 'q1', originalAnswer: original }] });

    const paper = await makePaper('c20-paper-1', [{ kind: 'numeric', prompt: '直接求 3+7', answer: 10, tolerance: 0 }]);
    expect(paper.revision).toBe(2);
    // rule.basis carries the following studyTurn witness under the current recipient scope.
    const builtRule = await db.snapshot({ learner }, tx =>
      buildPreSubmitPitfallRule(tx, { learner, purpose: teachingPurpose, recipient: 'learner' }, () => true, ruleCandidates[0]!));
    expect(builtRule?.basis).toContainEqual(expect.objectContaining({ id: turnId, rev: 2, accessEpoch: '1', type: 'activity.studyTurn', mode: 'following' }));
    expect(await workbook.preSubmitPitfalls(paper.id)).toMatchObject([{ anchors: [{ itemId: 'q1', number: 1 }] }]);
    expect(await workbook.preSubmitPitfalls(paper.id, { maySend: fact => fact.ref.id !== turnId })).toEqual([]);

    // Positive first: sibling submissions/help on the same source poison S11.
    await displayQuestion(workbook, paper.id, paper.revision!, ['q1', 'q2', 'q3']);
    const posRes = await submitRevised(paper.id, paper.revision!, 'c20-pos-submit', { q1: '12', q2: '10', q3: '10' });
    expect(posRes.attempts[0]!.preSubmitRevised).toBe(true);
    const positiveAttemptId = factId(posRes.attempts[0]!.id);

    const unknownPaper = await makePaper('c20-paper-unknown');
    const unknownSub = await submitRevised(unknownPaper.id, unknownPaper.revision!, 'c20-unknown-ind', { q1: '12', q2: '10' });
    expect(unknownSub.attempts[0]!.preSubmitRevised).toBeUndefined();
    const rev2 = (label: string, itemId: string, originalAnswer: unknown, draftRequestId?: string) => ({
      preSubmitRevisions: [{ draftRequestId: draftRequestId ?? 'c20-' + label, paperRev: 2, itemId, originalAnswer }] });
    const answers = (q1: string, q2 = '10') => ({ answers: { q1, q2 } });
    const counterexamples: readonly [string, Record<string, unknown>][] = [
      ['ordinary-no-anchor', answers('12')],
      ['reverted-same-num', { ...answers(' 10.0 '), ...rev2('reverted-same-num', 'q1', '10') }],
      ['cross-item-edit', { ...answers('10', '99'), ...rev2('cross-item-edit', 'q1', '10') }],
      ['blank-original', { ...answers('12'), ...rev2('blank-original', 'q1', '   ') }],
      ['unauthorized-anchor', { ...answers('12'), ...rev2('unauthorized-anchor', 'q2', '8') }],
      ['wrong-draft', { ...answers('12'), ...rev2('wrong-draft', 'q1', '10', 'other-draft-id') }],
    ];
    let negativeAttemptId!: FactId;
    for (const [label, body] of counterexamples) {
      const fresh = await makePaper('c20-p-' + label);
      await displayQuestion(workbook, fresh.id, fresh.revision!, ['q1', 'q2']);
      const res = await workbook.submit(fresh.id, { requestId: 'c20-' + label, paperRev: fresh.revision, ...body });
      expect(res.attempts[0]!.preSubmitRevised, label).toBeUndefined();
      if (label === 'ordinary-no-anchor') negativeAttemptId = factId(res.attempts[0]!.id);
    }

    const helpedPaper = await makePaper('c20-paper-helped');
    await displayQuestion(workbook, helpedPaper.id, helpedPaper.revision!, ['q1', 'q2']);
    const helpCmd = createCommandHandler(db, { modules: [activity], hooks: createPropagationHooks([]) });
    await helpCmd({ learner, actor: 'learner', ...helpExposureRequest(factId(stableId('c20-help')), { kind: 'displayed',
      mount: { activityId: factId(helpedPaper.id), issuance: { id: factId(helpedPaper.id), rev: helpedPaper.revision! }, item: { itemId: 'q1' } },
      alsoAppliesTo: [], content: { id: q1Source, rev: 1 as Revision }, step: { kind: 'hint_l1', order: 1 } }) });
    const helpedSub = await submitRevised(helpedPaper.id, helpedPaper.revision!, 'c20-helped-sub', { q1: '12', q2: '10' });
    expect(helpedSub.attempts[0]!.preSubmitRevised).toBeUndefined();

    const revokedPaper = await makePaper('c20-paper-revoked');
    await displayQuestion(workbook, revokedPaper.id, revokedPaper.revision!, ['q1', 'q2']);
    await writeFacts(db, [setPurpose(turnId, 2, [storagePurpose])], 'revoke-turn');
    expect(await workbook.preSubmitPitfalls(revokedPaper.id)).toEqual([]);
    expect((await submitRevised(revokedPaper.id, revokedPaper.revision!, 'c20-revoked-sub', { q1: '12', q2: '10' })).attempts[0]!.preSubmitRevised).toBeUndefined();

    await writeFacts(db, [setPurpose(positiveAttemptId, 1, allUse), setPurpose(negativeAttemptId, 1, allUse)], 'grant-review-attempts');
    const teachingFact = (id: FactId) => db.snapshot({ learner }, tx => createAuthorizedFactReader(tx, teachingPurpose, () => true).fact(id, { mode: 'following' }));
    const [posSnap, negSnap] = await Promise.all([teachingFact(positiveAttemptId), teachingFact(negativeAttemptId)]);
    const posWitness = { id: posSnap.ref.id, rev: posSnap.ref.rev, accessEpoch: posSnap.accessEpoch };
    const negWitness = { id: negSnap.ref.id, rev: negSnap.ref.rev, accessEpoch: negSnap.accessEpoch };
    const hyp = (witness: typeof posWitness, snap: typeof posSnap) => hypothesisView(
      [{ ref: witness, occurredAt: at(100), recordedAt: at(100), origin: 'chronicle', source: 'business-event',
        direction: 'supports', assessment: 'independent-variant' }],
      { validAt: at(300), knownAt: at(300) }, { learner, purpose: teachingPurpose, submissions: [snap] }).process;
    expect(hyp(posWitness, posSnap)).toEqual({ preSubmitRevised: [posWitness] });
    expect(hyp(negWitness, negSnap)).toBeUndefined();

    // Studio memory-gateway hypothesis readback (management + beliefTools).
    const hypFactId = factId(stableId('c20-hyp-fact'));
    await writeFacts(db, [{
      kind: 'create', id: hypFactId, factType: 'companion.memoryAssertion', purpose: allUse,
      data: { version: 2, kind: 'observation', text: '审题自检后能改对', scope: { kind: 'general' }, ttl: null, sticky: false,
        undo_token: factId(stableId('c20-hyp-undo')), belief: { turn: turnId, supersedes: null, forgotten: false },
        evidence_refs: [{ ...posWitness, anchor: 'q3', excerpt: '10', direction: 'support' }] },
    }], 'seed-hyp');
    const gateway = (step: string) => readMemoryGateway({
      db, owner: { kind: 'derivation', id: factId(stableId('c20-gw-owner')), step },
      scope: { preference: {}, links: [] }, intent: 'management', maxBytes: 8192,
      maySend: () => true, authorize: async () => {}, beliefTools: true });
    expect((await gateway('memory'))?.bundle.data.claims?.[0])
      .toMatchObject({ id: hypFactId, process: { preSubmitRevised: [posWitness] } });

    const pbPosId = factId(stableId('c20-pb-pos')), pbNegId = factId(stableId('c20-pb-neg'));
    const pbPos = playbook({ version: 1, strategyId: 'pre-submit-check', preconditions: ['审题易漏'],
      strategy_steps: ['交卷前按锚点复核'], counterexamples: [], exit_conditions: ['独立连续做对'],
      reflection: { rationale: '自检改答有效', metric: '独立后测提升', evidence_refs: [posWitness] } });
    const pbNeg = playbook({ ...pbPos, strategyId: 'no-revision', reflection: { ...pbPos.reflection, evidence_refs: [negWitness] } });
    await writeFacts(db, [
      { kind: 'create', id: pbPosId, factType: playbookType, data: pbPos, purpose: allUse },
      { kind: 'create', id: pbNegId, factType: playbookType, data: pbNeg, purpose: allUse },
    ], 'seed-playbooks');
    const runSlot = async (policy: Parameters<typeof sealCandidate>[2], slotKey: string, gather: Parameters<typeof gatherSnapshot>[2],
      submit: (sealed: Extract<Awaited<ReturnType<typeof sealCandidate>>, { kind: 'sealed' }>) => Parameters<typeof submitCandidate>[4]) => {
      const work = await db.tx({ learner }, tx => tx.withLearnerWrite(tick => enqueueWork(tx, tick, { slotType: policy.slot.type, slotKey, deriver: policy.deriver })));
      const snap = await gatherSnapshot(db, { learner, purpose: 'background-research' }, gather);
      const sealed = await sealCandidate(db, work, policy, snap);
      if (sealed.kind !== 'sealed') throw new Error('not sealed');
      await submitCandidate(db, work, policy, sealed.id, submit(sealed), createPropagationHooks([]));
      return sealed;
    };
    const seedLiftAndStatus = async (pbId: FactId, pbData: typeof pbPos) => {
      const liftPolicy = { slot: { type: liftDeriver.slot, key: () => interventionLiftKey(pbId, 1) },
        deriver: liftDeriver.name + '@' + liftDeriver.version, purpose: 'background-research' };
      const statusPolicy = { slot: { type: statusDeriver.slot, key: () => pbId },
        deriver: statusDeriver.name + '@' + statusDeriver.version, purpose: 'background-research' };
      await runSlot(liftPolicy, interventionLiftKey(pbId, 1), async ({ read }) => {
        await read.fact(pbId, { mode: 'following' });
        return { kind: 'input' as const, data: null, effects: [] };
      }, () => ({ kind: 'value' as const, value: { playbookId: pbId, version: 1, strategyId: pbData.strategyId,
        verdict: 'positive', interval: { lower: 0.1, upper: 0.5 }, sampleCount: 12, verificationRefs: [posWitness] } }));
      let stValue!: ReturnType<typeof statusDeriver.derive>;
      await runSlot(statusPolicy, pbId, ctx => statusDeriver.gather(ctx, { playbookId: pbId, at: at(200) }),
        sealed => (stValue = statusDeriver.derive(sealed.plan.data as Parameters<typeof statusDeriver.derive>[0])));
      return stValue;
    };
    const posStatus = await seedLiftAndStatus(pbPosId, pbPos);
    const negStatus = await seedLiftAndStatus(pbNegId, pbNeg);
    expect(posStatus).toMatchObject({ kind: 'value', value: { status: 'verified', process: { preSubmitRevised: [posWitness] } } });
    expect((negStatus as { value: Record<string, unknown> }).value.process).toBeUndefined();
    const pbPosRef = { id: pbPosId, rev: 1 as Revision, accessEpoch: '0' as Tick };
    const verifiedRead = await gatherSnapshot(db, { learner, purpose: teachingPurpose },
      async ({ read }) => ({ kind: 'input' as const, effects: [], data: await readVerifiedPlaybook(read, pbPosRef, at(200)) }));
    expect(verifiedRead.plan.kind === 'input' && verifiedRead.plan.data).toMatchObject({ status: { status: 'verified', process: { preSubmitRevised: [posWitness] } } });

    // Revoking teaching hides the process from both authorized review reads.
    await writeFacts(db, [setPurpose(positiveAttemptId, posSnap.ref.rev, [storagePurpose, 'background-research'])], 'revoke-pos-teaching');
    expect((await gateway('memory-2'))?.bundle.data.claims ?? []).toEqual([]);
    await expect(gatherSnapshot(db, { learner, purpose: teachingPurpose },
      async ({ read }) => ({ kind: 'input' as const, effects: [], data: await readVerifiedPlaybook(read, pbPosRef, at(200)) })))
      .rejects.toThrowError(FactReadDeniedError);
    await writeFacts(db, [setPurpose(positiveAttemptId, posSnap.ref.rev + 1, [storagePurpose])], 'revoke-pos-research');
    await expect(gatherSnapshot(db, { learner, purpose: 'background-research' }, ctx => statusDeriver.gather(ctx, { playbookId: pbPosId, at: at(200) }))).rejects.toThrow();
  }));

it.skipIf(!testDatabaseUrl)('verifies Capability 18 examTimeValue authorized read bundle, revocation and mismatch fallbacks on PostgreSQL', { timeout: 30_000 }, () =>
  withLearnerDatabase(learner, async db => {
    const activity = await loadStudioTestModule('activity');
    const pythonHost = createPythonDeriverHost();
    try {
      const routeId = 'isolated-assessment/fixture-v1';
      const paperReq = 'c18-formal-paper';
      const expectedPaperId = factId(stableId('workbook-paper', paperReq));
      const releaseRef = { id: expectedPaperId, rev: 1 as Revision };
    const makeItem = (itemId: string, idx: number, prompt: string, rubric: string) => ({ itemId, promptRef: releaseRef,
      slots: [{ slotId: 'answer', schemaVersion: 'text-v1', fields: [{ path: '', kind: 'text' as const }] }],
      criteria: [{ criterionId: 'score', evaluator: workbookTextEvaluator, maximum: 2, missingEvidence: 'insufficient-evidence' as const,
        inputs: [{ slotId: 'answer', path: '' }], source: { kind: 'product-rubric' as const, ref: releaseRef, path: `/questions/${idx}/rubric` },
        parameters: { routeId, promptSha256: sha(prompt), rubricSha256: sha(rubric) } }] });
      const q1 = { kind: 'rubric' as const, prompt: '推导等时长平均速度', rubric: '写出中点平均得2分' };
      const q2 = { kind: 'rubric' as const, prompt: '推导等路程平均速度', rubric: '写出调和平均得2分' };
      const frozenItems = [makeItem('q1', 0, q1.prompt, q1.rubric), makeItem('q2', 1, q2.prompt, q2.rubric)];
      const sampleRef = (tag: string) => ({ id: factId(stableId('c18-sample', tag)), rev: 1 as Revision });
      const makeEvidence = (item: typeof frozenItems[number]) => {
        const mk = (tag: string, text: string | null, outcome: Record<string, unknown>) => {
          const sRef = sampleRef(item.itemId + tag), subRef = sampleRef(item.itemId + tag + 'sub');
          const result = { releaseRef, submissionRef: subRef, outcomes: [{ itemId: item.itemId, criterionId: 'score', ...outcome }] };
          const answers = text === null ? [] : [{ itemId: item.itemId, slotId: 'answer', path: '', schemaVersion: 'text-v1', value: { kind: 'text' as const, value: text } }];
          return { sample: { sampleRef: sRef, submission: { releaseRef, submissionRef: subRef, answers }, expected: result },
            run: { state: 'completed' as const, witnessRef: sampleRef(item.itemId + 'w'), sampleRef: sRef, receiptRef: sampleRef(item.itemId + tag + 'r'),
              actual: result, evaluators: [{ criterionId: 'score', evaluator: workbookTextEvaluator }] } };
        };
        const samples = [
          mk('normal', '完整正确解答', { state: 'scored', earned: 2, evidence: [{ slotId: 'answer', path: '' }] }),
          mk('partial', '部分正确解答', { state: 'scored', earned: 1, evidence: [{ slotId: 'answer', path: '' }] }),
          mk('negative', null, { state: 'insufficient-evidence', reason: '无作答' }),
        ];
        return {
          witness: { ref: sampleRef(item.itemId + 'w'), origin: 'trusted-gold' as const, releaseRef, frozenItem: item,
            requiredSampleRefs: samples.map(s => s.sample.sampleRef),
            requiredCoverage: samples.map((s, index) => ({ kind: (['normal', 'partial', 'negative'] as const)[index]!, criterionId: 'score', sampleRef: s.sample.sampleRef })) },
          samples,
        };
      };
      const scores = new Map<string, number>([['中点平均正确', 2], ['调和平均部分对', 1], ['审题快错', 0], ['超估时错', 0]]);
      const assessment = openWorkbookAssessment(db, {
        readVerifiedEvidence: ({ itemId }) => makeEvidence(frozenItems.find(entry => entry.itemId === itemId)!),
        resolveAssessmentRoute: async id => id !== routeId ? null : ({ id: routeId, reserve: async () => true,
          score: async ({ answer }) => ({ state: 'scored', earned: scores.get(answer) ?? 0, feedback: '已评阅', quote: answer, reportedModel: 'fixture-v1' }) }),
      });
      const workbook = openWorkbook(db, activity, { assessment, pythonHost, onResearchFactsChanged: async () => {} });
      const saved = await workbook.save({
        requestId: paperReq, title: '整卷节奏卷', questions: [q1, q2],
        assessmentRelease: { items: frozenItems.map(({ itemId, promptRef, slots, criteria }) => ({ itemId, promptRef, slots,
          criteria: criteria.map(({ parameters: _, ...criterion }) => ({ ...criterion, parameters: { routeId } })) })) },
      });
      const sub = await workbook.submit(saved.id, {
        requestId: 'c18-att-1', paperRev: saved.revision,
        answers: { q1: '中点平均正确', q2: '调和平均部分对' },
        effectiveDurationMs: 6000,
        pacing: { version: 1, items: [
          { questionId: 'q1', effectiveDurationMs: 2000, skipped: false, returned: false },
          { questionId: 'q2', effectiveDurationMs: 3500, skipped: true, returned: true },
        ] },
        assessmentConsent: workbookAssessmentConsent,
      });
      const attemptId = factId(sub.attempts[0]!.id);
      // Before the formal assessment settles the detail stays honestly unknown.
      expect(sub.attempts[0]!.examTimeValue).toEqual({
        method_version: examTimeValueMethod, paper: { id: saved.id, rev: 1 }, attempt_ref: { id: attemptId, rev: 1 }, kind: 'unknown' });
      // Execute the queued formal assessment on real PG.
      const runQueuedAssessments = async () => {
        const { rows } = await db.query<{ intent_id: string }>("SELECT intent_id FROM work_outbox WHERE learner_id=$1 AND state='pending'", [learner]);
        for (const row of rows) {
          const ref = await acknowledgeStartedWork(db, row.intent_id);
          if (ref) await assessment.execute(ref);
        }
      };
      await runQueuedAssessments();
      const detail = await workbook.get(saved.id);
      expect(detail.attempts[0]!.formalAssessment).toMatchObject({ state: 'complete', score: { earned: 3, maximum: 4 } });
      expect(detail.attempts[0]!.examTimeValue).toEqual({ method_version: examTimeValueMethod, paper: { id: saved.id, rev: 1 },
        attempt_ref: { id: attemptId, rev: 1 }, kind: 'observed', total_duration_ms: 5500,
        items: [{ item_id: 'q1', position: 1, effective_duration_ms: 2000, state: 'steady' },
          { item_id: 'q2', position: 2, effective_duration_ms: 3500, state: 'recovered-skip' }],
        summary: '本卷有 1 题拿满分、1 题回访得分。' });

    const sub2 = await workbook.submit(saved.id, {
        requestId: 'c18-att-2', paperRev: saved.revision,
        answers: { q1: '审题快错', q2: '超估时错' },
        effectiveDurationMs: 6000,
        pacing: { version: 1, items: [
          { questionId: 'q1', effectiveDurationMs: 1000, skipped: false, returned: false },
          { questionId: 'q2', effectiveDurationMs: 4000, skipped: false, returned: false },
        ] },
        assessmentConsent: workbookAssessmentConsent,
      });
      const attempt2Id = factId(sub2.attempts[0]!.id);
      await runQueuedAssessments();
      const quadrants = await workbook.examTimeValue(saved.id, attempt2Id, {
        estimates: [{ itemId: 'q1', estimatedDurationMs: 2000, ref: 'est-q1', rev: 1 as Revision, occurredAt: at(1) },
          { itemId: 'q2', estimatedDurationMs: 2000, ref: 'est-q2', rev: 1 as Revision, occurredAt: at(1) }],
        errorStages: { q1: 'reading' } });
      expect(quadrants).toMatchObject({ kind: 'observed', total_duration_ms: 5000,
        items: [{ item_id: 'q1', state: 'fast-slip' }, { item_id: 'q2', state: 'time-sink' }] });

      // Purpose/epoch gating: grant teaching, read, then revoke teaching -> unknown.
      await writeFacts(db, [
        setPurpose(factId(saved.id), 1, [storagePurpose, 'workbook-assessment', teachingPurpose]),
        setPurpose(attemptId, 1, [storagePurpose, 'workbook-assessment', teachingPurpose]),
      ], 'c18-grant-teaching');
      expect(await workbook.examTimeValue(saved.id, attemptId, { purpose: teachingPurpose }))
        .toMatchObject({ kind: 'observed', paper: { id: saved.id, rev: 1 }, attempt_ref: { id: attemptId, rev: 2 } });
      await writeFacts(db, [setPurpose(attemptId, 2, [storagePurpose, 'workbook-assessment'])], 'c18-revoke-teaching');
      expect(await workbook.examTimeValue(saved.id, attemptId, { purpose: teachingPurpose })).toMatchObject({ kind: 'unknown' });
      await writeFacts(db, [setPurpose(attemptId, 3, [storagePurpose])], 'c18-revoke-assessment');
      const afterRevoke = await workbook.get(saved.id);
      const revokedAttempt = afterRevoke.attempts.find(item => item.id === attemptId)!;
      expect(revokedAttempt.formalAssessment?.state).toBe('blocked');
      expect(revokedAttempt.examTimeValue).toEqual({
        method_version: examTimeValueMethod, paper: { id: saved.id, rev: 1 }, attempt_ref: { id: attemptId, rev: 4 }, kind: 'unknown' });

    const storedAttempt = await db.snapshot({ learner }, tx => createCommandReadContext(tx, storagePurpose).fact(attempt2Id, { mode: 'following' }));
      const parsed = storedAttempt.value as Parameters<typeof projectWorkbookExamTimeValue>[0]['attempt'];
      expect(projectWorkbookExamTimeValue({
        paperRef: { id: factId(saved.id), rev: 2 as Revision }, attemptRef: { id: attempt2Id, rev: 1 as Revision },
        attempt: parsed, rawResult: quadrants,
      }).kind).toBe('unknown');
      expect(projectWorkbookExamTimeValue({
        paperRef: { id: factId(saved.id), rev: 1 as Revision }, attemptRef: { id: attempt2Id, rev: 1 as Revision },
        attempt: parsed, rawResult: quadrants.kind === 'observed' ? { ...quadrants, items: [...quadrants.items].reverse() } : quadrants,
      }).kind).toBe('unknown');
    } finally {
      await pythonHost.close();
    }
  }));
