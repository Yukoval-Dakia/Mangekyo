import {
  createCommandReadContext, factId, FactNotFoundError, FactReadDeniedError, learnerId,
  parseManifest, revalidateManifest,
  type DbTransaction, type FactId, type FactSnapshot, type Json, type ReadContext, type ReadTransaction,
  type Revision, type Tick,
} from '@mangekyo/kernel';
import {
  settledAssessmentState, type FormalAssessmentValue, type AssessmentRelease, type AssessmentRevisionRef,
} from './assessment-values.ts';
import {
  evaluateBankCriterion, frozenWorkbookSubmission, isLocalQuestionCriterion,
} from './question-assessment.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import {
  boundedWorkbookReply, checkWorkbookPublication, publicBankAssessment, workbookAssessmentValue,
  prepareWorkbookRelease as prepareRelease, sameAssessmentRef as sameRef,
  AssessmentInputUnavailable, gatherWorkbookAssessment, workbookEvaluation, workbookTextEvaluator,
  workbookAssessmentPolicy as policy, workbookBankAssessmentPolicy as bankPolicy,
  workbookAssessmentPolicyFor as assessmentPolicy,
  type FrozenWorkbookAssessmentInputs, type WorkbookEvaluation,
} from './workbook-assessment-values.ts';
import { storagePurpose } from './library-values.ts';
import {
  workbookAttempt, workbookAttemptType, workbookPaper, workbookPaperType, WorkbookSourceMismatch,
  type WorkbookDraft,
} from './workbook-values.ts';
import {
  verifyWorkbookAttachmentManifestInputs, type WorkbookAttachmentEvidence,
} from './workbook-attachments.ts';
import type { ReadVerifiedAssessmentPublicationEvidence } from './assessment-publication.ts';
import type { FactReadChecks } from './evidence-read.ts';
export const workbookAssessmentSlot = 'activity.workbookFormalAssessment';
export { workbookTextEvaluator, frozenWorkbookSubmission as frozenSubmission };
type RouteCharge = {
  readonly learner: string;
  readonly providerEffectId: string;
  readonly maxOutputTokens: number;
  readonly inputBytes: number;
};
export type WorkbookAssessmentRoute = {
  readonly id: string;
  reserve(tx: DbTransaction, charge: RouteCharge): Promise<boolean>;
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
  readonly resolveAssessmentRoute?: (routeId: string) => Promise<WorkbookAssessmentRoute | null>;
};
export type StudioWorkbookAssessmentDeps = FactReadChecks & {
  readonly fail: (status: number, message: string) => never;
  readonly revisionsOnlyChangeGrants: (tx: ReadTransaction, id: FactSnapshot['ref']['id'], fromRev: number, toRev: number) => Promise<boolean>;
  readonly createAuthorizedFactReader: (tx: ReadTransaction, purpose: string, maySend?: (fact: FactSnapshot) => boolean) => Pick<ReadContext, 'fact'>;
  readonly gatherSnapshot: (db: any, scope: { learner: unknown; purpose: string }, gather: (ctx: { read: Pick<ReadContext, 'fact'> }) => Promise<unknown>) => Promise<unknown>;
  readonly sealCandidate: (db: any, ref: unknown, policy: unknown, snapshot: unknown) => Promise<any>;
  readonly submitCandidate: (db: any, ref: unknown, policy: unknown, id: unknown, outcome: unknown, propagation: unknown) => Promise<unknown>;
  readonly revalidateManifestTx: typeof revalidateManifest;
  readonly readWork: (db: any, ref: unknown) => Promise<any>;
  readonly queryScopeKeys: (db: any, learner: unknown, slotKey: string) => Promise<{ scope_keys: AssessmentScope } | undefined>;
  readonly readReadyWork: (tx: ReadTransaction, ref: unknown) => Promise<unknown>;
  readonly runEffect: (db: any, desc: unknown, invoke: (providerEffectId: string) => Promise<any>, authorize?: (tx: ReadTransaction) => Promise<void>, manifest?: unknown) => Promise<any>;
  readonly failWork: (db: any, ref: unknown, write?: (tx: DbTransaction) => Promise<void>) => Promise<unknown>;
  readonly lockLearner: (tx: DbTransaction, learner: unknown) => Promise<unknown>;
  readonly learnerTx: <T>(db: any, learner: unknown, run: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  readonly learnerSnapshot: <T>(db: any, learner: unknown, run: (tx: ReadTransaction) => Promise<T>) => Promise<T>;
  readonly markBlocked: (db: any, learner: unknown, slotKey: string, reason: string) => Promise<void>;
  readonly dbSnapshot: (db: any, scope: any, run: (tx: ReadTransaction) => Promise<unknown>) => Promise<unknown>;
  readonly dbTx: (db: any, scope: any, run: (tx: DbTransaction) => Promise<unknown>) => Promise<unknown>;
  readonly readFormalAssessment: (tx: ReadTransaction, slotType: string, releaseRef: AssessmentRevisionRef,
    submissionRef: AssessmentRevisionRef, purpose: string, epochs?: { releaseEpoch?: string; submissionEpoch?: string }) => Promise<any>;
  readonly registerFormalAssessment: (tx: DbTransaction, tick: Tick, policy: unknown, paper: FactSnapshot, fact: FactSnapshot) => Promise<unknown>;
  readonly assessmentExecutionFailed: string;
  readonly assessmentInputsBlocked: string;
  readonly assessmentScopeType: string;
};
export type AssessmentScope = {
  releaseRef: AssessmentRevisionRef;
  submissionRef: AssessmentRevisionRef;
  releaseEpoch: string;
  submissionEpoch: string;
};
export function sha256DigestText(createHash: (algorithm: string) => { update(text: string): { digest(encoding: string): string } }, text: string) {
  return createHash('sha256').update(text).digest('hex');
}
export function prepareWorkbookRelease(
  digest: (text: string) => string, value: unknown, paperId: FactId, draft: WorkbookDraft,
) {
  return prepareRelease(value, paperId, draft, digest);
}
export const workbookAssessmentReadFailure = (
  deps: Pick<StudioWorkbookAssessmentDeps, 'isFactNotFound' | 'isFactReadDenied'>, error: unknown,
) => deps.isFactNotFound(error) || deps.isFactReadDenied(error) ||
  error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
  error instanceof WorkbookSourceMismatch || error instanceof AssessmentInputUnavailable;
async function authorizeBankBasis(deps: StudioWorkbookAssessmentDeps, tx: ReadTransaction,
  release: AssessmentRevisionRef, purpose = storagePurpose, maySend?: (fact: FactSnapshot) => boolean) {
  const read = maySend ? deps.createAuthorizedFactReader(tx, purpose, maySend) : createCommandReadContext(tx, purpose);
  const paper = await read.fact(release.id, { mode: 'pinned', rev: release.rev });
  if (paper.type !== workbookPaperType) throw new AssessmentInputUnavailable();
  await readFrozenWorkbookBank(read, workbookPaper(paper.value));
}
function withBankBasis(deps: StudioWorkbookAssessmentDeps, db: any, release: AssessmentRevisionRef): any {
  return { ...db,
    snapshot: (scope: any, run: any) => deps.dbSnapshot(db, scope, async (tx: ReadTransaction) => {
      await authorizeBankBasis(deps, tx, release);
      return run(tx);
    }),
    tx: (scope: any, run: any) => deps.dbTx(db, scope, async (tx: DbTransaction) => {
      await deps.lockLearner(tx, (tx as { learner: unknown }).learner);
      await authorizeBankBasis(deps, tx, release);
      return run(tx);
    }),
  };
}
export async function executeWorkbookAssessment(deps: StudioWorkbookAssessmentDeps, db: any,
  host: WorkbookAssessmentHost, propagation: unknown, maxOutputTokens: number, effectLabel: string,
  ref: unknown, terminalFailure = false) {
  const learner = learnerId((ref as { learner: string }).learner);
  const work = await deps.readWork(db, ref);
  if (work?.slotType !== workbookAssessmentSlot) return;
  const activePolicy = work.deriver === bankPolicy.deriver ? bankPolicy : policy;
  if (work.deriver !== activePolicy.deriver) return;
  const row = await deps.queryScopeKeys(db, learner, work.slotKey);
  if (!row) throw new Error('Assessment work is missing its frozen scope');
  const scope = row.scope_keys;
  const assessmentDb = activePolicy === bankPolicy ? withBankBasis(deps, db, scope.releaseRef) : db;
  try {
    const snapshot = await deps.gatherSnapshot(assessmentDb, { learner, purpose: activePolicy.purpose }, async ({ read }) => {
      return gatherWorkbookAssessment(read, scope, error => workbookAssessmentReadFailure(deps, error));
    });
    const sealed = await deps.sealCandidate(assessmentDb, ref, activePolicy, snapshot);
    if (sealed.kind !== 'sealed') return;
    if (terminalFailure) {
      await deps.submitCandidate(assessmentDb, ref, activePolicy, sealed.id,
        { kind: 'failed', reason: deps.assessmentExecutionFailed }, propagation);
      return;
    }
    const { release, submission, questions, questionAttachments, consent, independent } =
      sealed.plan.data as FrozenWorkbookAssessmentInputs;
    const authorize = async (tx: ReadTransaction) => {
      if (!(await deps.readReadyWork(tx, ref)) || (await deps.revalidateManifestTx(tx, sealed.manifest)).kind !== 'valid')
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
        const input = { prompt, rubric, ...key, answer: answer?.kind === 'text' ? answer.value : '',
          ...(attachments?.length ? { attachments } : {}), maximum: criterion.maximum, maxOutputTokens };
        const effect = await deps.runEffect(db, {
          learner, ownerKind: 'derivation', ownerId: sealed.id, stepKey, label: effectLabel,
          input: { ...input, evaluator: criterion.evaluator, routeId },
        }, async providerEffectId => {
          const allow = await deps.learnerTx(db, learner, async tx => {
            await deps.lockLearner(tx, learner);
            await authorize(tx);
            return route.reserve(tx, {
              learner, providerEffectId, maxOutputTokens, inputBytes: Buffer.byteLength(JSON.stringify(input)),
            });
          });
          if (!allow) return { providerEffectId, result: null, denied: true };
          await deps.learnerSnapshot(db, learner, authorize);
          const { itemId: _, ...scoringInput } = input;
          const result = boundedWorkbookReply(await route.score({ providerEffectId, ...scoringInput }));
          return { providerEffectId, result, denied: false };
        }, authorize, independent ? { manifest: sealed.manifest, work: ref } : undefined);
        evaluated.push(workbookEvaluation(key, criterion, input.answer, routeId, effect, Boolean(attachments?.length)));
      }
    }
    const value = workbookAssessmentValue(release, submission, evaluated);
    await deps.submitCandidate(assessmentDb, ref, activePolicy, sealed.id, { kind: 'value', value }, propagation);
  } catch (error) {
    if (!workbookAssessmentReadFailure(deps, error)) throw error;
    await deps.failWork(db, ref, () => deps.markBlocked(db, learner, work.slotKey, deps.assessmentInputsBlocked));
  }
}
export async function afterWorkbookAssessmentFactsChanged(deps: StudioWorkbookAssessmentDeps,
  host: WorkbookAssessmentHost, tx: DbTransaction, tick: Tick, changes: readonly { ref: { id: FactId }; kind: string; factType: string }[]) {
  const read = createCommandReadContext(tx, storagePurpose);
  for (const { ref, kind, factType } of changes) {
    if (factType === workbookPaperType && kind === 'create') {
      const paper = workbookPaper((await read.fact(ref.id, { mode: 'following' })).value);
      const review = checkWorkbookPublication(paper, host.readVerifiedEvidence);
      if (review?.state === 'needs-review') {
        deps.fail(409, '发放需要独立核验。' + review.issues.map(issue => issue.reason).join(' '));
      }
    }
    if (factType !== workbookAttemptType || (kind !== 'create' && kind !== 'correct')) continue;
    const fact = await read.fact(ref.id, { mode: 'following' });
    const attempt = workbookAttempt(fact.value);
    const release = attempt.paper.assessmentRelease;
    if (!release) continue;
    const paper = await read.fact(release.releaseRef.id, { mode: 'pinned', rev: release.releaseRef.rev });
    await deps.registerFormalAssessment(tx, tick, assessmentPolicy(attempt.paper), paper, fact);
  }
}
export type SavedAssessmentRow = {
  id: string; scope_keys: AssessmentScope; manifest: unknown;
  value: { kind: 'value'; value: FormalAssessmentValue } | null;
};
/** A finalized score can be read with fresh witnesses when only the grants changed. */
export async function readSavedWorkbookAssessment(deps: StudioWorkbookAssessmentDeps, tx: ReadTransaction,
  releaseRef: AssessmentRevisionRef, submission: FactSnapshot, paper: FactSnapshot,
  queryRow: (deriver: string) => Promise<SavedAssessmentRow | undefined>,
  cutoff?: Tick, requiredPurpose = storagePurpose, maySend?: (fact: FactSnapshot) => boolean) {
  if (paper.ref.id !== releaseRef.id || submission.type !== workbookAttemptType || paper.type !== workbookPaperType) return;
  const selectedPolicy = assessmentPolicy(workbookPaper(paper.value));
  const grants = (fact: FactSnapshot, use: string) => fact.purpose.includes(use) || fact.purpose.includes('all');
  if (!grants(paper, selectedPolicy.purpose) || !grants(submission, selectedPolicy.purpose) ||
      !grants(paper, requiredPurpose) || !grants(submission, requiredPurpose) ||
      (maySend && (!maySend(paper) || !maySend(submission)))) return;
  if (selectedPolicy === bankPolicy) await authorizeBankBasis(deps, tx, releaseRef, requiredPurpose, maySend);
  const row = await queryRow(selectedPolicy.deriver);
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
    if (!await deps.revisionsOnlyChangeGrants(tx, original.id, original.rev, current.rev)) return;
  }
  const extra = manifest.inputs.filter(input => !(input.kind === 'fact' &&
    ((input.id === releaseRef.id && input.mode === 'pinned') || (input.id === submissionRef.id && input.mode === 'following'))));
  if (extra.length !== manifest.inputs.length - 2 ||
      (extra.length && !await verifyWorkbookAttachmentManifestInputs(
        createCommandReadContext(tx, selectedPolicy.purpose), extra, (error: unknown) => workbookAssessmentReadFailure(deps, error)))) return;
  return { ...(selectedPolicy === bankPolicy ? publicBankAssessment(value) : value),
    releaseRef, submissionRef, state: settledAssessmentState(value), derivationId: row.id };
}
export type WorkbookAssessmentReadAccess = {
  readonly purpose?: string;
  readonly maySend?: (fact: FactSnapshot) => boolean;
  readonly releaseEpoch?: string;
  readonly submissionEpoch?: string;
};
export async function readWorkbookAssessment(deps: StudioWorkbookAssessmentDeps, tx: ReadTransaction,
  release: AssessmentRelease, submissionRef: AssessmentRevisionRef,
  queryRow: (deriver: string, submission: FactSnapshot) => Promise<SavedAssessmentRow | undefined>,
  access?: WorkbookAssessmentReadAccess) {
  const use = access?.purpose ?? storagePurpose;
  const maySend = access?.maySend;
  const bank = release.items.some(item => item.criteria.some(isLocalQuestionCriterion));
  if (bank) {
    try { await authorizeBankBasis(deps, tx, release.releaseRef, use, maySend); }
    catch (error) {
      if (!workbookAssessmentReadFailure(deps, error)) throw error;
      return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const,
        reason: deps.assessmentInputsBlocked, score: null };
    }
  }
  let opened: { submission: FactSnapshot; paper: FactSnapshot } | undefined;
  if (access) {
    try {
      const read = deps.createAuthorizedFactReader(tx, use, maySend ?? (() => true));
      const submission = await read.fact(factId(submissionRef.id), { mode: 'following' });
      const paper = await read.fact(factId(release.releaseRef.id), { mode: 'following' });
      if (!sameRef(submission.ref, submissionRef) ||
          (access.releaseEpoch !== undefined && paper.accessEpoch !== access.releaseEpoch) ||
          (access.submissionEpoch !== undefined && submission.accessEpoch !== access.submissionEpoch)) {
        return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const,
          reason: deps.assessmentInputsBlocked, score: null };
      }
      opened = { submission, paper };
    } catch (error) {
      if (!workbookAssessmentReadFailure(deps, error)) throw error;
      return { releaseRef: release.releaseRef, submissionRef, state: 'blocked' as const,
        reason: deps.assessmentInputsBlocked, score: null };
    }
  }
  const result = await deps.readFormalAssessment(tx, workbookAssessmentSlot, release.releaseRef, submissionRef, use,
    opened ? { releaseEpoch: opened.paper.accessEpoch, submissionEpoch: opened.submission.accessEpoch } : undefined);
  if (bank && 'criteria' in result && result.criteria)
    return { ...result, ...publicBankAssessment(result) };
  if (result.state !== 'blocked' || 'derivationId' in result) return result;
  try {
    const read = maySend ? deps.createAuthorizedFactReader(tx, use, maySend) : createCommandReadContext(tx, use);
    const submission = opened?.submission ?? await read.fact(factId(submissionRef.id), { mode: 'following' });
    const paper = opened?.paper ?? await read.fact(factId(release.releaseRef.id), { mode: 'following' });
    if (sameRef(submission.ref, submissionRef)) {
      return await readSavedWorkbookAssessment(deps, tx, release.releaseRef, submission, paper,
        deriver => queryRow(deriver, submission), undefined, use, maySend) ?? result;
    }
  } catch (error) {
    if (!workbookAssessmentReadFailure(deps, error)) throw error;
  }
  return result;
}
