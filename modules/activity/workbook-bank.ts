import { factId, type FactId, type FactSnapshot, type Json, type ReadContext, type Revision } from '@mangekyo/kernel';
import { assetType, checkQuestionTeachingSources, questionAsset, type TextbookBasis } from '@mangekyo/module-content/facts/asset-contract';
import { openQuestionForRelease, projectQuestionPrompt } from '@mangekyo/module-content/facts/question-release';
import { assessmentRelease, type AssessmentRelease } from './assessment-values.ts';
import { validateBankItem } from './question-assessment.ts';
import { workbookAttempt, workbookAttemptType, workbookBankReference, workbookDraft, workbookPaper, workbookPaperType, WorkbookSourceMismatch,
  type WorkbookBankQuestion, type WorkbookPaper, type WorkbookSourceQuestionRef } from './workbook-values.ts';

export function includesBankReferences(value: unknown) {
  const questions = (value as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions) && questions.some(question => question && typeof question === 'object' &&
    Object.keys(question).length === 1 && Object.hasOwn(question, 'sourceQuestionRef'));
}

async function freezeQuestion(read: ReadContext, ref: WorkbookSourceQuestionRef, itemId: string) {
  const source = await read.fact(factId(ref.id), { mode: 'following' });
  let verificationId: string | undefined;
  const released = await openQuestionForRelease({
    fact: read.fact,
    async slot<Value = Json>(...args: Parameters<ReadContext['slot']>) {
      const found = await read.slot<Value>(...args);
      verificationId = found.id;
      return found;
    },
  }, source.ref.id, 'practice');
  if (released.ref.rev !== ref.rev || source.ref.rev !== ref.rev || !verificationId)
    throw new Error('题库题版已变化。');
  const item = { ...released.contract.items[0]!, itemId };
  validateBankItem(item, released.contract.releaseRef);

  const basis = new Map<string, TextbookBasis>();
  const tracked: ReadContext = {
    ...read,
    async fact<Value = Json>(...args: Parameters<ReadContext['fact']>) {
      const fact = await read.fact<Value>(...args);
      if (args[1].mode === 'pinned') {
        const { id, rev } = fact.ref;
        basis.set(JSON.stringify([id, rev]), { id, rev, type: fact.type, epoch: fact.accessEpoch });
      }
      return fact;
    },
  };
  await checkQuestionTeachingSources(tracked, released.asset);
  const projection = await projectQuestionPrompt(tracked, released.asset, item.slots);
  if (projection.kind !== 'ready') throw new Error('题库题面无法发放。');
  const { prompt, controls, sharedMaterials } = projection.content;
  const question: WorkbookBankQuestion = {
    id: itemId, kind: 'bank', prompt, sourceQuestionRef: ref, sourceAccessEpoch: source.accessEpoch, explanation: null,
    sourceBasis: [...basis.values()], verification: { derivationId: verificationId },
    ...(controls[0] ? { interaction: controls[0] } : {}),
    sharedMaterials: sharedMaterials.map(({ blockId, pieces }) => ({ blockId, pieces })),
  };
  return { question, item };
}

export async function freezeWorkbookBank(read: ReadContext, id: FactId, input: Json, savedAt: string): Promise<WorkbookPaper> {
  const raw = input as { questions?: unknown; assessmentRelease?: unknown } | null;
  if (!raw || raw.assessmentRelease !== undefined || !Array.isArray(raw.questions) ||
      raw.questions.length < 1 || raw.questions.length > 100) throw new Error('题库组卷格式无效。');
  const questions = new Map<number, WorkbookBankQuestion>();
  const items: AssessmentRelease['items'][number][] = [];
  for (const [index, entry] of raw.questions.entries()) {
    const ref = workbookBankReference(entry);
    if (!ref) continue;
    try {
      const frozen = await freezeQuestion(read, ref, `q${index + 1}`);
      questions.set(index, frozen.question);
      items.push(frozen.item);
    } catch (error) {
      if (error instanceof Error && !('code' in error))
        throw new WorkbookSourceMismatch('题版、来源或独立核验当前不可用。');
      throw error;
    }
  }
  if (!items.length) throw new Error('请选择题库题项。');
  return { ...workbookDraft(input, questions), savedAt, assessmentRelease: assessmentRelease({
    releaseRef: { id, rev: 1 as Revision }, items,
  }) };
}

type FrozenBankRead = { fact(id: FactId, options: Parameters<ReadContext['fact']>[1]): Promise<FactSnapshot> };

export async function readFrozenWorkbookBank(
  read: FrozenBankRead, paper: WorkbookPaper, track?: (fact: FactSnapshot, mode: 'pinned') => void,
) {
  const opened = new Map<string, Promise<FactSnapshot>>();
  const tracked: FrozenBankRead = {
    fact(id, options) {
      const key = JSON.stringify([id,options.mode,options.mode === 'pinned' ? options.rev : null]);
      const cached = opened.get(key);
      if (cached) return cached;
      const pending = read.fact(id,options).then(fact => {
        if (options.mode === 'pinned') track?.(fact,'pinned');
        return fact;
      });
      opened.set(key,pending);
      return pending;
    },
  };
  const open = async (witness: TextbookBasis) => {
    const fact = await tracked.fact(factId(witness.id), { mode: 'pinned', rev: witness.rev });
    if (fact.type !== witness.type || fact.accessEpoch !== witness.epoch ||
        (!fact.purpose.includes('teaching') && !fact.purpose.includes('all')))
      throw new WorkbookSourceMismatch('题目或来源当前不可读取。');
    return fact;
  };
  for (const question of paper.questions) {
    if (question.kind !== 'bank') continue;
    const source = await open({ id: factId(question.sourceQuestionRef.id), rev: question.sourceQuestionRef.rev, type: assetType, epoch: question.sourceAccessEpoch });
    for (const witness of question.sourceBasis) await open(witness);
    // Previously issued papers can have an incomplete source list. Reopen the
    // original question's fixed ancestry, including its current authorization.
    await checkQuestionTeachingSources(tracked, questionAsset(source.value)).catch(error => {
      if (error instanceof Error && !('code' in error)) throw new WorkbookSourceMismatch('题目或来源当前不可读取。');
      throw error;
    });
  }
}

export async function readFrozenWorkbookRecord(
  read: FrozenBankRead, fact: FactSnapshot, track?: Parameters<typeof readFrozenWorkbookBank>[2],
) {
  if (fact.type === workbookPaperType) await readFrozenWorkbookBank(read, workbookPaper(fact.value), track);
  if (fact.type === workbookAttemptType) await readFrozenWorkbookBank(read, workbookAttempt(fact.value).paper, track);
}
