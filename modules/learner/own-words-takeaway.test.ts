import type { FactSnapshot } from '@mangekyo/kernel';
import { expect, it } from 'vitest';
import { learner, ref, snapshot, use } from './test/facts.ts';
import { projectOwnWordsTakeaway, type OwnWordsTakeawayDuringAttemptInput, type OwnWordsTakeawayPostSubmitInput, type OwnWordsTakeawayRead } from './own-words-takeaway.ts';
import type { CanonicalEvidenceSliceV1, Tick } from '@mangekyo/kernel';

const at = (day: number) => new Date(day * 86_400_000).toISOString();
const [conceptW, takeawayW, submissionW, displayW] = [use(1, 'content.asset'), use(2, 'companion.claim'), use(3, 'activity.workbookAttempt'), use(4, 'activity.helpExposure')];
const issuance = {id: 'issuance-1', rev: ref(1).rev};
const display = {display: displayW, content: takeawayW, admittedAt: '6' as Tick, activityId: 'activity-1', itemId: 'q1', issuance, learnerRequested: true as const};
const event = (outcome: 'correct' | 'incorrect', help: 'independent' | 'hinted') => ({ref: submissionW.id, rev: submissionW.rev, occurred_at: at(7), concept_ids: [conceptW.id], item_novelty: 'same' as const, help_level: help, outcome, claim_ids: [], ...(outcome === 'incorrect' ? {error_stage: 'strategy' as const} : {})});
const slice = (outcome: 'correct' | 'incorrect', help: 'independent' | 'hinted' = 'independent', omissions: CanonicalEvidenceSliceV1['omissions'] = []): CanonicalEvidenceSliceV1 => ({clock_watermark: '9', as_of_at: at(8), events: [event(outcome, help)], omissions, constraints: {budget_min: null, locks: [], deadlines: []}, candidate_pool: []});
const claim = {version: 1, authority: 'directive', category: 'claim', origin: 'learner', action: 'remember', scope: {kind: 'object', object: conceptW.id, basis: [{...ref(1)}]}, evidence_refs: [], supersedes: null, sticky: true, text: '先查定义域', valid_until: null};
const help = (step: {kind: string; order: number}, itemId = 'q1', alsoAppliesTo: readonly {itemId: string}[] = []) => ({kind: 'displayed', learnerRequested: true, mount: {activityId: 'activity-1', issuance, item: {itemId}}, alsoAppliesTo, content: {id: takeawayW.id, rev: takeawayW.rev}, step});
const facts = new Map<unknown, FactSnapshot>([[conceptW.id, snapshot(conceptW, {kind: 'concept'}, ['storage'])], [takeawayW.id, snapshot(takeawayW, claim, ['storage'])], [submissionW.id, snapshot(submissionW, {}, ['storage'])], [displayW.id, snapshot(displayW, help({kind: 'hint', order: 1}), ['storage'])]]);
const read: OwnWordsTakeawayRead = {scope: {learner, purpose: 'storage', recipient: 'learner-home'}, reopen: async (_scope: OwnWordsTakeawayRead['scope'], row: Parameters<OwnWordsTakeawayRead['reopen']>[1]) => facts.get(row.id)};
const during = (partial: Partial<OwnWordsTakeawayDuringAttemptInput> = {}): OwnWordsTakeawayDuringAttemptInput => ({takeaway: takeawayW, takeawayAdmittedAt: '5' as Tick, concept: conceptW, itemId: 'q1', clockWatermark: '9' as Tick, phase: 'during-attempt', ...partial});
const post = (partial: Partial<OwnWordsTakeawayPostSubmitInput> = {}): OwnWordsTakeawayPostSubmitInput => ({takeaway: takeawayW, takeawayAdmittedAt: '5' as Tick, concept: conceptW, submission: submissionW, submissionAdmittedAt: '7' as Tick, itemId: 'q1', slice: slice('correct'), exposureCoverage: 'complete', phase: 'post-submit', ...partial});

it('echoes during an attempt without submission and only after a witnessed L0 display', async () => {
  await expect(projectOwnWordsTakeaway(read, during({l0Display: display}))).resolves.toEqual({kind: 'echo', text: '先查定义域', evidence: [takeawayW, displayW]});
  for (const l0Display of [undefined, {...display, display: use(8, 'activity.helpExposure')}, {...display, admittedAt: '4' as Tick}])
    await expect(projectOwnWordsTakeaway(read, during({l0Display}))).resolves.toMatchObject({kind: 'hidden'});
});

it('keeps post-submit review independent and conservatively withholds uncertain evidence', async () => {
  await expect(projectOwnWordsTakeaway(read, post({takeawaySavedAt: at(6)}))).resolves.toMatchObject({kind: 'positive-review', takeawaySavedAt: at(6)});
  await expect(projectOwnWordsTakeaway(read, post({l0Display: {...display, admittedAt: '8' as Tick}}))).resolves.toMatchObject({kind: 'positive-review'});
  for (const input of [post({exposureCoverage: 'incomplete'}), post({slice: slice('correct', 'independent', [{ref: {id: 'other', rev: 1}, reason: 'unattributed'}])}), post({takeawayAdmittedAt: '7' as Tick}), post({l0Display: display})])
    await expect(projectOwnWordsTakeaway(read, input)).resolves.toMatchObject({kind: 'hidden'});
});

it('does not fail open when pre-submit display authorization was revoked', async () => {
  const revoked = {...read, reopen: async (_scope: OwnWordsTakeawayRead['scope'], row: Parameters<OwnWordsTakeawayRead['reopen']>[1]) => row.id === displayW.id ? undefined : facts.get(row.id)};
  await expect(projectOwnWordsTakeaway(revoked, post({l0Display: display}))).resolves.toEqual({kind: 'hidden', reason: 'stale-evidence'});
});

it('honors the extended L0 protocol and blocks future-epoch witnesses', async () => {
  facts.set(displayW.id, snapshot(displayW, help({kind: 'hint_l0', order: 0}, 'q2', [{itemId: 'q1'}]), ['storage']));
  await expect(projectOwnWordsTakeaway(read, during({l0Display: display}))).resolves.toMatchObject({kind: 'echo'});
  for (const input of [during({takeaway: {...takeawayW, accessEpoch: '10' as Tick}}), during({concept: {...conceptW, accessEpoch: '10' as Tick}}), post({submission: {...submissionW, accessEpoch: '10' as Tick}}), post({l0Display: {...display, display: {...displayW, accessEpoch: '10' as Tick}}})])
    await expect(projectOwnWordsTakeaway(read, input)).resolves.toMatchObject({kind: 'hidden'});
});

it('labels error reviews with the actual independent or hinted basis', async () => {
  await expect(projectOwnWordsTakeaway(read, post({slice: slice('incorrect', 'independent')}))).resolves.toMatchObject({kind: 'error-review', helpLevel: 'independent'});
  await expect(projectOwnWordsTakeaway(read, post({slice: slice('incorrect', 'hinted')}))).resolves.toMatchObject({kind: 'error-review', helpLevel: 'hinted'});
});
