import { revisionsOnlyChangeGrants } from '../../kernel/src/commands/fact-collection.ts';
import { createHash } from 'node:crypto';
import { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, learnerId, type FactId, type Tick } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot, Json } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, readWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import type { ReadVerifiedAssessmentPublicationEvidence } from '../../modules/activity/assessment-publication.ts';
import {
  settledAssessmentState, type FormalAssessmentValue, type AssessmentRelease,
  type AssessmentRevisionRef,
} from '../../modules/activity/assessment-values.ts';
import { evaluateBankCriterion, frozenWorkbookSubmission, isLocalQuestionCriterion } from '../../modules/activity/question-assessment.ts';
import { readFrozenWorkbookBank } from '../../modules/activity/workbook-bank.ts';
import { boundedWorkbookReply, checkWorkbookPublication, publicBankAssessment, workbookAssessmentValue, prepareWorkbookRelease as prepareRelease, sameAssessmentRef as sameRef,
  AssessmentInputUnavailable, gatherWorkbookAssessment, workbookEvaluation, workbookTextEvaluator,
  type FrozenWorkbookAssessmentInputs, type WorkbookEvaluation } from '../../modules/activity/workbook-assessment-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import formalAssessmentSlot from '../../modules/activity/slots/workbook-formal-assessment.ts';
import {
  workbookAssessmentPurpose, workbookAttempt, workbookAttemptType,
  workbookFormalAssessmentType, workbookPaper, workbookPaperType, WorkbookSourceMismatch, type WorkbookDraft, type WorkbookPaper,
} from '../../modules/activity/workbook-values.ts';
import { verifyWorkbookAttachmentManifestInputs, type WorkbookAttachmentEvidence } from '../../modules/activity/workbook-attachments.ts';
import {
  assessmentExecutionFailed, assessmentInputsBlocked, readFormalAssessment, registerFormalAssessment,
  type AssessmentScope,
} from './formal-assessment.ts';
import { RequestError } from './sessions.ts';

export const workbookAssessmentSlot = workbookFormalAssessmentType;
export { workbookTextEvaluator };
const policy: CandidatePolicy = {
  slot: formalAssessmentSlot,
  deriver: 'activity/workbook-formal-assessment-v1',
  purpose: workbookAssessmentPurpose,
};
const bankPolicy: CandidatePolicy = { ...policy, deriver: 'activity/workbook-bank-assessment-v1' };
const assessmentPolicy = (paper: WorkbookPaper) => paper.questions.some(question => question.kind === 'bank') ? bankPolicy : policy;
const propagation = createPropagationHooks([]);
const maxOutputTokens = 512;

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
    readonly attachments?: readonly WorkbookAttachmentEvidence[];
    readonly maxOutputTokens: number;
  }): Promise<Json>;
};

export type WorkbookAssessmentHost = {
  readonly readVerifiedEvidence?: ReadVerifiedAssessmentPublicationEvidence;
  /** Return null when the assessment-specific route lacks authorized configuration or credentials. */
  readonly resolveAssessmentRoute?: (routeId: string) => Promise<WorkbookAssessmentRoute | null>;
};

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft) {
  return prepareRelease(value, paperId, draft, digest);
}

export const frozenSubmission = frozenWorkbookSubmission;

async function authorizeBankBasis(
  tx: ReadTransaction,
  release: AssessmentRevisionRef,
  purpose = storagePurpose,
  maySend?: (fact: FactSnapshot) => boolean,
) {
  const read = maySend ? createAuthorizedFactReader(tx, purpose, maySend) : createCommandReadContext(tx, purpose);
  const paper = await read.fact(release.id, { mode: 'pinned', rev: release.rev });
  if (paper.type !== workbookPaperType) throw new AssessmentInputUnavailable();
  await readFrozenWorkbookBank(read, workbookPaper(paper.value));
}

function withBankBasis(db: Db, release: AssessmentRevisionRef): Db {
  return { ...db,
    snapshot: (scope, run) => db.snapshot(scope, async tx => {
      await authorizeBankBasis(tx, release);
      return run(tx);
    }),
    tx: (scope, run) => db.tx(scope, async tx => {
      await lockLearner(tx, tx.learner);
      await authorizeBankBasis(tx, release);
      return run(tx);
    }),
  };
}

function readFailure(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
    error instanceof WorkbookSourceMismatch || error instanceof AssessmentInputUnavailable;
}

const effectLabel = 'workbook-assessment';

export function openWorkbookAssessment(db: Db, host: WorkbookAssessmentHost = {}) {
  const afterFactsChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
    const read = createCommandReadContext(tx, storagePurpose);
    for (const { ref, kind, factType } of changes) {
      if (factType === workbookPaperType && kind === 'create') {
        const paper = workbookPaper((await read.fact(ref.id, { mode: 'following' })).value);
        const review = checkWorkbookPublication(paper, host.readVerifiedEvidence);
        if (review?.state === 'needs-review') {
          throw new RequestError(409, '发放需要独立核验。' + review.issues.map(issue => issue.reason).join(' '));
        }
      }
      if (factType !== workbookAttemptType || (kind !== 'create' && kind !== 'correct')) continue;
      const fact = await read.fact(ref.id, { mode: 'following' });
      const attempt = workbookAttempt(fact.value);
      const release = attempt.paper.assessmentRelease;
      if (!release) continue;
      const paper = await read.fact(release.releaseRef.id, { mode: 'pinned', rev: release.releaseRef.rev });
      await registerFormalAssessment(tx, tick, assessmentPolicy(attempt.paper), paper, fact);
    }
  };

  async function execute(ref: WorkRef, terminalFailure = false) {
    const learner = learnerId(ref.learner);
    const work = await readWork(db, ref);
    if (work?.slotType !== workbookAssessmentSlot) return;
    const activePolicy = work.deriver === bankPolicy.deriver ? bankPolicy : policy;
    if (work.deriver !== activePolicy.deriver) return;
    const { rows: [row] } = await db.query<{ scope_keys: AssessmentScope }>(
      'SELECT scope_keys FROM slot_state WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
      [learner, workbookAssessmentSlot, work.slotKey],
    );
    if (!row) throw new Error('Assessment work is missing its frozen scope');
    const scope = row.scope_keys;
    // The paper and attempt grant assessment use. Original question sources
    // grant storage and teaching use, and are reopened under their own grant.
    const assessmentDb = activePolicy === bankPolicy ? withBankBasis(db, scope.releaseRef) : db;

    try {
      const snapshot = await gatherSnapshot(assessmentDb, { learner, purpose: activePolicy.purpose }, async ({ read }) => {
        return gatherWorkbookAssessment(read, scope, readFailure);
      });
      const sealed = await sealCandidate(assessmentDb, ref, activePolicy, snapshot);
      if (sealed.kind !== 'sealed') return;
      if (terminalFailure) {
        await submitCandidate(assessmentDb, ref, activePolicy, sealed.id, { kind: 'failed', reason: assessmentExecutionFailed }, propagation);
        return;
      }
      // Only this adapter writes the versioned gather plan. Use the sealed copy on activity retry.
      const { release, submission, questions, questionAttachments, consent, independent } = sealed.plan.data as FrozenWorkbookAssessmentInputs;
      const authorize = async (tx: ReadTransaction) => {
        if (!(await readReadyWork(tx, ref)) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid')
          throw new AssessmentInputUnavailable();
      };
      const evaluated: WorkbookEvaluation[] = [];
      for (const item of release.items) {
        const { itemId } = item;
        for (const criterion of item.criteria) {
          if (activePolicy === bankPolicy) {
            evaluated.push({ outcome: evaluateBankCriterion(item, criterion, submission) });
            continue;
          }
          const answer = submission.answers.find(entry => entry.itemId === itemId)?.value;
          const attachments = questionAttachments?.[itemId];
          const key = { itemId, criterionId: criterion.criterionId };
          if (answer?.kind !== 'text' && !(answer?.kind === 'attachment' && attachments?.length)) {
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
          const input = { prompt, rubric, ...key, answer: answer?.kind === 'text' ? answer.value : '', ...(attachments?.length ? { attachments } : {}), maximum: criterion.maximum, maxOutputTokens };
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
          evaluated.push(workbookEvaluation(key, criterion, input.answer, routeId, effect, Boolean(attachments?.length)));
        }
      }
      const value = workbookAssessmentValue(release, submission, evaluated);
      await submitCandidate(assessmentDb, ref, activePolicy, sealed.id, { kind: 'value', value }, propagation);
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
  cutoff?: Tick, requiredPurpose = storagePurpose, maySend?: (fact: FactSnapshot) => boolean,
) {
  if (paper.ref.id !== releaseRef.id || submission.type !== workbookAttemptType || paper.type !== workbookPaperType) return;
  const selectedPolicy = assessmentPolicy(workbookPaper(paper.value));
  const grants = (fact: FactSnapshot, use: string) => fact.purpose.includes(use) || fact.purpose.includes('all');
  if (!grants(paper, selectedPolicy.purpose) || !grants(submission, selectedPolicy.purpose) ||
      !grants(paper, requiredPurpose) || !grants(submission, requiredPurpose) ||
      (maySend && (!maySend(paper) || !maySend(submission)))) return;
  if (selectedPolicy === bankPolicy) await authorizeBankBasis(tx, releaseRef, requiredPurpose, maySend);
  const { rows: [row] } = await tx.query<{
    id: string; scope_keys: AssessmentScope; manifest: unknown; value: { kind: 'value'; value: FormalAssessmentValue } | null;
  }>(
    `SELECT d.id, s.scope_keys, d.manifest, d.value FROM slot_state s
     LEFT JOIN derivations d ON (d.learner_id,d.slot_type,d.slot_key,d.id) =
       (s.learner_id,s.slot_type,s.slot_key,COALESCE(s.current_id,s.last_id))
       AND NOT d.is_shadow AND d.deriver=$6 AND d.scope_keys=s.scope_keys
       AND d.effective_tick>=d.gather_tick AND d.selection_ended_tick IS NULL
       AND ($7::bigint IS NULL OR d.effective_tick<=$7::bigint)
       AND ((d.id=s.current_id AND d.lifecycle='effective' AND d.invalidated_tick IS NULL) OR
         (s.current_id IS NULL AND d.lifecycle='stale' AND d.error->>'reason'='fact-access-changed'))
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.scope_keys->'releaseRef'=$3::jsonb
       AND s.scope_keys->'submissionRef'->>'id'=$4 AND (s.scope_keys->'submissionRef'->>'rev')::int<=$5
     ORDER BY (s.scope_keys->'submissionRef'->>'rev')::int DESC LIMIT 1`,
    [tx.learner, workbookAssessmentSlot, JSON.stringify(releaseRef), submission.ref.id, submission.ref.rev, selectedPolicy.deriver, cutoff ?? null],
  );
  if (row?.value?.kind !== 'value') return;
  const { value } = row.value;
  const { submissionRef, releaseEpoch, submissionEpoch } = row.scope_keys;
  if (!sameRef(value.result.releaseRef, releaseRef) || !sameRef(value.result.submissionRef, submissionRef)) return;
  const manifest = parseManifest(row.manifest);
  if (manifest.learner !== tx.learner || manifest.purpose !== selectedPolicy.purpose || manifest.inputs.length < 2) return;
  for (const [original, current, epoch, mode] of [
    [releaseRef, paper.ref, releaseEpoch, 'pinned'], [submissionRef, submission.ref, submissionEpoch, 'following'],
  ] as const) {
    if (!manifest.inputs.some(input => input.kind === 'fact' && input.id === original.id &&
      input.rev === original.rev && input.accessEpoch === epoch && input.mode === mode)) return;
    if (!await revisionsOnlyChangeGrants(tx, original.id, original.rev, current.rev)) return;
  }
  const extra = manifest.inputs.filter(input => !(input.kind === 'fact' && ((input.id === releaseRef.id && input.mode === 'pinned') || (input.id === submissionRef.id && input.mode === 'following'))));
  if (extra.length !== manifest.inputs.length - 2 || (extra.length && !await verifyWorkbookAttachmentManifestInputs(createCommandReadContext(tx, selectedPolicy.purpose), extra, readFailure))) return;
  return { ...(selectedPolicy === bankPolicy ? publicBankAssessment(value) : value),
    releaseRef, submissionRef, state: settledAssessmentState(value), derivationId: row.id };
}

export type WorkbookAssessmentReadAccess = {
  readonly purpose?: string;
  readonly maySend?: (fact: FactSnapshot) => boolean;
  readonly releaseEpoch?: string;
  readonly submissionEpoch?: string;
};

export async function readWorkbookAssessment(
  tx: ReadTransaction,
  release: AssessmentRelease,
  submissionRef: AssessmentRevisionRef,
  access?: WorkbookAssessmentReadAccess,
) {
  const use = access?.purpose ?? storagePurpose;
  const maySend = access?.maySend;
  const bank = release.items.some(item => item.criteria.some(isLocalQuestionCriterion));
  if (bank) {
    try { await authorizeBankBasis(tx, release.releaseRef, use, maySend); }
    catch (error) {
      if (!readFailure(error)) throw error;
      return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const, reason: assessmentInputsBlocked, score: null };
    }
  }
  let opened: { submission: FactSnapshot; paper: FactSnapshot } | undefined;
  if (access) {
    try {
      const read = createAuthorizedFactReader(tx, use, maySend ?? (() => true));
      const submission = await read.fact(factId(submissionRef.id), { mode: 'following' });
      const paper = await read.fact(factId(release.releaseRef.id), { mode: 'following' });
      if (!sameRef(submission.ref, submissionRef) ||
          (access.releaseEpoch !== undefined && paper.accessEpoch !== access.releaseEpoch) ||
          (access.submissionEpoch !== undefined && submission.accessEpoch !== access.submissionEpoch)) {
        return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const, reason: assessmentInputsBlocked, score: null };
      }
      opened = { submission, paper };
    } catch (error) {
      if (!readFailure(error)) throw error;
      return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const, reason: assessmentInputsBlocked, score: null };
    }
  }
  const result = await readFormalAssessment(tx, workbookAssessmentSlot, release.releaseRef, submissionRef, use,
    opened ? { releaseEpoch: opened.paper.accessEpoch, submissionEpoch: opened.submission.accessEpoch } : undefined);
  if (bank && 'criteria' in result && result.criteria)
    return { ...result, ...publicBankAssessment(result) };
  if (result.state !== 'blocked' || 'derivationId' in result) return result;
  try {
    const read = maySend ? createAuthorizedFactReader(tx, use, maySend) : createCommandReadContext(tx, use);
    const submission = opened?.submission ?? await read.fact(factId(submissionRef.id), { mode: 'following' });
    const paper = opened?.paper ?? await read.fact(factId(release.releaseRef.id), { mode: 'following' });
    if (sameRef(submission.ref, submissionRef)) {
      return await readSavedWorkbookAssessment(tx, release.releaseRef, submission, paper, undefined, use, maySend) ?? result;
    }
  } catch (error) {
    if (!readFailure(error)) throw error;
  }
  return result;
}
