import { expect, it } from 'vitest';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { withinLearnerTransaction } from '../../../kernel/src/db/learner.ts';
import type { DbTransaction } from '../../../kernel/src/db/types.ts';
import { commandId, derivationId, factId, type FactId, type FactSnapshot, type JsonObject, type Revision } from '../../../kernel/src/declarations/index.ts';
import { closedPosttest, issuePosttestCommand } from '../../../modules/activity/retention-posttest.ts';
import { saveWorkbookPaperCommand, submitWorkbookAttemptCommand, workbookGradingVersion } from '../../../modules/activity/workbook-values.ts';
import { saveWorkspaceEntryCommand, setWorkspaceTeachingCommand } from '../../../modules/activity/workspace-values.ts';
import { createKnowledgeEdgeCommand } from '../../../modules/content/knowledge-edge.ts';
import { seedCorrectionMicroVariant, correctionMicroVariantFixture as fixture } from '../../../modules/content/samples/fixtures/correction-micro-variant.ts';
import { localVerificationExecution } from '../../../modules/content/samples/fixtures/question.ts';
import { verificationSteps } from '../../../modules/content/question-effects.ts';
import { evaluateQuestionVerification, questionVerificationKey, questionVerificationMethodVersion, questionVerificationType } from '../../../modules/content/question-state.ts';
import { stableId } from '../identity.ts';
import { readCurrentQuestionVerification } from '../iqdb-verification.ts';
import { openTextbook } from '../textbook.ts';
import { loadStudioTestModule } from './modules.ts';

const learner = fixture.learner;
const witnessOf = (fact: FactSnapshot, mode: 'following' | 'pinned' = 'following') =>
  ({ ...fact.ref, type: fact.type, accessEpoch: fact.accessEpoch, mode });
type BacktraceFactory = NonNullable<Parameters<typeof openTextbook>[3]>['backtrace'];
const makePulseHost = (backtrace: BacktraceFactory = () => async () => null) => ({
  python: {
    async derive(_deriver: string, input: unknown) {
      const events = (input as { events?: { ref: string; rev: number; concept_ids: string[]; item_novelty: string; representation?: string | null; context?: string | null; method?: string | null }[] }).events ?? [];
      const grouped = new Map<string, { item_novelty: string; representation: string | null; context: string | null; method: string | null; refs: { ref: string; rev: number }[] }>();
      for (const event of events) {
        for (const conceptId of event.concept_ids) {
          const row = grouped.get(conceptId) ?? { item_novelty: event.item_novelty,
            representation: event.representation ?? null, context: event.context ?? null, method: event.method ?? null, refs: [] };
          row.refs.push({ ref: event.ref, rev: event.rev });
          grouped.set(conceptId, row);
        }
      }
      return { kind: 'ok' as const, outcome: { kind: 'value' as const, value: {
        anomalies: [], method_version: 'cognition@3', state_vector: [...grouped].map(([conceptId, row]) => ({
          state: 'known' as const, concept_id: conceptId, item_novelty: row.item_novelty,
          representation: row.representation, context: row.context, method: row.method,
          r_now: 0.8, effective_evidence: row.refs.length, evidence_refs: row.refs,
          uncertainty: { kind: 'interval' as const, low: 0.7, high: 0.9 },
        })),
      } } };
    },
  },
  backtrace,
});

type PulseConcept = { readonly conceptId: string; readonly state: string; readonly reason?: string; readonly candidate?: { readonly key: string }; readonly anchor?: { readonly kind: string; readonly href: string } };
type MasteryPulse = { readonly asOf: string; readonly blocks: readonly { readonly concepts?: readonly PulseConcept[] }[] };
const pulse = (view: unknown) => {
  const mastery = (view as { masteryPulse?: MasteryPulse }).masteryPulse;
  expect(mastery?.blocks?.length).toBeGreaterThan(0);
  return mastery!;
};
const concept = (view: unknown) => { const row = pulse(view).blocks[0]?.concepts?.[0]; if (!row) throw new Error('missing pulse concept'); return row; };

const bankIssuer = (db: Parameters<typeof createCommandHandler>[0], activity: Awaited<ReturnType<typeof loadStudioTestModule>>) =>
  async (tx: DbTransaction, input: { requestId: string; questionRefs: readonly { id: FactId; rev: Revision }[]; deletionWatermark?: string }) => {
    const bound = createCommandHandler(withinLearnerTransaction(db, tx), { modules: [activity], hooks: { async onFactsChanged() {} },
      bindCommandRead: (inner, _request, base) => ({ ...base, slot: readCurrentQuestionVerification(inner) }) });
    const paperId = factId(stableId('workbook-paper', input.requestId));
    await bound({ learner, actor: 'learner', purpose: 'storage',
      ...(input.deletionWatermark === undefined ? {} : { deletionWatermark: input.deletionWatermark }),
      id: commandId(stableId('save-workbook-paper', paperId)), type: saveWorkbookPaperCommand,
      input: { id: paperId, bankDraft: { title: '题库练习', materialId: null,
        questions: input.questionRefs.map(sourceQuestionRef => ({ sourceQuestionRef })) }, savedAt: new Date().toISOString() } });
    return { id: paperId };
  };

const setup = async (db: Parameters<typeof createCommandHandler>[0]) => {
  const [content, activity] = await Promise.all([loadStudioTestModule('content'), loadStudioTestModule('activity')]);
  const handle = createCommandHandler(db, { modules: [content, activity], hooks: { async onFactsChanged() {} } });
  const run = (type: string, key: string, input: JsonObject, purpose = 'storage') =>
    handle({ learner, actor: 'learner', purpose, id: commandId(stableId(key)), type, input });
  await seedCorrectionMicroVariant(db);
  return { content, run, issueBank: bankIssuer(db, activity) };
};

it.skipIf(!testDatabaseUrl)('keeps ordinary attempts without exposure coverage honestly unknown in PostgreSQL', () =>
  withLearnerDatabase(learner, async db => {
    const { content, run, issueBank } = await setup(db);
    const textbook = openTextbook(db, content, { async onFactsChanged() {} }, makePulseHost(), issueBank);
    const get = () => textbook.get({ learner, id: fixture.block.id, purpose: 'storage' });
    expect(concept(await get())).toEqual({ conceptId: fixture.concept, state: 'unknown', reason: 'no-independent-evidence' });
    const source = { id: fixture.input.source.id, rev: fixture.input.source.rev };
    const checks = verificationSteps.map(({ stepKey }, index) => ({ invocationId: `${source.id}:${stepKey}`,
      execution: localVerificationExecution((index + 1).toString(16)),
      result: { answerKey: '45', conditionKey: 'average-speed', reasoning: 'PRIVATE VERIFICATION REASONING', eligible: true } }));
    await db.query(`INSERT INTO derivations(learner_id,id,slot_type,slot_key,deriver,scope_keys,value,lifecycle,freshness,gather_tick,effective_tick,manifest)
      VALUES ($1,$2,$3,$4,$5,'{}',$6,'effective','current',4,4,$7)`, [learner, source.id, questionVerificationType,
      questionVerificationKey(source), fixture.deriver, JSON.stringify({ kind: 'value', value: evaluateQuestionVerification(
        { ...source, accessEpoch: fixture.input.source.accessEpoch, recheck: 0, methodVersion: questionVerificationMethodVersion }, checks) }),
      JSON.stringify({ version: 1, learner, purpose: 'teaching', gatherTick: '4',
        inputs: [{ kind: 'fact', mode: 'following', ...source, accessEpoch: fixture.input.source.accessEpoch }] })]);
    await db.query(`INSERT INTO slot_state(learner_id,slot_type,slot_key,current_id,scope_keys) VALUES ($1,$2,$3,$4,'{}')`,
      [learner, questionVerificationType, questionVerificationKey(source), source.id]);
    const seedPaper = (await db.tx({ learner }, tx => issueBank(tx, { requestId: 'pulse-seed-paper', questionRefs: [source], deletionWatermark: '0' }))).id;
    const attemptId = factId(stableId('pulse-seed-attempt'));
    await run(submitWorkbookAttemptCommand, 'pulse-seed-attempt', { id: attemptId, data: { paperId: seedPaper, requestId: 'pulse-seed-attempt',
      submittedAt: new Date().toISOString(), answers: { q1: JSON.stringify([{ slotId: 'answer', path: '', value: { kind: 'numeric', value: 45, unit: null } }]) },
      effectiveDurationMs: 30_000 } });
    expect(concept(await get())).toEqual({ conceptId: fixture.concept, state: 'unknown', reason: 'unavailable' });
    for (const id of [seedPaper, attemptId]) await run(setWorkspaceTeachingCommand, `pulse-grant-${id}`, { id, expectedRev: 1, enabled: true });
    expect(concept(await get())).toEqual({ conceptId: fixture.concept, state: 'unknown', reason: 'unavailable' });
  }));

it.skipIf(!testDatabaseUrl)('projects, gates, claims, and revokes textbook mastery pulse in PostgreSQL', () =>
  withLearnerDatabase(learner, async db => {
    const { content, run, issueBank } = await setup(db);
    const questionId = factId(stableId('pulse-controlled-question'));
    const prompt = '先以 30 km/h 行驶 1 小时，再以 60 km/h 行驶 1 小时，平均速度是多少？';
    await run(saveWorkspaceEntryCommand, 'save-pulse-question', { id: questionId, basis: [],
      entry: { kind: 'question', title: '平均速度受控题', body: prompt, tags: [], links: [], answer: '45' } });
    const use = { id: questionId, rev: 1, accessEpoch: '0' };
    await run(createKnowledgeEdgeCommand, 'pulse-edge-concept', { id: factId(stableId('pulse-edge-concept')), purpose: 'teaching', edge: {
      kind: 'targets_concept', from: { kind: 'question', sourceUse: use }, to: { kind: 'concept', sourceUse: { id: fixture.concept, rev: 1, accessEpoch: '0' } },
      sourceUses: [use, { id: fixture.concept, rev: 1, accessEpoch: '0' }], scope: 'average-speed' } });
    await run(createKnowledgeEdgeCommand, 'pulse-edge-variant', { id: factId(stableId('pulse-edge-variant')), purpose: 'teaching', edge: {
      kind: 'variant_of', from: { kind: 'question', sourceUse: use }, to: { kind: 'question', sourceUse: { id: fixture.input.source.id, rev: 1, accessEpoch: '0' } },
      sourceUses: [use, { id: fixture.input.source.id, rev: 1, accessEpoch: '0' }], scope: 'average-speed',
      variant: { familyId: 'average-speed', relation: 'numbers_only', preserved: ['两段速度'], changed: ['表述'], spoilsNext: 'none' } } });
    const now = Date.now();
    const paperId = factId(stableId('pulse-retention-paper'));
    await run(saveWorkbookPaperCommand, 'save-pulse-retention-paper', { id: paperId, condition: closedPosttest, data: {
      title: '平均速度受控卷', materialId: null, savedAt: new Date(now - 20_000).toISOString(),
      questions: [{ id: 'q1', kind: 'numeric', prompt, answer: 45, tolerance: 0, unit: null, explanation: null,
        sourceQuestionRef: { id: questionId, rev: 1 } }] } }, 'teaching');
    const sit = async (tag: string, startedOffsetMs: number, submittedOffsetMs: number) => {
      const posttestId = factId(stableId('pulse-posttest', tag)), submissionId = factId(stableId('pulse-submission', tag));
      await run(issuePosttestCommand, `issue-pulse-posttest-${tag}`, { id: posttestId, data: { condition: closedPosttest,
        gradingVersion: workbookGradingVersion, forecastId: derivationId(stableId('pulse-forecast', tag)),
        forecastKey: factId(stableId('pulse-fkey', tag)), effectiveTick: '0', paper: { id: paperId, rev: 1 }, paperEpoch: '0',
        itemId: 'q1', startedAt: new Date(now - startedOffsetMs).toISOString(), through: new Date(now + 60_000).toISOString() } }, 'teaching');
      await run(submitWorkbookAttemptCommand, `submit-pulse-posttest-${tag}`, { id: submissionId, condition: closedPosttest, data: {
        paperId: posttestId, requestId: `pulse-${tag}`, submittedAt: new Date(now - submittedOffsetMs).toISOString(),
        answers: { q1: '45' }, effectiveDurationMs: 30_000 } }, 'teaching');
      return { posttestId, submissionId };
    };
    const firstSitting = await sit('first', 10_000, 8_000), secondSitting = await sit('second', 5_000, 2_000);
    const textbook = openTextbook(db, content, { async onFactsChanged() {} }, makePulseHost((_tx, read) => async ({ question }) => {
      if (question.id !== questionId) return null;
      const [conceptFact, questionFact, earlierFact, laterFact, posttestFact] = await Promise.all([
        read.fact(fixture.concept, { mode: 'following' }), read.fact(questionId, { mode: 'pinned', rev: 1 as Revision }),
        read.fact(firstSitting.submissionId, { mode: 'following' }), read.fact(secondSitting.submissionId, { mode: 'following' }),
        read.fact(secondSitting.posttestId, { mode: 'following' }),
      ]);
      return [{ content: question, witnesses: [witnessOf(conceptFact), witnessOf(questionFact, 'pinned'),
        witnessOf(earlierFact), witnessOf(laterFact), witnessOf(posttestFact)] }];
    }), issueBank);
    const get = async (purpose = 'storage') => textbook.get({ learner, id: fixture.block.id, purpose });
    const authorized = await get();
    const covered = concept(authorized);
    expect(covered.state).toBe('steady');
    expect(covered.anchor?.kind).toBe('prior-stable');
    expect(covered.anchor?.href).toContain(`/materials/records/${questionId}?ref=`);
    if (!covered.candidate) throw new Error(JSON.stringify(pulse(authorized)));
    expect(covered.candidate.key).toBe(JSON.stringify([fixture.block.id, fixture.concept, fixture.second.id, 1]));
    await expect(textbook.claim({ learner, id: fixture.block.id }, {
      requestId: 'bad request id!', key: covered.candidate.key, deletionWatermark: '0',
    })).rejects.toMatchObject({ status: 400 });
    const issued = await textbook.claim({ learner, id: fixture.block.id }, { requestId: 'pulse-claim-1', key: covered.candidate.key, deletionWatermark: '0' });
    if (!issued) throw new Error('pulse claim returned null');
    expect(issued.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await expect(textbook.claim({ learner, id: fixture.block.id }, { requestId: 'pulse-claim-dup', key: covered.candidate.key, deletionWatermark: '0' })).rejects.toMatchObject({ status: 409 });
    await new Promise(resolve => setTimeout(resolve, 2));
    const after = await get();
    expect(pulse(after).asOf).not.toBe(pulse(authorized).asOf);
    expect(concept(after).state).toBe('steady');
    expect(concept(after).anchor).toEqual(covered.anchor);
    expect(concept(after).candidate).toBeUndefined();
    await run('content.setTextbookTeaching', 'pulse-revoke-teaching', { id: fixture.block.id, expectedRev: 1, enabled: false });
    expect((await get() as { masteryPulse?: unknown }).masteryPulse).toBeUndefined();
    await expect(get('teaching')).rejects.toMatchObject({ status: 403 });
    const unbound = openTextbook(db, content, { async onFactsChanged() {} });
    await expect(unbound.claim({ learner, id: fixture.block.id }, { requestId: 'pulse-claim-2', key: covered.candidate.key, deletionWatermark: '0' })).rejects.toMatchObject({ status: 404 });
  }));
