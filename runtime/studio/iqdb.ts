import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { Db, DbTransaction, ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { validateBankItem } from '../../modules/activity/question-assessment.ts';
import { workbookRequestId } from '../../modules/activity/workbook-values.ts';
import { assetType, checkQuestionTeachingSources, questionAsset, questionPrompt } from '../../modules/content/asset.ts';
import { fields, list, pageId, record, revision, text } from '../../modules/content/parse.ts';
import { readQuestionState, type QuestionVerification } from '../../modules/content/question-state.ts';
import { openQuestionForRelease, questionVerificationKey, questionVerificationType } from '../../modules/content/question-verification.ts';
import { purpose, stableId, studioLearner } from './identity.ts';
import { enqueueQuestionVerification, readCurrentQuestionVerification } from './iqdb-verification.ts';
import { RequestError } from './sessions.ts';

function questionRef(input: unknown) {
  const row = record(input);
  fields(row, 'id', 'rev');
  return { id: pageId(row.id), rev: revision(row.rev) };
}

type QuestionRef = ReturnType<typeof questionRef>;
export type IssueBank = (tx: DbTransaction, input: { requestId: string; questionRefs: readonly QuestionRef[]; deletionWatermark: string }) => Promise<{ id: FactId }>;
const scope = { learner: studioLearner };
const use = 'practice';
const proposalLabel = 'iqdb-proposal';
const blocked = () => new RequestError(409, '请重新选择当前获准且已独立验收的固定题版。');
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const mentions = (question: { title: string; prompt: string }, term: string) =>
  normalize(`${question.title}\n${question.prompt}`).includes(normalize(term));

function parseProposal(row: Record<string, unknown>) {
  fields(row, 'requestId', 'need', 'durationMinutes', 'coverage', 'questionRefs');
  const { durationMinutes } = row;
  const need = text(row.need, '练习需求').trim();
  const coverage = list(row.coverage ?? []).map(value => text(value, '覆盖目标').trim());
  const questionRefs = list(row.questionRefs ?? []).map(questionRef);
  if (typeof durationMinutes !== 'number' || !Number.isSafeInteger(durationMinutes) || durationMinutes < 1 ||
      durationMinutes > 240 || need.length > 500 || coverage.length > 20 || coverage.some(value => value.length > 120) ||
      new Set(coverage).size !== coverage.length || questionRefs.length > 20 ||
      new Set(questionRefs.map(ref => ref.id)).size !== questionRefs.length) throw new Error('练习范围或时长无效。');
  return { requestId: workbookRequestId(row.requestId), need, durationMinutes, coverage, questionRefs };
}

function parsePaper(row: Record<string, unknown>) {
  fields(row, 'requestId', 'sourceRef', 'proposalId');
  const requestId = workbookRequestId(row.requestId);
  if (row.proposalId !== undefined && row.sourceRef === undefined) return { requestId, proposalId: pageId(row.proposalId) };
  if (row.sourceRef !== undefined && row.proposalId === undefined) return { requestId, sourceRef: questionRef(row.sourceRef) };
  throw new Error('请选择提案或固定题版。');
}

function recordedReferences(receipt: string) {
  const value: unknown = JSON.parse(receipt);
  return list(Array.isArray(value) ? value : record(value).questionRefs).map(questionRef);
}

function validated<Result>(parse: () => Result) {
  try { return parse(); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '题库请求无效。'); }
}

async function inspectQuestion(tx: ReadTransaction, id: FactId, pinned?: QuestionRef['rev']) {
  const read = { ...createCommandReadContext(tx, purpose), slot: readCurrentQuestionVerification(tx) };
  try {
    const fact = await read.fact(id, { mode: 'following' });
    if (fact.type !== assetType || (pinned !== undefined && fact.ref.rev !== pinned)) return;
    const asset = questionAsset(fact.value);
    await checkQuestionTeachingSources(read, asset);
    const { state } = await readQuestionState(read, id);
    const version = { id, rev: fact.ref.rev, recheck: state.recheck };
    const restricted = state.restrictions.some(entry => entry.scope === 'all' || entry.scope === use);
    const complete = Boolean(asset.response_schema && asset.assessment_contract);
    let status: 'restricted' | 'draft' | 'needs_verification' | 'release_ready' = restricted ? 'restricted'
      : complete ? 'needs_verification' : 'draft';
    let reviewed = false;
    if (status === 'needs_verification') {
      try {
        const ref = { learner: tx.learner, type: questionVerificationType, key: questionVerificationKey(version) };
        const { outcome } = await read.slot<QuestionVerification>(ref, { mode: 'following' });
        reviewed = outcome.kind === 'value' && outcome.value.status === 'needs-review';
        if (outcome.kind === 'value' && outcome.value.status === 'ready') {
          const { contract } = await openQuestionForRelease(read, id, use);
          reviewed = true;
          try { validateBankItem(contract.items[0]!, contract.releaseRef); status = 'release_ready'; }
          catch { status = 'restricted'; }
        }
      } catch (error) {
        if (!(error instanceof FactNotFoundError) &&
            !(error instanceof Error && error.message === '这版题目需要当前有效的独立验收。')) throw error;
      }
    }
    return { public: { id, rev: fact.ref.rev, title: asset.title, prompt: questionPrompt(asset), status }, version, reviewed };
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
        (error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。')) return;
    throw error;
  }
}

async function listQuestions(tx: ReadTransaction) {
  const { rows } = await tx.query<{ id: FactId }>(
    `SELECT f.id FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='question'
       AND f.purpose && ARRAY[$3,'all']::text[] ORDER BY f.id`, [tx.learner, assetType, purpose],
  );
  const questions = [];
  for (const { id } of rows) {
    const opened = await inspectQuestion(tx, id);
    if (opened) questions.push(opened.public);
  }
  return questions;
}

export function openIqdb(db: Db, verificationConfigured: boolean, issueBank: IssueBank) {
  return {
    questions: () => db.snapshot(scope, async tx => ({ questions: await listQuestions(tx) })),
    async proposals({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parseProposal(raw));
      const proposalId = stableId(proposalLabel, input.requestId);
      const saved = await recordLocalRead(db, { ...scope, ownerKind: 'session', ownerId: proposalId,
        stepKey: 'plan', label: proposalLabel, input }, async tx => {
        const questionRefs = input.questionRefs.length ? input.questionRefs : (await listQuestions(tx))
          .filter(question => [input.need, ...input.coverage].some(term => mentions(question, term)))
          .slice(0, 20).map(({ id, rev }) => ({ id, rev }));
        return JSON.stringify({ ...input, questionRefs });
      }, tx => assertDeletionWatermark(tx, watermark)).catch(error => {
        if (error instanceof Error && error.message === 'Workspace read receipt does not match the request')
          throw new RequestError(409, '这个请求标识已经用于另一份提案。');
        throw error;
      });
      return db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await assertDeletionWatermark(tx, watermark);
        const requested = recordedReferences(saved);
        const selected: NonNullable<Awaited<ReturnType<typeof inspectQuestion>>>[] = [];
        for (const ref of requested) {
          const opened = await inspectQuestion(tx, ref.id, ref.rev);
          if (!opened) continue;
          if (verificationConfigured && opened.public.status === 'needs_verification' && !opened.reviewed)
            await enqueueQuestionVerification(tx, opened.version);
          selected.push(opened);
        }
        const issue = selected.length > 0 && selected.length === requested.length &&
          selected.every(entry => entry.public.status === 'release_ready');
        const gaps = ['duration_unestimated', ...(input.coverage.length ? ['coverage_unconfirmed'] : []),
          ...(!requested.length ? ['no_matching_question'] : []),
          ...(selected.length !== requested.length ? ['question_unavailable'] : []),
          ...selected.flatMap(({ public: question }) => question.status === 'release_ready' ? [] : [question.status])];
        return { ...input, proposalId, questionRefs: selected.map(({ public: { id, rev } }) => ({ id, rev })),
          coverage: input.coverage.map(target => ({ target,
            status: selected.some(({ public: question }) => mentions(question, target)) ? 'mentioned' : 'unconfirmed' })),
          gaps: [...new Set(gaps)], next: issue ? 'issue' : 'review_questions' };
      });
    },
    async papers({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parsePaper(raw));
      return db.tx(scope, async tx => {
        await lockLearner(tx, tx.learner);
        await assertDeletionWatermark(tx, watermark);
        let refs;
        if (input.sourceRef) refs = [input.sourceRef];
        else {
          const { rows: [saved] } = await tx.query<{ result: string }>(
            `SELECT result FROM effects WHERE learner_id=$1 AND owner_kind='session' AND owner_id=$2
             AND step_key='plan' AND label=$3 AND state='done'`, [tx.learner, input.proposalId, proposalLabel],
          );
          if (!saved) throw new RequestError(404, '找不到这份题库提案。');
          refs = recordedReferences(saved.result);
        }
        if (!refs.length) throw blocked();
        return issueBank(tx, { requestId: input.requestId, questionRefs: refs, deletionWatermark: watermark });
      });
    },
  };
}
