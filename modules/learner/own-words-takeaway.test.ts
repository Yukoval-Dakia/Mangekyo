import type { FactSnapshot } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { learner, ref, snapshot, use } from './test/facts.ts';
import { projectOwnWordsTakeaway, type OwnWordsTakeawayInput, type OwnWordsTakeawayRead } from './own-words-takeaway.ts';
import type { CanonicalEvidenceSliceV1, Tick } from '@mangekyo/kernel';

const at = (day: number) => new Date(day * 86_400_000).toISOString();
const [conceptW, takeawayW, submissionW, displayW] =
  [use(1, 'content.asset'), use(2, 'companion.claim'), use(3, 'activity.workbookAttempt'), use(4, 'activity.helpExposure'), use(5, 'activity.studyTurn')];
const issuance = {id: 'issuance-1', rev: ref(1).rev};
const display = {display: displayW, content: takeawayW, admittedAt: '6' as Tick, activityId: 'activity-1', itemId: 'q1', issuance, learnerRequested: true as const};
const slice = (outcome: 'correct' | 'incorrect', help: 'independent' | 'hinted' = 'independent'): CanonicalEvidenceSliceV1 => ({
  clock_watermark: '9', as_of_at: at(8),
  events: [{ref: submissionW.id, rev: submissionW.rev, occurred_at: at(7), concept_ids: [conceptW.id], item_novelty: 'same', help_level: help, outcome, claim_ids: [], ...(outcome === 'incorrect' ? {error_stage: 'strategy' as const} : {})}],
  constraints: {budget_min: null, locks: [], deadlines: []}, candidate_pool: []});
const claim = (text = '先查定义域') => ({version: 1, authority: 'directive', category: 'claim', origin: 'learner', action: 'remember',
  scope: {kind: 'object', object: conceptW.id, basis: [{...ref(1)}]}, evidence_refs: [], supersedes: null, sticky: true, text, valid_until: null});
const facts = new Map<unknown, FactSnapshot>([
  [conceptW.id, snapshot(conceptW, {kind: 'concept'}, ['storage'])],
  [takeawayW.id, snapshot(takeawayW, claim(), ['storage'])],
  [submissionW.id, snapshot(submissionW, {}, ['storage'])],
  [displayW.id, snapshot(displayW, {kind: 'displayed', learnerRequested: true, mount: {activityId: 'activity-1', issuance, item: {itemId: 'q1'}}, alsoAppliesTo: [], content: {id: takeawayW.id, rev: takeawayW.rev}, step: {kind: 'hint', order: 1}}, ['storage'])],
]);
const read: OwnWordsTakeawayRead = {scope: {learner, purpose: 'storage', recipient: 'learner-home'},
  reopen: async (_scope: OwnWordsTakeawayRead['scope'], row: Parameters<OwnWordsTakeawayRead['reopen']>[1]) => facts.get(row.id)};
const input = (partial: Partial<OwnWordsTakeawayInput> = {}): OwnWordsTakeawayInput => ({
  takeaway: takeawayW, takeawayAdmittedAt: '5' as Tick, concept: conceptW, submission: submissionW,
  submissionAdmittedAt: '7' as Tick, itemId: 'q1', slice: slice('correct', 'hinted'), phase: 'during-attempt', ...partial});

it('returns the learner-written L0 only after a witnessed pre-submit display', async () => {
  await expect(projectOwnWordsTakeaway(read, input({l0Display: display})))
    .resolves.toEqual({kind: 'echo', text: '先查定义域', evidence: [takeawayW, displayW]});
  for (const l0Display of [undefined, {...display, learnerRequested: false as never}, {...display, admittedAt: '7' as Tick},
    {...display, itemId: 'q2'}, {...display, display: use(8, 'activity.helpExposure')}])
    await expect(projectOwnWordsTakeaway(read, input({l0Display}))).resolves.toMatchObject({kind: 'hidden'});
});

it('hides post-submit echoes unless the current attempt stayed independent and authorized', async () => {
  await expect(projectOwnWordsTakeaway(read, input({phase: 'post-submit', slice: slice('correct')})))
    .resolves.toEqual({kind: 'positive-review', concept: conceptW.id, submittedAt: at(7),
      takeawayAdmittedAt: '5', submissionAdmittedAt: '7', evidence: [takeawayW, submissionW, conceptW]});
  await expect(projectOwnWordsTakeaway(read, input({phase: 'post-submit', slice: slice('correct', 'hinted')}))).resolves.toEqual({kind: 'hidden', reason: 'stale-evidence'});
  await expect(projectOwnWordsTakeaway(read, input({phase: 'post-submit', l0Display: display}))).resolves.toEqual({kind: 'hidden', reason: 'stale-evidence'});
  await expect(projectOwnWordsTakeaway(read, input({phase: 'post-submit', slice: slice('incorrect')})))
    .resolves.toEqual({kind: 'error-review', text: '先查定义域', errorStage: 'strategy', evidence: [takeawayW, submissionW, conceptW]});
});

it('rejects forged content and stale authorization without leaking the takeaway', async () => {
  const wrong = {...facts.get(takeawayW.id)!, value: claim('不显示这句')};
  const revoked = {...read, reopen: async (scope: OwnWordsTakeawayRead['scope'], row: Parameters<OwnWordsTakeawayRead['reopen']>[1]) =>
    row.id === takeawayW.id ? {...wrong, purpose: ['teaching']} : facts.get(row.id)};
  await expect(projectOwnWordsTakeaway(revoked, input({l0Display: display}))).resolves.toMatchObject({kind: 'hidden'});
  await expect(projectOwnWordsTakeaway(read, input({slice: {...slice('correct'), clock_watermark: '6'}}))).resolves.toEqual({kind: 'hidden', reason: 'unknown'});
});
