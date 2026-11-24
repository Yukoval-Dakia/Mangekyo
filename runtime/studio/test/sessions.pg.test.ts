import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCommandHandler } from '../../../kernel/src/commands/handle.ts';
import { createCommandReadContext } from '../../../kernel/src/commands/reads.ts';
import { commandId } from '../../../kernel/src/declarations/ids.ts';
import type { Db } from '../../../kernel/src/db/types.ts';
import { testDatabaseUrl, withLearnerDatabase } from '../../../kernel/test/learner-database.ts';
import { intakeWriteTargets } from '../intake.ts';
import { stableId, studioLearner } from '../identity.ts';
import { studyTurn } from '../../../modules/activity/values.ts';
import { attachmentCurrent } from '../reading.ts';
import { getSession, readOwnStudyTurn, openStudio } from '../sessions.ts';
import { loadStudioTestModule } from './modules.ts';

const baseUrl = 'http://127.0.0.1:9/v1';
const provider = {id: 'default', label: 'default', baseUrl, protocol: 'openai', model: 'm-test',
  reasoningEffort: 'high', apiKey: 'k', credentialRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7'} as const;
const route = {providerId: 'default', protocol: 'openai', baseUrl, model: 'm-test',
  reasoningEffort: 'high', accountRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7'} as const;
let dir: string, prevSettings: string | undefined, prevAccess: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mangekyo-sessions-'));
  prevSettings = process.env.MANGEKYO_SETTINGS_FILE;
  prevAccess = process.env.MANGEKYO_WORKSPACE_ACCESS_FILE;
  process.env.MANGEKYO_SETTINGS_FILE = join(dir, 'provider.json');
  process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = join(dir, 'access.json');
  writeFileSync(process.env.MANGEKYO_SETTINGS_FILE, JSON.stringify(
    {version: 2, activeProviderId: 'default', providers: [provider], mcpServers: []}));
});
afterEach(() => {
  if (prevSettings === undefined) delete process.env.MANGEKYO_SETTINGS_FILE; else process.env.MANGEKYO_SETTINGS_FILE = prevSettings;
  if (prevAccess === undefined) delete process.env.MANGEKYO_WORKSPACE_ACCESS_FILE; else process.env.MANGEKYO_WORKSPACE_ACCESS_FILE = prevAccess;
  rmSync(dir, {recursive: true, force: true});
});
const access = (enabled: boolean) => writeFileSync(process.env.MANGEKYO_WORKSPACE_ACCESS_FILE!, JSON.stringify(
  {version: 1, routes: {default: {enabled, baseUrl, protocol: 'openai', revision: 'wrev-1', credentialRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7'}}}));

async function material(db: Db, key: string, text: string, granted: boolean) {
  const activity = await loadStudioTestModule('activity');
  const capture = await loadStudioTestModule('capture');
  const content = await loadStudioTestModule('content');
  const handle = createCommandHandler(db, {modules: [activity, capture, content], hooks: {async onFactsChanged() {}},
    crossModuleWrites: {...intakeWriteTargets, 'activity.setWorkspaceTeaching': {set_purpose: ['activity.textMaterial']}}});
  const materialId = stableId('session-material', key);
  const intakeId = stableId('intake-document', materialId);
  await handle({learner: studioLearner, actor: 'learner', purpose: 'storage', type: 'activity.captureIntake',
    id: commandId(stableId('cap', materialId)), input: {materialId, intakeId, title: '材料',
      original: {name: 'doc.txt', mediaType: 'text/plain', size: text.length, sha256: 'a'.repeat(64)},
      extraction: {status: 'ok', method: 'utf8', text, error: null, warnings: [], pages: null, truncated: false, characterCount: text.length}}});
  if (granted) await handle({learner: studioLearner, actor: 'learner', purpose: 'storage', type: 'activity.setWorkspaceTeaching',
    id: commandId(stableId('grant', materialId)), input: {id: materialId, expectedRev: 1, enabled: true}});
  return materialId;
}
const saved = (db: Db, id: string) => db.snapshot({learner: studioLearner}, async tx =>
  studyTurn((await readOwnStudyTurn(tx, id)).value));

it.skipIf(!testDatabaseUrl)('enables workspace tools for authorized attachment turns and serves materialId-only reads', () =>
  withLearnerDatabase(studioLearner, async db => {
    const activity = await loadStudioTestModule('activity');
    const studio = await openStudio(db, activity);
    const text = '材料正文第一段。'.repeat(10) + '（整篇结束）';

    // materialId-only + workspace authorized + account confirmed → full tool stack
    access(true);
    const fullId = await material(db, 'full', text, true);
    const deniedId = await material(db, 'denied', '未授教学用途的材料。', false);
    const first = await studio.start('companion', 'req-full', '这材料讲了什么？', {id: fullId, mode: 'ask'}, undefined, route);
    const firstTurn = await saved(db, first.id);
    expect(firstTurn).toMatchObject({workspaceRevision: 'wrev-1', learningToolsVersion: 1, memoryVersion: 1,
      agentVersion: 2, accountRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7', accountConfirmation: 1});
    expect(firstTurn.attachmentBasis).toMatch(/^[0-9a-f]{64}$/);
    expect(firstTurn.attachment).toMatchObject({id: fullId, title: '材料', mode: 'ask'});
    expect(firstTurn.attachment!.text).toBe(text);

    // Follow-up on an authorized attachment origin keeps learning tools enabled.
    const followParent = stableId('session-follow');
    const followOrigin = {sessionId: followParent, caseId: 'companion', parentId: null, answer: '首轮',
      attachment: {id: fullId, title: '材料', text, mode: 'ask'}, attachmentBasis: firstTurn.attachmentBasis!,
      workspaceRevision: 'wrev-1', learningToolsVersion: 1, memoryVersion: 1, agentVersion: 2, allowSearch: false,
      accountRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7', accountConfirmation: 1,
      model: 'm-test', reasoningEffort: 'high', providerId: 'default', protocol: 'openai', baseUrl};
    const followHandle = createCommandHandler(db, {modules: [activity], hooks: {async onFactsChanged() {}}});
    await followHandle({learner: studioLearner, actor: 'learner', purpose: 'teaching', type: 'activity.submitTurn',
      id: commandId(stableId('follow-origin')), input: {id: followParent, data: followOrigin}});
    const epochOf = async (id: string) => (await db.snapshot({learner: studioLearner}, async tx =>
      (await tx.query<{epoch: string}>(`SELECT access_epoch::text AS epoch FROM facts WHERE learner_id=$1 AND id=$2`, [tx.learner, id])).rows[0]?.epoch))!;
    const fullEpoch = await epochOf(fullId), deniedEpoch = await epochOf(deniedId);
    await db.tx({learner: studioLearner}, tx => tx.withLearnerWrite(async tick => {
      const fbId = stableId('follow-fb');
      const manifest = JSON.stringify({version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick,
        inputs: [{kind: 'fact', id: followParent, rev: 1, accessEpoch: '0', mode: 'following'}]});
      await tx.insert('derivations', {learner_id: studioLearner, id: fbId, slot_type: 'activity.teachingFeedback',
        slot_key: followParent, deriver: 'activity/evidence-tutor-learning-tools-v1', scope_keys: '{}',
        value: JSON.stringify({action: 'companion_reply', model: 'm-test', rationale: 'ok', message: '首轮回复',
          evidenceIds: [], reads: [], trace: [],
          workspaceBasis: [{id: fullId, rev: 1, epoch: fullEpoch, type: 'activity.textMaterial'},
            {id: fullId, rev: 1, epoch: '999', type: 'activity.textMaterial'},
            {id: deniedId, rev: 1, epoch: deniedEpoch, type: 'activity.textMaterial'},
            {id: stableId('missing-basis'), rev: 1, epoch: '0', type: 'content.asset'}]}), lifecycle: 'effective', freshness: 'current',
        gather_tick: tick, effective_tick: tick, manifest});
      await tx.insert('slot_state', {learner_id: studioLearner, slot_type: 'activity.teachingFeedback',
        slot_key: followParent, current_id: fbId, last_id: fbId, changed_tick: tick, scope_keys: '{}'});
    }));
    const enriched = await getSession(db, followParent);
    expect(enriched.turns[0]?.workspaceBasis).toEqual([
      {id: fullId, rev: 1, epoch: fullEpoch, type: 'activity.textMaterial', title: '材料', kind: 'material'},
      {id: fullId, rev: 1, epoch: '999', type: 'activity.textMaterial'},
      {id: deniedId, rev: 1, epoch: deniedEpoch, type: 'activity.textMaterial'},
      {id: stableId('missing-basis'), rev: 1, epoch: '0', type: 'content.asset'},
    ]);
    const follow = await studio.answer(followParent, followParent, '继续追问', 'req-follow', undefined, route);
    expect(await saved(db, follow.currentTurnId)).toMatchObject(
      {workspaceRevision: 'wrev-1', learningToolsVersion: 1, memoryVersion: 1, agentVersion: 2});

    // A legacy origin with attachment but no learningToolsVersion stays on the old lane.
    const legacyParent = stableId('session-legacy');
    const {learningToolsVersion: _lt, memoryVersion: _mv, workspaceRevision: _wr, ...rest} = followOrigin;
    const legacyOrigin = {...rest, sessionId: legacyParent, agentVersion: 1};
    await followHandle({learner: studioLearner, actor: 'learner', purpose: 'teaching', type: 'activity.submitTurn',
      id: commandId(stableId('legacy-origin')), input: {id: legacyParent, data: legacyOrigin}});
    await db.tx({learner: studioLearner}, tx => tx.withLearnerWrite(async tick => {
      const fbId = stableId('legacy-fb');
      const manifest = JSON.stringify({version: 1, learner: studioLearner, purpose: 'teaching', gatherTick: tick,
        inputs: [{kind: 'fact', id: legacyParent, rev: 1, accessEpoch: '0', mode: 'following'}]});
      await tx.insert('derivations', {learner_id: studioLearner, id: fbId, slot_type: 'activity.teachingFeedback',
        slot_key: legacyParent, deriver: 'activity/evidence-tutor-confirmed-v1', scope_keys: '{}',
        value: JSON.stringify({action: 'companion_reply', model: 'm-test', rationale: 'ok', message: '首轮回复',
          evidenceIds: [], reads: [], trace: []}), lifecycle: 'effective', freshness: 'current',
        gather_tick: tick, effective_tick: tick, manifest});
      await tx.insert('slot_state', {learner_id: studioLearner, slot_type: 'activity.teachingFeedback',
        slot_key: legacyParent, current_id: fbId, last_id: fbId, changed_tick: tick, scope_keys: '{}'});
    }));
    const legacy = await studio.answer(legacyParent, legacyParent, '继续追问', 'req-legacy', undefined, route);
    const legacyTurn = await saved(db, legacy.currentTurnId);
    expect(legacyTurn.workspaceRevision).toBeUndefined();
    expect(legacyTurn.learningToolsVersion).toBeUndefined();
    expect(legacyTurn.memoryVersion).toBeUndefined();

    // Full attachment still works and keeps the same enabled lane.
    const excerpt = await studio.start('companion', 'req-excerpt', '解释选段',
      {id: fullId, title: '材料', text: '材料正文第一段。', mode: 'ask'}, undefined, route);
    expect(await saved(db, excerpt.id)).toMatchObject({workspaceRevision: 'wrev-1', learningToolsVersion: 1, agentVersion: 2});

    // Forged excerpt is still rejected before any grant downgrade is considered.
    await expect(studio.start('companion', 'req-forged', '伪造',
      {id: fullId, title: '材料', text: '不在原文里的伪造选段', mode: 'ask'}, undefined, route)).rejects.toMatchObject({status: 400});

    // Fresh storage-only material (just captured, no teaching grant yet) can be
    // handed to the companion via materialId: the learner's explicit pick is the grant.
    const freshId = await material(db, 'fresh', '刚拍材料未授教学。', false);
    const fresh = await studio.start('companion', 'req-fresh', '刚拍的卷子问同伴', {id: freshId, mode: 'ask'}, undefined, route);
    expect(await saved(db, fresh.id)).toMatchObject({workspaceRevision: 'wrev-1', learningToolsVersion: 1,
      memoryVersion: 1, agentVersion: 2});

    // Without workspace access the same confirmed attachment turn degrades to agent v1.
    access(false);
    const plain = await studio.start('companion', 'req-plain', '自由问', {id: fullId, mode: 'ask'}, undefined, route);
    const plainTurn = await saved(db, plain.id);
    expect(plainTurn).toMatchObject({agentVersion: 1, accountRevision: 'b3ce6da0-a112-4ac1-a78f-fcf5007b63f7', accountConfirmation: 1});
    expect(plainTurn.workspaceRevision).toBeUndefined();
    expect(plainTurn.learningToolsVersion).toBeUndefined();
    expect(plainTurn.memoryVersion).toBeUndefined();
    expect(plainTurn.attachmentBasis).toMatch(/^[0-9a-f]{64}$/);

    // Nonexistent material is rejected.
    await expect(studio.start('companion', 'req-missing', '读取', {id: stableId('session-material', 'missing'), mode: 'ask'},
      undefined, route)).rejects.toMatchObject({status: 400});

    // Long materials hydrate from the server and bind the basis without client truncation.
    access(true);
    const longText = '长材料正文。'.repeat(3000);
    const longId = await material(db, 'long', longText, true);
    const long = await studio.start('companion', 'req-long', '读长材料', {id: longId, mode: 'prepare'}, undefined, route);
    const longTurn = await saved(db, long.id);
    expect(longTurn.attachment!.text.length).toBeGreaterThan(3000);
    expect(longTurn.attachment!.text.length).toBeLessThanOrEqual(16_000);
    expect(longTurn.attachmentBasis).toMatch(/^[0-9a-f]{64}$/);
    expect(longTurn).toMatchObject({workspaceRevision: 'wrev-1', learningToolsVersion: 1, agentVersion: 2});

    // teach-path revalidation: correcting the intake text invalidates attachmentCurrent
    // for the already-persisted turn (rev/epoch drift breaks the basis digest).
    const intakeId = stableId('intake-document', fullId);
    const corrected = await db.snapshot({learner: studioLearner}, async tx => {
      const act = await loadStudioTestModule('activity');
      const cap = await loadStudioTestModule('capture');
      const cont = await loadStudioTestModule('content');
      const h = createCommandHandler(db, {modules: [act, cap, cont], hooks: {async onFactsChanged() {}},
        crossModuleWrites: {...intakeWriteTargets, 'activity.setWorkspaceTeaching': {set_purpose: ['activity.textMaterial']}}});
      await h({learner: studioLearner, actor: 'learner', purpose: 'storage', type: 'activity.correctIntakeText',
        id: commandId(stableId('correct', fullId)), input: {materialId: fullId, intakeId, expectedRev: 1, text: '更正后的正文。'}});
      return attachmentCurrent(tx, firstTurn);
    });
    expect(corrected).toBe(false);
  }));
