import { FactNotFoundError, factId, type FactId, type FactSnapshot, type ReadContext } from '@mangekyo/kernel';
import { arithmeticPracticeV1, openArithmeticPractice } from '@mangekyo/module-content/facts/arithmetic-practice';
import { helpRef } from './help-exposure-values.ts';
import { object } from './values.ts';
import { workbookPaper, type WorkbookPaper } from './workbook-values.ts';

export const sealedPracticePurpose = arithmeticPracticeV1;
export const practiceCustodyType = 'activity.practiceCustody';
export const releasePracticeFeedbackCommand = 'activity.releasePracticeFeedback';
async function practiceId(namespace: string, source: FactId) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([namespace,source])));
  return factId(Array.from(new Uint8Array(digest).slice(0,13),byte => byte.toString(16).padStart(2,'0')).join('').toUpperCase());
}
export const practiceCustodyId = (paper: FactId) => practiceId(practiceCustodyType,paper);
export const arithmeticPracticePaperId = (question: FactId) => practiceId(sealedPracticePurpose,question);
type FactReader = {fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot>};

export function practiceCustody(value: unknown) {
  const row = object(value);
  const {kind} = row;
  if (kind !== 'sealed' && kind !== 'possible') throw new Error('封闭练习状态无效。');
  const {savedAt} = row;
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) throw new Error('封闭练习发行时间无效。');
  return {kind, question: helpRef(row.question), paper: helpRef(row.paper), savedAt};
}

export async function readPracticeCustody(read: FactReader, id: FactId) {
  try {
    const fact = await read.fact(id,{mode:'following'});
    if (fact.type !== practiceCustodyType) return;
    return {fact, value:practiceCustody(fact.value)};
  } catch (error) {
    if (!(error instanceof FactNotFoundError)) throw error;
    return undefined;
  }
}

export function arithmeticPracticePaper(opened: NonNullable<Awaited<ReturnType<typeof openArithmeticPractice>>>, savedAt: string): WorkbookPaper {
  const {source, title, prompt, expected} = opened;
  return workbookPaper({title, materialId:null, savedAt, questions:[{id:'question',kind:'numeric',prompt,
    answer:expected,tolerance:0,unit:null,explanation:null,sourceQuestionRef:{id:source.ref.id,rev:source.ref.rev}}]});
}

export async function openSealedPractice(read: FactReader, id: FactId) {
  const custody = await readPracticeCustody(read,await practiceCustodyId(id));
  if (!custody || custody.value.kind !== 'sealed' || custody.value.paper.id !== id) return;
  const {id:sourceId,rev} = custody.value.question;
  const current = await openArithmeticPractice(read,sourceId);
  if (!current) return;
  const pinned = current.source.ref.rev === rev ? current : await openArithmeticPractice(read,sourceId,
    await read.fact(sourceId,{mode:'pinned',rev}));
  if (pinned) return {custody,paper:arithmeticPracticePaper(pinned,custody.value.savedAt)};
  return undefined;
}
