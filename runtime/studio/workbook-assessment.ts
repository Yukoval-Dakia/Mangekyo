import { createHash } from 'node:crypto';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, learnerId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, readWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { checkAssessmentPublication, type ReadVerifiedAssessmentPublicationEvidence } from '../../modules/activity/assessment-publication.ts';
import {
  assessmentSubmission, settledAssessmentState, type FormalAssessmentValue,
  type AssessmentRelease, type AssessmentRevisionRef, type AssessmentSubmission,
} from '../../modules/activity/assessment-values.ts';
import {
  boundedWorkbookReply, prepareWorkbookRelease as freezeRelease, sameAssessmentRef as sameRef,
  workbookAssessmentValue, workbookEvaluation, type WorkbookEvaluation,
} from '../../modules/activity/workbook-assessment-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import formalAssessmentSlot from '../../modules/activity/slots/workbook-formal-assessment.ts';
import {
  independentlyAuthoredPaper, sameWorkbookJson, workbookAssessmentConsent, workbookAssessmentPurpose, workbookAttempt, workbookAttemptType,
  workbookFormalAssessmentType, workbookPaper, workbookPaperType, type WorkbookAttempt, type WorkbookDraft,
} from '../../modules/activity/workbook-values.ts';
import {
  assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, registerFormalAssessment,
  type AssessmentScope,
} from './formal-assessment.ts';
import { RequestError } from './sessions.ts';

export const workbookAssessmentSlot = workbookFormalAssessmentType;
export const workbookTextEvaluator = { id: 'workbook-text-rubric', version: '1' } as const;
const policy: CandidatePolicy = {
  slot: formalAssessmentSlot,
  deriver: 'activity/workbook-formal-assessment-v1',
  purpose: workbookAssessmentPurpose,
};
const propagation = createPropagationHooks([]);
const maxOutputTokens = 512;
const maxAnswerLength = 16_000;

type RouteCharge = {
  readonly learner: string;
  readonly providerEffectId: string;
  readonly maxOutputTokens: number;
  readonly inputBytes: number;
};

export type WorkbookAssessmentRoute = {
  /** Versioned route identity, including the configured model. Do not place credentials here. */
  readonly id: string;
  /** Reserve the budget for this effect under the learner lock. Return false to deny spending. */
  reserve(tx: DbTransaction, charge: RouteCharge): Promise<boolean>;
  /** One bounded call with the configured credentials. No search, workspace, or tool access. */
  score(input: {
    readonly providerEffectId: string;
    readonly prompt: string;
    readonly rubric: string;
    readonly criterionId: string;
    readonly maximum: number | null;
    readonly answer: string;
    readonly maxOutputTokens: number;
  }): Promise<Json>;
};

export type WorkbookAssessmentHost = {
  readonly readVerifiedEvidence?: ReadVerifiedAssessmentPublicationEvidence;
  /** Return null when the assessment-specific route lacks authorized configuration or credentials. */
  readonly resolveAssessmentRoute?: (routeId: string) => Promise<WorkbookAssessmentRoute | null>;
};

type FrozenInputs = {
  release: AssessmentRelease;
  submission: AssessmentSubmission;
  questions: Record<string, { prompt: string; rubric: string }>;
  consent: boolean;
  independent?: boolean;
};
function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft): AssessmentRelease {
  return freezeRelease(value, paperId, draft, digest);
}

export function frozenSubmission(release: AssessmentRelease, submissionRef: AssessmentRevisionRef, answers: WorkbookAttempt['answers']) {
  return assessmentSubmission({
    releaseRef: release.releaseRef, submissionRef,
    answers: release.items.flatMap(item => {
      const answer = answers[item.itemId];
      const slot = item.slots[0]!;
      if (typeof answer === 'string' && answer.length > maxAnswerLength) throw new Error('自动评估作答过长。');
      return typeof answer !== 'string' ? [] : [{
        itemId: item.itemId, slotId: slot.slotId, schemaVersion: slot.schemaVersion,
        path: '', value: { kind: 'text', value: answer },
      }];
    }),
  }, release);
}

class AssessmentInputUnavailable extends Error {}

function readFailure(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof AssessmentInputUnavailable;
}

const effectLabel = 'workbook-assessment';

export function openWorkbookAssessment(db: Db, host: WorkbookAssessmentHost = {}) {
  const afterFactsChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
    const read = createCommandReadContext(tx, storagePurpose);
    for (const { ref, kind, factType } of changes) {
      if (factType === workbookPaperType && kind === 'create') {
        const release = workbookPaper((await read.fact(ref.id, { mode: 'following' })).value).assessmentRelease;
        if (!release) continue;
        const review = checkAssessmentPublication(release, [workbookTextEvaluator], host.readVerifiedEvidence ?? (() => null));
        if (review.state === 'needs-review') {
          throw new RequestError(409, '发放需要独立核验。' + review.issues.map(issue => issue.reason).join(' '));
        }
      }
      if (factType !== workbookAttemptType || (kind !== 'create' && kind !== 'correct')) continue;
      const fact = await read.fact(ref.id, { mode: 'following' });
      const attempt = workbookAttempt(fact.value);
      const release = attempt.paper.assessmentRelease;
      if (!release) continue;
      const paper = await read.fact(release.releaseRef.id, { mode: 'pinned', rev: release.releaseRef.rev });
      await registerFormalAssessment(tx, tick, policy, paper, fact);
    }
  };

  async function execute(ref: WorkRef, terminalFailure = false) {
    const learner = learnerId(ref.learner);
    const work = await readWork(db, ref);
    if (work?.slotType !== workbookAssessmentSlot || work.deriver !== policy.deriver) return;
    const { rows: [row] } = await db.query<{ scope_keys: AssessmentScope }>(
      'SELECT scope_keys FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [learner, workbookAssessmentSlot, work.slotKey],
    );
    if (!row) throw new Error('Assessment work is missing its frozen scope');
    const scope = row.scope_keys;

    try {
      const snapshot = await gatherSnapshot(db, { learner, purpose: policy.purpose }, async ({ read }) => {
        const { releaseRef, submissionRef } = scope;
        const attemptFact = await read.fact(submissionRef.id, { mode: 'following' });
        const paperFact = await read.fact(releaseRef.id, { mode: 'pinned', rev: releaseRef.rev });
        if (attemptFact.type !== workbookAttemptType || paperFact.type !== workbookPaperType ||
            !sameRef(attemptFact.ref, submissionRef) || attemptFact.accessEpoch !== scope.submissionEpoch ||
            paperFact.accessEpoch !== scope.releaseEpoch) throw new AssessmentInputUnavailable();
        const attempt = workbookAttempt(attemptFact.value);
        const paper = workbookPaper(paperFact.value);
        const release = paper.assessmentRelease;
        if (!release || !sameRef(release.releaseRef, releaseRef) ||
            !sameWorkbookJson(release, attempt.paper.assessmentRelease) || attempt.paperId !== releaseRef.id) {
          throw new AssessmentInputUnavailable();
        }
        const input: FrozenInputs = {
          release, submission: frozenSubmission(release, submissionRef, attempt.answers),
          questions: Object.fromEntries(paper.questions.flatMap(question => question.kind === 'rubric' &&
            release.items.some(({ itemId }) => itemId === question.id)
            ? [[question.id, { prompt: question.prompt, rubric: question.rubric }]] : [])),
          independent: independentlyAuthoredPaper(paper) && independentlyAuthoredPaper(attempt.paper),
          consent: attempt.assessmentConsent === workbookAssessmentConsent,
        };
        return { kind: 'input', data: input, effects: [] };
      });
      const sealed = await sealCandidate(db, ref, policy, snapshot);
      if (sealed.kind !== 'sealed') return;
      if (terminalFailure) {
        await submitCandidate(db, ref, policy, sealed.id, { kind: 'failed', reason: assessmentExecutionFailed }, propagation);
        return;
      }
      // Only this adapter writes the versioned gather plan. Use the sealed copy on activity retry.
      const { release, submission, questions, consent, independent } = sealed.plan.data as FrozenInputs;
      const authorize = async (tx: ReadTransaction) => {
        if (!(await readReadyWork(tx, ref)) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid')
          throw new AssessmentInputUnavailable();
      };
      const evaluated: WorkbookEvaluation[] = [];
      for (const { itemId, criteria } of release.items) {
        for (const criterion of criteria) {
          const answer = submission.answers.find(entry => entry.itemId === itemId)?.value;
          const key = { itemId, criterionId: criterion.criterionId };
          if (answer?.kind !== 'text') {
            evaluated.push({ outcome: { ...key, state: 'unsubmitted', reason: '未交此作答位。' } });
            continue;
          }
          const { routeId } = criterion.parameters as { routeId: string };
          const route = consent ? await host.resolveAssessmentRoute?.(routeId) : null;
          if (!route || routeId !== route.id) {
            evaluated.push({ outcome: { ...key, state: 'blocked', reason: !consent
              ? '本次提交缺少外发评阅授权。' : '自动评估路由或凭据不可用。' } });
            continue;
          }
          const { prompt, rubric } = questions[itemId]!;
          const stepKey = JSON.stringify([itemId, criterion.criterionId]);
          const input = { prompt, rubric, ...key, answer: answer.value, maximum: criterion.maximum, maxOutputTokens };
          const effect = await runEffect(db, {
            learner, ownerKind: 'derivation', ownerId: sealed.id, stepKey, label: effectLabel,
            input: { ...input, evaluator: criterion.evaluator, routeId },
          }, async providerEffectId => {
            const allow = await db.tx({ learner }, async tx => {
              await lockLearner(tx, learner);
              await authorize(tx);
              return route.reserve(tx, {
                learner, providerEffectId, maxOutputTokens, inputBytes: Buffer.byteLength(JSON.stringify(input)),
              });
            });
            if (!allow) return { providerEffectId, result: null, denied: true };
            await db.snapshot({ learner }, authorize);
            const { itemId: _, ...scoringInput } = input;
            const result = boundedWorkbookReply(await route.score({ providerEffectId, ...scoringInput }));
            return { providerEffectId, result, denied: false };
          }, authorize, independent ? {manifest: sealed.manifest, work: ref} : undefined);
          evaluated.push(workbookEvaluation(key, criterion, answer.value, routeId, effect));
        }
      }
      const value = workbookAssessmentValue(release, submission, evaluated);
      await submitCandidate(db, ref, policy, sealed.id, { kind: 'value', value }, propagation);
    } catch (error) {
      if (!readFailure(error)) throw error;
      await failWork(db, ref, async tx => {
        await tx.query(
          'UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
          [learner, workbookAssessmentSlot, work.slotKey, JSON.stringify({ status: 'blocked', reason: assessmentInputsBlocked })],
        );
      });
    }
  }

  return { afterFactsChanged, execute };
}

/** A finalized score can be read with fresh witnesses when only the grants changed. */
export async function readSavedWorkbookAssessment(
  tx: ReadTransaction, releaseRef: AssessmentRevisionRef, submission: FactSnapshot, paper: FactSnapshot,
) {
  const { rows: [row] } = await tx.query<{
    id: string; scope_keys: AssessmentScope; manifest: unknown; value: { kind: 'value'; value: FormalAssessmentValue } | null;
  }>(
    `SELECT d.id, s.scope_keys, d.manifest, d.value FROM slot_state s
     LEFT JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id) =
       (s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
       AND NOT d.is_shadow AND d.deriver=$6 AND d.scope_keys=s.scope_keys
       AND d.effective_tick>=d.gather_tick AND d.selection_ended_tick IS NULL
       AND ((d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL) OR
         (s.current_id IS NULL AND d.lifecycle='stale' AND d.error->>'reason'='fact-access-changed'))
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'releaseRef'=$3::jsonb
       AND s.scope_keys->'submissionRef'->>'id'=$4 AND (s.scope_keys->'submissionRef'->>'rev')::int<=$5
     ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`,
    [tx.learner, workbookAssessmentSlot, JSON.stringify(releaseRef), submission.ref.id, submission.ref.rev, policy.deriver],
  );
  if (row?.value?.kind !== 'value') return;
  const { value } = row.value;
  const { submissionRef, releaseEpoch, submissionEpoch } = row.scope_keys;
  if (!sameRef(value.result.releaseRef, releaseRef) || !sameRef(value.result.submissionRef, submissionRef) ||
      paper.ref.id !== releaseRef.id || submission.type !== workbookAttemptType || paper.type !== workbookPaperType) return;
  const manifest = parseManifest(row.manifest);
  if (manifest.learner !== tx.learner || manifest.purpose !== policy.purpose || manifest.inputs.length !== 2) return;
  for (const [original, current, epoch, mode] of [
    [releaseRef, paper.ref, releaseEpoch, 'pinned'], [submissionRef, submission.ref, submissionEpoch, 'following'],
  ] as const) {
    if (!manifest.inputs.some(input => input.kind === 'fact' && input.id === original.id &&
      input.rev === original.rev && input.accessEpoch === epoch && input.mode === mode)) return;
    // Each adjacent revision must be a grant change, including an edit later restored to the same value.
    const { rows: [proof] } = await tx.query<{ unchanged: boolean }>(
      `SELECT count(*) FILTER (WHERE r.kind='value' AND r.data=base.data AND r.corrects_rev=p.rev
          AND r.purpose IS DISTINCT FROM p.purpose)=($4::int-$3::int) AS unchanged
       FROM fact_revs base JOIN fact_revs r ON (r.learner_id,r.fact_id)=(base.learner_id,base.fact_id)
       JOIN fact_revs p ON (p.learner_id,p.fact_id,p.rev)=(r.learner_id,r.fact_id,r.rev-1)
       WHERE base.learner_id=$1 AND base.fact_id=$2 AND base.rev=$3 AND base.kind='value' AND r.rev>$3 AND r.rev<=$4`,
      [tx.learner, original.id, original.rev, current.rev],
    );
    if (!proof?.unchanged) return;
  }
  return { ...value, releaseRef, submissionRef, state: settledAssessmentState(value), derivationId: row.id };
}

export async function readWorkbookAssessment(tx: ReadTransaction, release: AssessmentRelease, submissionRef: AssessmentRevisionRef) {
  const result = await readFormalAssessment(tx, workbookAssessmentSlot, release.releaseRef, submissionRef, storagePurpose);
  if (result.state !== 'blocked' || 'derivationId' in result) return result;
  try {
    const read = createCommandReadContext(tx, storagePurpose);
    const submission = await read.fact(factId(submissionRef.id), { mode: 'following' });
    const paper = await read.fact(factId(release.releaseRef.id), { mode: 'following' });
    if (sameRef(submission.ref, submissionRef)) return await readSavedWorkbookAssessment(tx, release.releaseRef, submission, paper) ?? result;
  } catch (error) {
    if (!readFailure(error)) throw error;
  }
  return result;
}
