import {
  factId, FactNotFoundError, type BusWitness, type FactId, type FactSnapshot, type ReadContext, type Revision, type Tick,
} from '@mangekyo/kernel';
import { licensedQuestionCopy, type ActivityEvidenceReadScope } from './evidence-read.ts';
import { readFrozenWorkbookBank } from './workbook-bank.ts';
import {
  normalizeExactWorkbookAnswer,
  normalizeWorkbookAnswer,
  sameWorkbookJson,
  workbookPaper,
  workbookPaperType,
  WorkbookSourceMismatch,
  type WorkbookAnswer,
  type WorkbookAttemptRequest,
  type WorkbookPaper,
  type WorkbookQuestion,
} from './workbook-values.ts';

export type PreSubmitRevisionCheck = {
  readonly paperId: FactId;
  readonly paperRev: Revision;
  readonly paper: WorkbookPaper;
  readonly attemptId: FactId;
  readonly submittedAt: string;
  readonly candidateItemIds: readonly string[];
};

export type PreSubmitRevisionWitness = {
  verify(request: PreSubmitRevisionCheck): Promise<boolean>;
};

const preSubmitRevisionWitnessKey = Symbol('workbookPreSubmitRevisionWitness');

export function bindPreSubmitRevisionWitness(base: ReadContext, witness: PreSubmitRevisionWitness): ReadContext {
  return Object.assign(base, { [preSubmitRevisionWitnessKey]: witness });
}

function samePreSubmitAnswer(question: WorkbookQuestion, original: WorkbookAnswer, submitted: WorkbookAnswer): boolean {
  if (question.kind === 'exact' && typeof original === 'string' && typeof submitted === 'string') {
    return normalizeExactWorkbookAnswer(original) === normalizeExactWorkbookAnswer(submitted);
  }
  return sameWorkbookJson(original, submitted);
}

export function candidatePreSubmitRevisedItems(params: {
  readonly paper: WorkbookPaper;
  readonly paperRev: Revision;
  readonly data: WorkbookAttemptRequest;
  readonly gradedAnswers: Readonly<Record<string, WorkbookAnswer>>;
}): string[] {
  const { paper, paperRev, data, gradedAnswers } = params;
  if (!data.preSubmitRevisions?.length) return [];
  if (data.paperRev !== undefined && data.paperRev !== paperRev) return [];
  const byId = new Map(paper.questions.map((question, index) => [question.id, { question, index }] as const));
  const candidates: string[] = [];
  for (const click of data.preSubmitRevisions) {
    if (click.draftRequestId !== data.requestId || click.paperRev !== paperRev) continue;
    const matched = byId.get(click.itemId);
    if (!matched) continue;
    let original: WorkbookAnswer;
    try {
      original = normalizeWorkbookAnswer(paper, matched.question, click.originalAnswer, matched.index);
    } catch {
      continue;
    }
    if (original === null) continue;
    const submitted = gradedAnswers[click.itemId] ?? null;
    if (submitted === null || samePreSubmitAnswer(matched.question, original, submitted)) continue;
    candidates.push(click.itemId);
  }
  return candidates;
}

export async function resolveWorkbookPreSubmitRevised(read: ReadContext, params: {
  readonly paperId: FactId;
  readonly paperRev: Revision;
  readonly paper: WorkbookPaper;
  readonly attemptId: FactId;
  readonly data: WorkbookAttemptRequest;
  readonly gradedAnswers: Readonly<Record<string, WorkbookAnswer>>;
  readonly sealed: boolean;
}): Promise<boolean> {
  if (params.sealed) return false;
  const candidateItemIds = candidatePreSubmitRevisedItems(params);
  if (!candidateItemIds.length) return false;
  const witness = (read as ReadContext & { [preSubmitRevisionWitnessKey]?: PreSubmitRevisionWitness })[preSubmitRevisionWitnessKey];
  if (!witness) return false;
  return Boolean(await witness.verify({
    paperId: params.paperId,
    paperRev: params.paperRev,
    paper: params.paper,
    attemptId: params.attemptId,
    submittedAt: params.data.submittedAt,
    candidateItemIds,
  }));
}

type FactReader = { fact(...args: Parameters<ReadContext['fact']>): Promise<FactSnapshot> };

export function busWitnessOf(fact: FactSnapshot, mode: 'pinned' | 'following' = 'following'): BusWitness {
  return { learner: fact.ref.learner, id: fact.ref.id, rev: fact.ref.rev, accessEpoch: fact.accessEpoch, type: fact.type, mode };
}

function witnessKey(witness: BusWitness) {
  return JSON.stringify([witness.learner, witness.id, witness.rev, witness.accessEpoch, witness.type, witness.mode]);
}

async function openSafe<T>(run: () => Promise<T>, isDenied: (error: unknown) => boolean): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FactNotFoundError || error instanceof WorkbookSourceMismatch || isDenied(error)) return undefined;
    throw error;
  }
}

export async function collectPreSubmitRuleBasis(params: {
  readonly read: FactReader;
  readonly isDenied: (error: unknown) => boolean;
  readonly kind: 'sticky' | 'misconception' | 'metacognitive_habit';
  readonly id: FactId;
  readonly extraBasis?: readonly BusWitness[];
}): Promise<{ readonly ref: BusWitness; readonly basis: readonly BusWitness[] } | undefined> {
  const fact = await openSafe(() => params.read.fact(params.id, { mode: 'following' }), params.isDenied);
  if (!fact) return undefined;
  const basisMap = new Map<string, BusWitness>();
  const addBasis = (witness: BusWitness) => basisMap.set(witnessKey(witness), witness);
  const value = fact.value && typeof fact.value === 'object' && !Array.isArray(fact.value)
    ? fact.value as Readonly<Record<string, unknown>> : undefined;
  if (params.kind === 'sticky' && value?.origin === 'turn' && value.action === 'correct' &&
      Array.isArray(value.evidence_refs) && value.evidence_refs.length === 1) {
    const quote = value.evidence_refs[0] as { id?: unknown } | null;
    if (typeof quote?.id === 'string') {
      const turn = await openSafe(() => params.read.fact(factId(quote.id as string), { mode: 'following' }), params.isDenied);
      if (turn?.type === 'activity.studyTurn') addBasis(busWitnessOf(turn, 'following'));
    }
  } else if (params.kind !== 'sticky' && Array.isArray(value?.evidence_refs)) {
    for (const entry of value.evidence_refs) {
      const ref = entry as { id?: unknown; rev?: unknown; accessEpoch?: unknown } | null;
      if (typeof ref?.id !== 'string' || typeof ref.rev !== 'number' || typeof ref.accessEpoch !== 'string') continue;
      const current = await openSafe(() => params.read.fact(factId(ref.id as string), { mode: 'following' }), params.isDenied);
      if (current && current.ref.rev === ref.rev && current.accessEpoch === ref.accessEpoch) {
        addBasis(busWitnessOf(current, 'following'));
        continue;
      }
      const pinned = await openSafe(() => params.read.fact(factId(ref.id as string), { mode: 'pinned', rev: ref.rev as Revision }), params.isDenied);
      if (pinned && pinned.accessEpoch === ref.accessEpoch) addBasis(busWitnessOf(pinned, 'pinned'));
    }
  }
  for (const extra of params.extraBasis ?? []) addBasis(extra);
  return { ref: busWitnessOf(fact, 'following'), basis: [...basisMap.values()] };
}

export async function openFrozenPreSubmitPaper(params: {
  readonly tx: ActivityEvidenceReadScope;
  readonly read: FactReader;
  readonly purpose: string;
  readonly observedThrough: Tick;
  readonly witness: BusWitness;
  readonly isDenied: (error: unknown) => boolean;
  readonly readConceptLinks: (
    source: WorkbookPaper['questions'][number]['sourceQuestionRef'],
  ) => Promise<readonly { conceptId: string; opened: readonly (readonly [FactSnapshot, ('pinned' | 'following' | undefined)?])[] }[]>;
}) {
  const opened = await openSafe(() => params.read.fact(params.witness.id, { mode: 'following' }), params.isDenied);
  if (!opened || opened.type !== workbookPaperType || opened.ref.rev !== params.witness.rev ||
      opened.accessEpoch !== params.witness.accessEpoch) return undefined;
  const paper = workbookPaper(opened.value);
  const basisMap = new Map<string, BusWitness>();
  const track = (dep: FactSnapshot, mode: 'pinned' | 'following' = 'following') =>
    basisMap.set(witnessKey(busWitnessOf(dep, mode)), busWitnessOf(dep, mode));
  const items = await openSafe(async () => {
    if (paper.materialId !== null) track(await params.read.fact(factId(paper.materialId), { mode: 'following' }), 'following');
    await readFrozenWorkbookBank(params.read as Pick<ReadContext, 'fact'>, paper, (dep, mode) => track(dep, mode));
    const rows = [];
    for (const [index, question] of paper.questions.entries()) {
      if (question.kind !== 'bank' && question.sourceQuestionRef) {
        const readable = await licensedQuestionCopy(params.tx, question.sourceQuestionRef, params.purpose);
        track(await params.read.fact(factId(readable.id), { mode: 'pinned', rev: readable.rev }), 'pinned');
      }
      const links = await params.readConceptLinks(question.sourceQuestionRef);
      for (const link of links) {
        for (const [dep, mode] of link.opened) track(dep, mode ?? 'following');
      }
      rows.push({ itemId: question.id, number: index + 1, conceptIds: [...new Set(links.map(link => link.conceptId))] });
    }
    return rows;
  }, params.isDenied);
  return items ? { ref: params.witness, items, basis: [...basisMap.values()] } : undefined;
}
