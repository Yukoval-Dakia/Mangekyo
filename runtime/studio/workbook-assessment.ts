import { createHash } from 'node:crypto';
import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import { learnerId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { Json, JsonObject } from '../../kernel/src/declarations/types.ts';
import { sealCandidate, submitCandidate, type CandidatePolicy } from '../../kernel/src/derivations/candidate.ts';
import { gatherSnapshot } from '../../kernel/src/derivations/gather.ts';
import { parseManifest } from '../../kernel/src/derivations/manifest.ts';
import { createPropagationHooks } from '../../kernel/src/derivations/propagation.ts';
import { revalidateManifest } from '../../kernel/src/derivations/revalidate.ts';
import { failWork, readReadyWork, readWork, requestWork, runEffect, type WorkRef } from '../../kernel/src/work/index.ts';
import { checkAssessmentPublication, type ReadVerifiedAssessmentPublicationEvidence } from '../../modules/activity/assessment-publication.ts';
import {
  assessmentRelease, assessmentResult, assessmentSubmission, readAssessmentScore,
  type AssessmentCriterion, type AssessmentCriterionOutcome, type AssessmentRelease, type AssessmentResult,
  type AssessmentRevisionRef, type AssessmentSubmission,
} from '../../modules/activity/assessment-values.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import formalAssessmentSlot from '../../modules/activity/slots/workbook-formal-assessment.ts';
import {
  sameWorkbookJson, workbookAssessmentConsent, workbookAssessmentPurpose, workbookAttempt, workbookAttemptType,
  workbookFormalAssessmentType, workbookPaper, workbookPaperType, type WorkbookAttempt, type WorkbookDraft,
} from '../../modules/activity/workbook-values.ts';
import { stableId } from './identity.ts';
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
const executionFailed = '自动评估执行失败。';

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

type AssessmentScope = {
  releaseRef: AssessmentRevisionRef;
  submissionRef: AssessmentRevisionRef;
  releaseEpoch: string;
  submissionEpoch: string;
};
type FrozenInputs = {
  release: AssessmentRelease;
  submission: AssessmentSubmission;
  questions: Record<string, { prompt: string; rubric: string }>;
  consent: boolean;
};
type Evaluation = {
  outcome: AssessmentCriterionOutcome;
  receipt?: { effectId: string; routeId: string; reportedModel?: string; quote?: string };
};

function sameRef(a: AssessmentRevisionRef | undefined, b: AssessmentRevisionRef) {
  return a?.id === b.id && a.rev === b.rev;
}

function digest(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

export function prepareWorkbookRelease(value: unknown, paperId: FactId, draft: WorkbookDraft): AssessmentRelease {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('冻结发放格式无效。');
  const releaseRef = { id: paperId, rev: 1 as Revision };
  const release = assessmentRelease({ releaseRef, ...value });
  if (!sameRef(release.releaseRef, releaseRef)) throw new Error('冻结发放须引用本次保存的试卷修订。');
  const items = release.items.map(item => {
    const index = draft.questions.findIndex(({ id }) => id === item.itemId);
    const question = draft.questions[index];
    const slot = item.slots[0];
    if (question?.kind !== 'rubric' || !sameRef(item.promptRef, releaseRef) || item.workRef ||
        item.slots.length !== 1 || slot?.fields.length !== 1 ||
        slot.fields[0]?.kind !== 'text' || slot.fields[0]?.path !== '') {
      throw new Error('该发放入口仅支持引用本卷题面的单文字作答位评分标准题。');
    }
    const criteria = item.criteria.map(criterion => {
      const provided = criterion.parameters as JsonObject | null;
      const routeId = provided?.routeId;
      if (criterion.inputs.length !== 1 || !sameRef(criterion.source.ref, releaseRef) ||
          criterion.source.kind !== 'product-rubric' || criterion.source.path !== '/questions/' + index + '/rubric' ||
          typeof routeId !== 'string' || !/^[a-zA-Z0-9_./:@-]{1,128}$/.test(routeId)) {
        throw new Error('评估标准须绑定本题的产品评分标准、唯一作答位及版本化评估路由。');
      }
      // The registry must vouch for the exact bytes even when this revision does not exist yet.
      const parameters = { routeId, promptSha256: digest(question.prompt), rubricSha256: digest(question.rubric) };
      if (!sameWorkbookJson(provided, { routeId }) && !sameWorkbookJson(provided, parameters))
        throw new Error('评估参数与本次保存的题面或评分标准不匹配。');
      return { ...criterion, parameters };
    });
    return { ...item, criteria };
  });
  return { ...release, items };
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

function slotKey(release: AssessmentRevisionRef, submission: AssessmentRevisionRef) {
  return stableId(workbookAssessmentSlot, release.id, String(release.rev), submission.id, String(submission.rev));
}

class AssessmentInputUnavailable extends Error {}

function readFailure(error: unknown) {
  return error instanceof FactNotFoundError || error instanceof FactReadDeniedError || error instanceof AssessmentInputUnavailable;
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit &&
    value.isWellFormed() && !value.includes('\u0000');
}

function boundedReply(value: Json): Json {
  const reply = value as JsonObject | null;
  if (!reply || !text(reply.reportedModel, 256)) return null;
  const { state, reportedModel, feedback, quote, earned } = reply;
  if (state === 'insufficient-evidence') return { state, reportedModel };
  if (!text(feedback, 1500) || !text(quote, 500)) return null;
  if (state === 'qualitative') return { state, reportedModel, feedback, quote };
  if (state === 'scored' && typeof earned === 'number' && Number.isFinite(earned)) return { state, reportedModel, feedback, quote, earned };
  return null;
}

const effectLabel = 'workbook-assessment';

export function openWorkbookAssessment(db: Db, host: WorkbookAssessmentHost = {}) {
  const onFactsChanged: CommandHooks['onFactsChanged'] = async (tx, tick, changes) => {
    await propagation.onFactsChanged(tx, tick, changes);
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
      const scope: AssessmentScope = {
        releaseRef: release.releaseRef, submissionRef: { id: ref.id, rev: ref.rev },
        releaseEpoch: paper.accessEpoch, submissionEpoch: fact.accessEpoch,
      };
      const key = slotKey(scope.releaseRef, scope.submissionRef);
      const inserted = await tx.query(
        `INSERT INTO slot_state (learner_id, slot_type, slot_key, scope_keys, changed_tick)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [tx.learner, workbookAssessmentSlot, key, JSON.stringify(scope), tick],
      );
      if (inserted.rowCount) await requestWork(tx, tick, { slotType: workbookAssessmentSlot, slotKey: key, deriver: policy.deriver });
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
          consent: attempt.assessmentConsent === workbookAssessmentConsent,
        };
        return { kind: 'input', data: input, effects: [] };
      });
      const sealed = await sealCandidate(db, ref, policy, snapshot);
      if (sealed.kind !== 'sealed') return;
      if (terminalFailure) {
        await submitCandidate(db, ref, policy, sealed.id, { kind: 'failed', reason: executionFailed }, propagation);
        return;
      }
      // Only this adapter writes the versioned gather plan. Use the sealed copy on activity retry.
      const { release, submission, questions, consent } = sealed.plan.data as FrozenInputs;
      const authorize = async (tx: ReadTransaction) => {
        if (!(await readReadyWork(tx, ref)) || (await revalidateManifest(tx, sealed.manifest)).kind !== 'valid')
          throw new AssessmentInputUnavailable();
      };
      const evaluated: Evaluation[] = [];
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
            const result = boundedReply(await route.score({ providerEffectId, ...scoringInput }));
            return { providerEffectId, result, denied: false };
          }, authorize);
          evaluated.push(evaluation(key, criterion, answer.value, routeId, effect));
        }
      }
      const result = assessmentResult({
        releaseRef: release.releaseRef, submissionRef: submission.submissionRef, outcomes: evaluated.map(entry => entry.outcome),
      }, release, submission);
      const value = {
        result, score: readAssessmentScore(result, release, submission),
        criteria: release.items.flatMap(item => item.criteria.map(({ criterionId, evaluator, source, maximum }) =>
          ({ itemId: item.itemId, criterionId, evaluator, source, maximum }))),
        receipts: evaluated.flatMap(({ outcome, receipt }) => receipt
          ? [{ itemId: outcome.itemId, criterionId: outcome.criterionId, ...receipt }] : []),
      };
      await submitCandidate(db, ref, policy, sealed.id, { kind: 'value', value }, propagation);
    } catch (error) {
      if (!readFailure(error)) throw error;
      await failWork(db, ref, async tx => {
        await tx.query(
          'UPDATE slot_state SET last_error=$4 WHERE learner_id=$1 AND slot_type=$2 AND slot_key=$3',
          [learner, workbookAssessmentSlot, work.slotKey, JSON.stringify({ status: 'blocked', reason: '冻结依据已变化或不可读取。' })],
        );
      });
    }
  }

  return { onFactsChanged, execute };
}

function evaluation(
  key: { itemId: string; criterionId: string },
  criterion: AssessmentCriterion,
  answer: string,
  routeId: string,
  effect: Awaited<ReturnType<typeof runEffect>>,
): Evaluation {
  if (effect.kind === 'unknown') {
    return {
      outcome: { ...key, state: 'failed', reason: '评估请求结果及费用待核对，已停止重发。' },
      ...(effect.providerEffectId ? { receipt: { effectId: effect.providerEffectId, routeId } } : {}),
    };
  }
  const receipt = effect.result as { providerEffectId: string; denied: boolean; result: unknown };
  const trace = { effectId: receipt.providerEffectId, routeId };
  if (receipt.denied) return { outcome: { ...key, state: 'blocked', reason: '自动评估额度不足。' }, receipt: trace };
  const reply = receipt.result as { state?: unknown; feedback?: unknown; quote?: unknown; earned?: unknown; reportedModel?: unknown } | null;
  if (reply && text(reply.reportedModel, 256)) {
    const observed = { ...trace, reportedModel: reply.reportedModel };
    if (reply.state === 'insufficient-evidence') {
      return { outcome: { ...key, state: 'insufficient-evidence', reason: '作答无法支持该标准的正式判断。' }, receipt: observed };
    }
    if (text(reply.feedback, 1500) && text(reply.quote, 500) && answer.includes(reply.quote)) {
      const evidence = criterion.inputs;
      const verified = { ...observed, quote: reply.quote };
      if (reply.state === 'qualitative' && criterion.maximum === null) {
        return { outcome: { ...key, state: 'qualitative', feedback: reply.feedback, evidence }, receipt: verified };
      }
      if (reply.state === 'scored' && criterion.maximum !== null && typeof reply.earned === 'number' &&
          Number.isFinite(reply.earned) && reply.earned >= 0 && reply.earned <= criterion.maximum) {
        return { outcome: { ...key, state: 'scored', earned: reply.earned, feedback: reply.feedback, evidence }, receipt: verified };
      }
    }
  }
  return { outcome: { ...key, state: 'failed', reason: '评估结论、分值或引文无法与冻结标准和作答核对。' }, receipt: trace };
}

type FormalAssessmentValue = {
  result: AssessmentResult;
  score: ReturnType<typeof readAssessmentScore>;
  criteria: (Pick<AssessmentCriterion, 'criterionId' | 'evaluator' | 'source' | 'maximum'> & { itemId: string })[];
  receipts: (NonNullable<Evaluation['receipt']> & { itemId: string; criterionId: string })[];
};

export async function readWorkbookAssessment(tx: ReadTransaction, release: AssessmentRelease, submissionRef: AssessmentRevisionRef) {
  const releaseRef = release.releaseRef;
  const { rows: [slot] } = await tx.query<{
    current_id: string | null; last_error: { status: string; reason: string } | null;
    value: { kind: 'value'; value: FormalAssessmentValue } | null; manifest: unknown;
  }>(
    `SELECT s.current_id, s.last_error, d.value, d.manifest FROM slot_state s
     LEFT JOIN derivations d ON d.learner_id=s.learner_id AND d.id=s.current_id
       AND d.lifecycle='effective' AND d.invalidated_tick IS NULL
     WHERE s.learner_id=$1 AND s.slot_type=$2 AND s.slot_key=$3`,
    [tx.learner, workbookAssessmentSlot, slotKey(releaseRef, submissionRef)],
  );
  const refs = { releaseRef, submissionRef };
  if (slot?.value?.kind === 'value' && slot.current_id) {
    const manifest = parseManifest(slot.manifest);
    if ((await revalidateManifest(tx, manifest)).kind !== 'valid' ||
        (await revalidateManifest(tx, manifest, storagePurpose)).kind !== 'valid')
      return { ...refs, state: 'blocked' as const, reason: '冻结依据已变化或不可读取。', score: null };
    const { outcomes } = slot.value.value.result;
    const state = outcomes.some(({ state }) => state === 'failed') ? 'failed'
      : outcomes.some(({ state }) => state === 'blocked') ? 'blocked'
      : outcomes.every(({ state }) => state === 'scored' || state === 'qualitative') ? 'complete' : 'incomplete';
    return { ...refs, ...slot.value.value, state, derivationId: slot.current_id };
  }
  if (slot?.last_error) return {
    ...refs, state: slot.last_error.reason === executionFailed ? 'failed' as const : 'blocked' as const,
    reason: slot.last_error.reason, score: null,
  };
  return slot
    ? { ...refs, state: 'queued' as const, score: null }
    : { ...refs, state: 'blocked' as const, reason: '缺少自动评估工作记录。', score: null };
}
