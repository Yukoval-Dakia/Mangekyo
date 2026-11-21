import { describe, expect, it } from 'vitest';
import { derivationId, factId, type FactSnapshot, type ReadContext } from '@mangekyo/kernel';
import { planReview, readEligibleReview, retentionReviewAnchor, reviewDedupKey, reviewGoal, type ReviewAccess } from './worksheet-policy.ts';
import { researchPurpose, researchSettingsType, retentionReviewPermissionType } from './research.ts';
import type { WorkerConsent } from './worker-consent.ts';

const settingsId = factId('01ARZ3NDEKTSV4RRFFQ69G5FA1');
const retentionFactId = factId('01ARZ3NDEKTSV4RRFFQ69G5FA2');
const attemptFactId = factId('01ARZ3NDEKTSV4RRFFQ69G5FA3');
const reconciliationKey = factId('01ARZ3NDEKTSV4RRFFQ69G5FA4');
const reconciliationResultId = derivationId('01ARZ3NDEKTSV4RRFFQ69G5FA5');
const expiresAtMs = Date.now() + 3_600_000;

const grantFor = (profile: WorkerConsent['profile']): WorkerConsent => ({
  profile, providerId: 'loopback', accountRevision: 'rev-1', model: 'loopback-v1',
  route: 'local-research', maxRetentionDays: 1, maxPerCallMicros: 7, limitMicros: 14, expiresAtMs,
  ...(profile === 'deep_analyst' && { comparisonAttemptId: attemptFactId, comparisonRevision: 1, comparisonAccessEpoch: '0' }),
});

function makeAccess(source: FactSnapshot, workerGrant: WorkerConsent | null, independent = false): ReviewAccess {
  const settingsFact = {
    ref: { id: settingsId, rev: 2 }, type: researchSettingsType, accessEpoch: '0', purpose: [researchPurpose],
    value: { enabled: true, coordinatorRef: '00000000-0000-4000-8000-000000000001', scoutConsent: null, workerGrant },
  } as unknown as FactSnapshot;
  const facts = new Map([[settingsId, settingsFact], [source.ref.id, source]]);
  const read = { fact: async (id: ReturnType<typeof factId>) => facts.get(id)! } as unknown as ReadContext;
  return {
    read,
    open: async id => facts.get(id) ?? null,
    independent: async () => independent,
    retention: async fact => fact.type === retentionReviewPermissionType
      ? { key: reconciliationKey, resultId: reconciliationResultId, allowed: true } : null,
    material: async () => true,
  };
}

function makeSpec(id: ReturnType<typeof factId>, anchor: string, workerProfile = 'deterministic_compute', budgetCap = 0) {
  const sourceFactRev = { id, revision: 3, accessEpoch: '0', anchor };
  return {
    dedupKey: reviewDedupKey(sourceFactRev), sourceFactRev, refs: [], workerProfile, budgetCap,
    goal: reviewGoal, autonomyTier: 1, expiresAtMs, settingsRevision: 2,
  };
}

describe('retention worksheet policy', () => {
  const retentionSource = {
    ref: { id: retentionFactId, rev: 3 }, type: retentionReviewPermissionType, accessEpoch: '0',
    purpose: [researchPurpose], value: { key: reconciliationKey, resultId: reconciliationResultId, allowed: true },
  } as unknown as FactSnapshot;

  it('plans and authorizes heavy_tutor_prep for retention misses with non-leaking evidence', async () => {
    const grant = grantFor('heavy_tutor_prep');
    const access = makeAccess(retentionSource, grant, false);
    const planned = await planReview(access, makeSpec(retentionFactId, retentionReviewAnchor), grant, 7);
    expect(planned).toMatchObject({ workerProfile: 'heavy_tutor_prep', budgetCap: 7, refs: [] });
    const eligible = await readEligibleReview(access, planned!, settingsId, () => 7);
    expect(eligible).toMatchObject({
      evidence: null,
      retention: {
        kind: 'retention_posttest_miss', reconciliationKey, resultId: reconciliationResultId,
        forecast: 'correct', observation: 'incorrect', exposure: 'independent', href: `/api/retention/${reconciliationKey}`,
      },
    });
  });

  it('blocks non-prep model profiles on retention and preserves independent checks on workbook attempts', async () => {
    for (const profile of ['deep_analyst', 'question_author'] as const) {
      const grant = grantFor(profile);
      const access = makeAccess(retentionSource, grant, false);
      const planned = await planReview(access, makeSpec(retentionFactId, retentionReviewAnchor), grant, 7);
      expect(planned?.workerProfile).toBe('deterministic_compute');
      expect(await readEligibleReview(access, makeSpec(retentionFactId, retentionReviewAnchor, profile, 7), settingsId, () => 7)).toBeNull();
    }
    const attemptSource = {
      ref: { id: attemptFactId, rev: 3 }, type: 'activity.workbookAttempt', accessEpoch: '0',
      purpose: [researchPurpose], value: {},
    } as unknown as FactSnapshot;
    const grant = grantFor('heavy_tutor_prep');
    const access = makeAccess(attemptSource, grant, false);
    expect((await planReview(access, makeSpec(attemptFactId, 'q1'), grant, 7))?.workerProfile).toBe('deterministic_compute');
    expect(await readEligibleReview(access, makeSpec(attemptFactId, 'q1', 'heavy_tutor_prep', 7), settingsId, () => 7)).toBeNull();
  });
});
