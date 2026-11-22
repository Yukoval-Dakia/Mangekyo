import { createCommandReadContext, factId, FactNotFoundError, FactReadDeniedError, type FactId, type ReadContext, type FactSnapshot, type ReadTransaction } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, questionAsset, questionPrompt, refreshPurposeOnlyTeachingSources } from '@mangekyo/module-content/facts/asset-contract';
import { openQuestionForRelease, questionVerificationKey, questionVerificationType, readQuestionState,
  type QuestionVerification } from '@mangekyo/module-content/facts/question-release';
import { parseQuestionMetaDraft } from '@mangekyo/module-content/facts/question-state';
import { object } from './values.ts';
import { validateBankItem } from './question-assessment.ts';
import { sourceQuestionRef, workbookRequestId } from './workbook-values.ts';
import { textValue, unknownFieldsParser } from './validation.ts';

const use = 'practice';

const disallowUnknownFields = unknownFieldsParser(() => new Error('题库请求含有未声明字段。'));
const fields = (value: Record<string, unknown>, ...keys: readonly string[]) => disallowUnknownFields(value, keys);

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('题库选项须是列表。');
  return value;
}

const text = (value: unknown, label: string): string =>
  textValue(value, () => new Error(`${label}无效。`), { preserveWhitespace: true });

function questionRef(input: unknown) {
  const row = object(input);
  fields(row, 'id', 'rev');
  const { id, rev } = sourceQuestionRef(row)!;
  return { id: factId(id), rev };
}

export type QuestionRef = ReturnType<typeof questionRef>;
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
const mentions = (question: { title: string; prompt: string }, term: string) =>
  normalize(`${question.title}\n${question.prompt}`).includes(normalize(term));

export function parseProposal(row: Record<string, unknown>) {
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

export function parsePaper(row: Record<string, unknown>) {
  fields(row, 'requestId', 'sourceRef', 'proposalId');
  const requestId = workbookRequestId(row.requestId);
  if (row.proposalId !== undefined && row.sourceRef === undefined) return { requestId, proposalId: factId(text(row.proposalId, '提案标识')) };
  if (row.sourceRef !== undefined && row.proposalId === undefined) return { requestId, sourceRef: questionRef(row.sourceRef) };
  throw new Error('请选择提案或固定题版。');
}

export function recordedReferences(receipt: string) {
  const value: unknown = JSON.parse(receipt);
  return list(Array.isArray(value) ? value : object(value).questionRefs).map(questionRef);
}

export async function inspectBankQuestion(read: ReadContext, id: FactId, pinned?: QuestionRef['rev']) {
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
      const ref = { learner: fact.ref.learner, type: questionVerificationType, key: questionVerificationKey(version) };
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
}

export async function inspectStoredBankQuestion(
  read: Pick<ReadContext, 'fact'>,
  fact: FactSnapshot,
  pinned?: QuestionRef['rev'],
) {
  if (fact.type !== assetType || (pinned !== undefined && fact.ref.rev !== pinned)) return;
  const asset = questionAsset(fact.value);
  const { state } = await readQuestionState(read, fact.ref.id);
  const version = { id: fact.ref.id, rev: fact.ref.rev, recheck: state.recheck };
  const restricted = state.restrictions.some(entry => entry.scope === 'all' || entry.scope === use);
  const complete = Boolean(asset.response_schema && asset.assessment_contract);
  const status: 'restricted' | 'draft' | 'needs_verification' = restricted ? 'restricted'
    : complete ? 'needs_verification' : 'draft';
  return { public: { id: fact.ref.id, rev: fact.ref.rev, title: asset.title, prompt: questionPrompt(asset), status }, version };
}

export async function inspectPurposeGrantedBankQuestion(
  storage: Pick<ReadContext, 'fact'>,
  teaching: ReadContext,
  fact: FactSnapshot,
  pinned?: QuestionRef['rev'],
) {
  const stored = await inspectStoredBankQuestion(storage, fact, pinned);
  if (!stored) return;
  const basis = await refreshPurposeOnlyTeachingSources(storage, questionAsset(fact.value).basis ?? []);
  await checkQuestionTeachingSources(teaching, { basis });
  return { ...stored, reviewed: false };
}

export async function inspectTeachingBankQuestion(
  teaching: ReadContext,
  storage: Pick<ReadContext, 'fact'>,
  id: FactId,
  pinned?: QuestionRef['rev'],
): Promise<NonNullable<Awaited<ReturnType<typeof inspectBankQuestion>>> | undefined> {
  const fact = await storage.fact(id, { mode: 'following' }).catch(error => {
    const unavailableFact = error instanceof Error && (error.name === 'FactNotFoundError' || error.name === 'FactReadDeniedError' ||
      error.message.includes(' does not allow read purpose ') || error.message.endsWith(' does not exist for this learner'));
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError || unavailableFact) return undefined;
    throw error;
  });
  if (!fact || fact.type !== assetType || (!fact.purpose.includes('teaching') && !fact.purpose.includes('all'))) return undefined;
  try { return await inspectBankQuestion(teaching, id, pinned); }
  catch (error) {
    const basisChanged = error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。';
    const unavailableFact = error instanceof Error && (error.name === 'FactNotFoundError' || error.name === 'FactReadDeniedError' ||
      error.message.includes(' does not allow read purpose ') || error.message.endsWith(' does not exist for this learner'));
    if (!(basisChanged || unavailableFact || error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
    return inspectPurposeGrantedBankQuestion(storage, teaching, fact, pinned).catch(fallbackError => {
      if (fallbackError instanceof FactNotFoundError || fallbackError instanceof FactReadDeniedError ||
          (fallbackError instanceof Error && fallbackError.message === '题目来源未授权教学用途或依据已变化。')) return undefined;
      throw fallbackError;
    });
  }
}

export async function storedIqdbQuestionView(
  tx: ReadTransaction,
  { id, purposes, teachingOnly, teachingPurpose }: { id: FactId; purposes: readonly string[]; teachingOnly: boolean; teachingPurpose: string },
) {
  const fact = await createCommandReadContext(tx, 'storage').fact(id, { mode: 'following' }).catch(error => {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return;
    throw error;
  });
  if (!fact) return;
  const stored = await inspectStoredBankQuestion(createCommandReadContext(tx, 'storage'), fact).catch(error => {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError) return;
    throw error;
  });
  if (!stored) return;
  const teaching = purposes.includes('teaching') || purposes.includes('all');
  if (!teaching) return teachingOnly ? undefined : { view: stored, teachingAuthorized: false };
  const opened = await inspectPurposeGrantedBankQuestion(
    createCommandReadContext(tx, 'storage'),
    createCommandReadContext(tx, teachingPurpose),
    fact,
  ).catch(error => {
    if (error instanceof FactNotFoundError || error instanceof FactReadDeniedError ||
        (error instanceof Error && error.message === '题目来源未授权教学用途或依据已变化。')) return undefined;
    throw error;
  });
  if (opened) return { view: opened, teachingAuthorized: true };
  return teachingOnly ? undefined : { view: stored, teachingAuthorized: false };
}

export function selectBankQuestions(input: ReturnType<typeof parseProposal>, questions: readonly {id: FactId; rev: QuestionRef['rev']; title: string; prompt: string}[]) {
  return questions.filter(question => [input.need, ...input.coverage].some(term => mentions(question, term)))
    .slice(0, 20).map(({ id, rev }) => ({ id, rev }));
}

export function questionSourceMaterialIds(question: FactSnapshot, metadata: FactSnapshot): ReadonlySet<FactId> {
  const asset = questionAsset(question.value);
  const draft = parseQuestionMetaDraft(metadata.value);
  if (draft.id !== question.ref.id || draft.expectedRev !== question.ref.rev) throw new Error('题目活元信息与题版不匹配。');
  return new Set([...asset.basis ?? [], ...draft.basis].filter(source => source.type === 'activity.textMaterial').map(source => source.id));
}

export function bankProposalView(input: ReturnType<typeof parseProposal>, proposalId: string, requested: readonly QuestionRef[],
  selected: readonly NonNullable<Awaited<ReturnType<typeof inspectBankQuestion>>>[]) {
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
}
