import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { applyFactWrites } from '../../../kernel/src/commands/writes.ts';
import { createPgDb } from '../../../kernel/src/db/pg.ts';
import { commandId, factId } from '../../../kernel/src/declarations/ids.ts';
import { loadModuleDirectory } from '../../../kernel/src/loader.ts';
import { applyKernelSchema } from '../../../kernel/src/schema.ts';
import {
  workbookRubricAssessmentType as slotType,
  workbookRubricAssessmentVersion as assessmentVersion,
} from '../../../modules/activity/workbook-values.ts';
import { stableId, studioLearner as learner } from '../identity.ts';
import { readTeachingAttemptAssessments } from '../learning-attempt-read.ts';
import { openWorkbook } from '../workbook.ts';

const connectionString = process.env.MANGEKYO_TEST_DATABASE_URL;
assert.ok(connectionString, 'Set MANGEKYO_TEST_DATABASE_URL to an isolated PostgreSQL database');
const schema = 'attempt_read_' + randomUUID().replaceAll('-', '');
const pool = new pg.Pool({ connectionString });
const db = createPgDb(pool, { schema });
const scope = { learner };
const teaching = { purpose: 'teaching', recipientEligible: true };
const open = (tx, id, purpose = 'storage') => createCommandReadContext(tx, purpose).fact(id, { mode: 'following' });

try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await applyKernelSchema(db);
  await db.query('INSERT INTO learners (id) VALUES ($1)', [learner]);
  const activity = await loadModuleDirectory(fileURLToPath(new URL('../../../modules/activity', import.meta.url)));
  const workbook = openWorkbook(db, activity);
  const rubric = '解释水蒸气怎样凝结。总分 3 分。';
  const paper = await workbook.save({
    requestId: randomUUID(), title: '水的变化', materialId: null,
    questions: [{ kind: 'rubric', prompt: '水蒸气遇冷会怎样？', rubric }],
  });
  const paperId = factId(paper.id);
  const [{ id: questionId, rubricVersion }] = paper.questions;
  const answer1 = '水蒸气遇冷变成小水滴';
  const answer2 = '只写了遇冷';
  async function submit(answer) {
    const requestId = randomUUID();
    const result = await workbook.submit(paper.id, { requestId, answers: { [questionId]: answer } });
    return factId(result.attempts.find(attempt => attempt.requestId === requestId).id);
  }
  const first = await submit(answer1);
  const second = await submit(answer2);

  const change = (id, build) => db.tx(scope, tx => tx.withLearnerWrite(async tick => {
    const current = await open(tx, id);
    await applyFactWrites(tx, tick, [{ id, expectedRev: current.ref.rev, ...build(current.value) }], {
      commandId: commandId(stableId(randomUUID())), actor: 'learner', purpose: 'storage',
    }, activity.facts);
  }));
  const setPurpose = (id, purpose) => change(id, () => ({ kind: 'set_purpose', purpose }));
  const readTeaching = (id, authorization = teaching) => db.snapshot(scope, async tx => {
    const attempt = await open(tx, id, teaching.purpose);
    return readTeachingAttemptAssessments(tx, attempt, authorization);
  });
  const student = async id => (await workbook.get(paperId)).attempts.find(attempt => attempt.id === id);

  // Seed the legacy assessment shape without sending an answer to a provider.
  const grade = (attemptId, quote, earned) => db.tx(scope, tx => tx.withLearnerWrite(async tick => {
    const slotKey = stableId('workbook-rubric-assessment', attemptId, questionId, rubricVersion, rubric);
    const requestId = randomUUID();
    const id = stableId('assessment-fixture', requestId);
    const keys = JSON.stringify({ paperId, attemptId });
    const records = await Promise.all([open(tx, paperId), open(tx, attemptId)]);
    const manifest = { version: 1, learner, purpose: 'storage', gatherTick: tick,
      inputs: records.map(({ ref, accessEpoch }) => ({
        kind: 'fact', id: ref.id, rev: ref.rev, accessEpoch, mode: 'following',
      })),
    };
    const value = {
      attemptId, paperId, questionId, rubricVersion, rubric, assessmentVersion, requestId,
      assessedAt: new Date().toISOString(), consent: 'send-question-answer-rubric',
      providerBaseUrl: 'https://provider.invalid/', publicSearchQuery: 'private audit field', trace: ['private trace'],
      verdict: 'partial', feedback: '已指出遇冷，继续说明相变。', evidence: [quote], score: { earned, maximum: 3 },
    };
    await tx.query(`UPDATE derivations SET lifecycle='superseded',selection_ended_tick=$4
      WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3 AND lifecycle='effective'`,
    [learner, slotType, slotKey, tick]);
    await tx.insert('derivations', {
      learner_id: learner, id, slot_type: slotType, slot_key: slotKey, deriver: assessmentVersion,
      scope_keys: keys, value: JSON.stringify(value), lifecycle: 'effective', freshness: 'current',
      gather_tick: tick, effective_tick: tick, manifest: JSON.stringify(manifest),
    });
    await tx.query(`INSERT INTO slot_state (learner_id,slot_type,slot_key,current_id,last_id,changed_tick,scope_keys)
      VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT (learner_id,slot_type,slot_key)
      DO UPDATE SET current_id=EXCLUDED.current_id,last_id=EXCLUDED.last_id,changed_tick=EXCLUDED.changed_tick`,
    [learner, slotType, slotKey, id, tick, keys]);
    return { id, slotKey, value, manifest };
  }));

  await setPurpose(first, ['storage', 'teaching']);
  await setPurpose(second, ['storage', 'teaching']);
  const old = await grade(first, answer1, 1);
  assert.equal((await student(first)).assessments[0].id, old.id);
  assert.equal((await workbook.review()).find(entry => entry.paperId === paperId)?.explanation, old.value.feedback);
  assert.deepEqual(await readTeaching(first), [], 'A storage-only paper cannot authorize the teaching read');

  await setPurpose(paperId, ['storage', 'teaching']);
  await grade(first, answer1, 1);
  const accepted = await grade(first, answer1, 2);
  const other = await grade(second, answer2, 1);
  const [displayed] = (await student(first)).assessments;
  assert.equal(displayed.id, accepted.id);
  const { feedback, evidence, score, verdict } = displayed;
  assert.deepEqual(await readTeaching(first), [{
    attempt: { learner, id: first, rev: accepted.manifest.inputs[1].rev },
    questionId, rubricVersion, feedback, evidence, score, verdict,
    ref: { kind: 'slot', slotType, slotKey: accepted.slotKey, derivationId: accepted.id, mode: 'following' },
  }]);
  assert.equal(score.earned, 2);
  assert.deepEqual((await readTeaching(second)).map(item => item.ref.derivationId), [other.id]);
  assert.deepEqual(await readTeaching(first, { ...teaching, recipientEligible: false }), []);
  assert.deepEqual(await readTeaching(first, { ...teaching, purpose: 'storage' }), []);

  await db.query('UPDATE derivations SET is_shadow=true WHERE learner_id=$1 AND id=$2', [learner, accepted.id]);
  assert.deepEqual(await readTeaching(first), [], 'A shadow current pointer cannot expose the grade or fall back to history');
  await db.query("UPDATE derivations SET is_shadow=false,lifecycle='stale' WHERE learner_id=$1 AND id=$2", [learner, accepted.id]);
  assert.deepEqual(await readTeaching(first), []);
  await db.query("UPDATE derivations SET lifecycle='effective',value=jsonb_set(value,'{rubricVersion}','\"rubric-v2\"') WHERE learner_id=$1 AND id=$2",
    [learner, accepted.id]);
  assert.deepEqual(await readTeaching(first), []);
  await db.query('UPDATE derivations SET value=$3 WHERE learner_id=$1 AND id=$2',
    [learner, accepted.id, JSON.stringify(accepted.value)]);

  const corrected = answer1 + '，这是液化。';
  await change(first, value => ({ kind: 'correct', data: {
    ...value, answers: { [questionId]: corrected },
    feedback: value.feedback.map(item => ({ ...item, answer: corrected })),
  } }));
  assert.deepEqual(await readTeaching(first), []);
  assert.equal((await student(first)).answers[questionId], corrected);
  assert.deepEqual((await student(first)).assessments, []);

  // A pinned old attempt can still validate as a source, but cannot grade the newly opened revision.
  accepted.manifest.inputs[1].mode = 'pinned';
  await db.query('UPDATE derivations SET manifest=$3 WHERE learner_id=$1 AND id=$2',
    [learner, accepted.id, JSON.stringify(accepted.manifest)]);
  assert.equal((await student(first)).assessments[0].id, accepted.id);
  assert.deepEqual(await readTeaching(first), []);

  await setPurpose(paperId, ['storage']);
  assert.deepEqual(await readTeaching(second), []);
  assert.equal((await student(second)).answers[questionId], answer2);
  console.log('PASS storage and teaching parity, recipient/source authorization, two attempts, historical/shadow/stale grades, rubric and attempt revisions');
} finally {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await db.close();
  }
}
