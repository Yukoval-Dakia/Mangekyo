import {assetType, parseAsset, assetBodyReference, questionPrompt} from '../../modules/content/asset.ts';
import {openArithmeticPractice} from '../../modules/content/arithmetic-practice.ts';
import { checkStudioNotionFact, type NotionRecipient } from './notion.ts';
import { projectSource as project } from '../../modules/activity/workspace-source-projection.ts';
export { sourceQuestions, sourceSearchExcerpt, textbookText } from '../../modules/activity/workspace-source-projection.ts';
import {createAuthorizedFactReader, isFactNotFound, isFactUnavailable, purposeReader} from './fact-read-helpers.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId, type FactId, type Revision} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {intakeFactType} from '../../modules/capture/intake-values.ts';
import {materialType, storagePurpose} from '../../modules/activity/library-values.ts';
import {isSourceFactId, sourceReference, sourceRefV1, type SourceAnchorV1} from '../../modules/activity/source-values.ts';
import {readFrozenWorkbookRecord} from '../../modules/activity/workbook-bank.ts';
import {workbookAttemptType, WorkbookSourceMismatch} from '../../modules/activity/workbook-values.ts';
import {openTextbookReference, textbookPageFrom, textbookPageType} from '../../modules/content/textbook-page.ts';
import { WorkspaceInputError, workspaceEntry, workspaceEntryType, workspaceShareableTypes } from '../../modules/activity/workspace-values.ts';
import {syntheticStudyRecords} from './workspace-access.ts';
import {purpose} from './identity.ts';
import {textSlice, intakeTextOf, isMaterialIntakePair, materialIntakeReference, relatedIntakeId, relatedMaterialId, readOwnStudyTurn} from './reading.ts';
import {openWorkbookQuestionSources} from './workbook-diagnosis.ts';

export type SourceReadMode = 'pinned' | 'following';
export type SourceTrack = (fact: FactSnapshot, mode?: SourceReadMode) => void;
export type WorkspaceSourceRecipient = NotionRecipient;
export type SourceAccess = {
  track?: SourceTrack;
  exactReadModes?: true;
  rootType?: string;
  readNotionWitness?: (fact: FactSnapshot) => Promise<FactSnapshot>;
} & (
  | {recipient: 'learner'}
  | {recipient: 'workspace'; maySend: WorkspaceSourceRecipient; purpose?: string; ownerNotionRead?: true}
);

function conceptAsset(fact: FactSnapshot) {
  const asset = parseAsset(fact.value);
  if (asset.kind !== 'concept' || !asset.title.trim()) return;
  const content = asset.blocks.map(block => block.body.kind === 'text'
    ? block.body.text : block.body.kind === 'formula' ? block.body.latex : '').filter(Boolean).join('\n\n');
  return {title: asset.title, content: content || asset.title};
}

export function sourcePurpose(access: SourceAccess): string {
  return access.recipient === 'learner' ? storagePurpose : access.purpose ?? purpose;
}

export function sourceMaySend(access: SourceAccess, fact: FactSnapshot): boolean {
  return access.recipient === 'learner' || access.maySend(fact);
}

export async function resolveSource(tx: ReadTransaction, input: unknown, access: SourceAccess, mode: SourceReadMode = 'pinned',
  bound?: ReturnType<typeof createAuthorizedFactReader>) {
  const reference = sourceRefV1(input);
  const textReference = reference?.textFact;
  if (textReference && (reference.fact.type !== materialType || textReference.type !== intakeFactType ||
      textReference.id !== relatedIntakeId(factId(reference.fact.id)))) return;
  const id = reference?.fact.id ?? input;
  if (!isSourceFactId(id) || (mode !== 'pinned' && mode !== 'following')) return;
  const anchor: SourceAnchorV1 = reference?.anchor ?? {kind: 'whole'};
  const accepts = (fact: FactSnapshot) => sourceMaySend(access, fact);
  const pinnedQuestion = reference?.fact.type === assetType && access.recipient === 'learner' && mode === 'pinned' && !access.rootType;
  if (pinnedQuestion && (reference.anchor.kind !== 'question' || reference.anchor.itemId !== 'question' || reference.textFact)) return;
  const reader = pinnedQuestion ? purposeReader(tx, accepts) :
    bound ?? createAuthorizedFactReader(tx, sourcePurpose(access), accepts);
  const seen = new Map<string, {fact:FactSnapshot; pinned:boolean}>();
  const path = new Set<string>();
  const questionSources: Parameters<SourceTrack>[] = [];
  const checkedAttempts = new Set<string>();
  const rootType = (fact: FactSnapshot) =>
    (!access.rootType || fact.type === access.rootType) && (!reference || fact.type === reference.fact.type) &&
    (fact.type === assetType || workspaceShareableTypes.includes(fact.type) || fact.type === intakeFactType ||
      fact.type === textbookPageType);

  async function visit(sourceId: string, revision?: Revision, ownerTurnWitness = false): Promise<FactSnapshot | undefined> {
    if (path.size >= 32 || seen.size >= 1024 || syntheticStudyRecords.has(sourceId)) return;
    const options = revision === undefined ? {mode:'following'} as const : {mode:'pinned', rev:revision} as const;
    const fact = ownerTurnWitness ? await readOwnStudyTurn(tx, sourceId, options) : await reader.fact(factId(sourceId), options);
    if (access.recipient === 'learner' || access.ownerNotionRead)
      await checkStudioNotionFact(tx, fact, storagePurpose, 'learner', access.readNotionWitness);
    else await checkStudioNotionFact(tx, fact, sourcePurpose(access), access.maySend, access.readNotionWitness);
    const key = `${sourceId}:${fact.ref.rev}`;
    if (path.has(key)) return;
    const visited = seen.get(key);
    if (visited) {
      if (revision === undefined) visited.pinned = false;
      return visited.fact;
    }
    if (sourceId === id && !path.size && !rootType(fact)) return;
    path.add(key);
    const bankSources: [FactSnapshot, 'pinned' | 'following'][] = [];
    await readFrozenWorkbookRecord(reader, fact, (...proof) => bankSources.push(proof));
    for (const [source, mode] of bankSources) {
      if (!await visit(source.ref.id,mode === 'pinned' ? source.ref.rev : undefined)) return;
    }
    if (fact.type === workspaceEntryType) {
      const entry = workspaceEntry(fact.value);
      for (const witness of entry.basis) {
        const source = await visit(witness.id);
        if (!source || source.ref.rev !== witness.rev || source.accessEpoch !== witness.epoch) return;
        if (access.recipient === 'workspace' && (entry.kind === 'observation' || entry.kind === 'annotation') &&
            source.type === workbookAttemptType && !checkedAttempts.has(witness.id)) {
          const opened = await openWorkbookQuestionSources(tx, source, {...access, purpose: sourcePurpose(access), track: (...proof) => questionSources.push(proof)});
          if (!opened) return;
          checkedAttempts.add(witness.id);
        }
      }
      const sources = new Set([...seen.values()].map(w => w.fact.ref.id));
      if (!entry.links.every(link => sources.has(factId(link)))) return;
    } else if (fact.type === textbookPageType || fact.type === assetType) {
      const page = fact.type === textbookPageType ? textbookPageFrom(fact) : parseAsset(fact.value);
      for (const source of page.basis ?? []) {
        // The learner can reopen their own turn as a page witness. Direct references still use the requested purpose.
        const ownerTurnWitness = access.recipient === 'learner' && fact.type === textbookPageType && source.type === 'activity.studyTurn';
        const opened = await visit(source.id, source.rev, ownerTurnWitness);
        if (!opened || opened.type !== source.type || opened.accessEpoch !== source.epoch) return;
      }
      for (const block of page.blocks) {
        const reference = assetBodyReference(block.body);
        if (!reference) continue;
        if (reference.fact.learner !== tx.learner || !await visit(reference.fact.id, reference.fact.rev)) return;
        await openTextbookReference(reader, reference);
      }
    }
    path.delete(key);
    seen.set(key, {fact, pinned: revision !== undefined});
    return fact;
  }
  try {
    const rootRevision = reference?.fact.rev as Revision | undefined;
    if (reference && mode === 'following') {
      const original = await reader.fact(factId(id), {mode:'pinned', rev:rootRevision as Revision});
      if (!rootType(original)) return;
      if (textReference) {
        const text = await reader.fact(factId(textReference.id), {mode:'pinned', rev:textReference.rev as Revision});
        if (original.type !== materialType || !isMaterialIntakePair(original.ref.id, text)) return;
        const oldText = intakeTextOf(text).text;
        const originalAnchor = anchor.kind === 'text' ? (() => {
          const {offset, nextOffset} = textSlice(oldText, anchor.start, Math.max(0, anchor.end-anchor.start));
          return {...anchor, start:offset, end:nextOffset ?? oldText.length};
        })() : anchor;
        if (!project(text, originalAnchor, access.recipient)) return;
      } else if (original.type === assetType) {
        if (!pinnedQuestion && anchor.kind === 'question' && anchor.itemId === 'question') {
          const question = parseAsset(original.value);
          if (question.kind !== 'question' || !questionPrompt(question)) return;
        } else if (!pinnedQuestion && anchor.kind === 'whole' && conceptAsset(original)) {
          // A canonical knowledge entity is readable as a whole concept.
        } else if (!pinnedQuestion && !await openArithmeticPractice(reader,original.ref.id,original)) return;
      } else if (!project(original, anchor, access.recipient)) return;
    }
    const fact = await visit(id, mode === 'pinned' ? rootRevision : undefined);
    if (!fact) return;
    if (fact.type === assetType && !pinnedQuestion) {
      if (anchor.kind !== 'whole' && (anchor.kind !== 'question' || anchor.itemId !== 'question')) return;
      const concept = anchor.kind === 'whole' ? conceptAsset(fact) : undefined;
      if (concept) {
        access.track?.(fact, reference ? mode : 'following');
        return {id:fact.ref.id,rev:fact.ref.rev,sourceRef:sourceReference(fact,anchor),
          kind:'concept' as const,title:concept.title,content:concept.content};
      }
      const result = await openArithmeticPractice(reader,fact.ref.id,fact);
      const question = result ?? (() => {
        const asset = parseAsset(fact.value);
        return asset.kind === 'question'
          ? {source: fact, state: fact, title: asset.title, prompt: questionPrompt(asset), expected: undefined, practice: undefined}
          : undefined;
      })();
      if (!question) return;
      access.track?.(fact, reference ? mode : 'following');
      if (result) access.track?.(result.state,'following');
      return {id:fact.ref.id,rev:fact.ref.rev,sourceRef:sourceReference(fact,anchor),
        kind:'question' as const,title:question.title,content:question.prompt};
    }
    let body = fact;
    let linkedMaterial: FactSnapshot | undefined;
    if (fact.type === materialType || fact.type === intakeFactType) {
      const documentId = fact.type === materialType ? relatedIntakeId(fact.ref.id) : factId(id);
      const documentRevision = textReference?.rev as Revision | undefined;
      // Check for a missing current fact before visiting a pinned revision. Only
      // a genuinely unpaired material may use its own text.
      let currentDocument: FactSnapshot;
      try {
        currentDocument = await reader.fact(documentId, {mode: 'following'});
      } catch (error) {
        if (!isFactNotFound(error)) throw error;
        if (fact.type !== materialType || textReference) return;
        const projection = project(fact, anchor, access.recipient);
        if (!projection) return;
        access.track?.(fact, reference ? mode : 'following');
        return {id: fact.ref.id, rev: fact.ref.rev, sourceRef: sourceReference(fact, anchor), ...projection};
      }
      if (currentDocument.type !== intakeFactType) return;
      let material: FactSnapshot | undefined = fact;
      if (fact.type === intakeFactType) {
        const materialId = relatedMaterialId(currentDocument);
        // A pinned OCR uses the paired material for identity and access only.
        // Freeze its authorized revision for replay while retaining its access epoch.
        const pinnedPair = access.exactReadModes && reference && mode === 'pinned';
        const materialRev = pinnedPair ? (await reader.fact(materialId, {mode:'following'})).ref.rev : undefined;
        material = await visit(materialId, materialRev);
      }
      if (!material || material.type !== materialType || !isMaterialIntakePair(material.ref.id, currentDocument)) return;
      const document = fact.type === intakeFactType ? fact :
        mode === 'pinned' && documentRevision !== undefined
          ? await reader.fact(documentId, {mode: 'pinned', rev: documentRevision})
          : currentDocument;
      if (!isMaterialIntakePair(material.ref.id, document)) return;
      // A directly opened intake already carries the mode of its own reference.
      if (fact.type === materialType)
        seen.set(`${documentId}:${document.ref.rev}`, {fact:document,pinned:mode === 'pinned' && documentRevision !== undefined});
      linkedMaterial = material;
      body = document;
    }
    const projectionAnchor = (mode === 'following' && anchor.kind === 'text' && body.type === intakeFactType)
      ? {...anchor, end:Math.min(anchor.end, intakeTextOf(body).text.length)} : anchor;
    const question = pinnedQuestion ? parseAsset(fact.value) : undefined;
    if (question && question.kind !== 'question') return;
    const projection: ReturnType<typeof project> = question?.kind === 'question'
      ? {title: question.title, content: questionPrompt(question)}
      : project(body, projectionAnchor, access.recipient);
    if (!projection) return;
    for (const {fact:witness, pinned} of seen.values())
      access.track?.(witness, pinned ? 'pinned' : 'following');
    for (const proof of questionSources) access.track?.(...proof);
    return {...projection, id: fact.ref.id, rev: fact.ref.rev, sourceRef: body === fact ? sourceReference(fact, projectionAnchor) : materialIntakeReference(linkedMaterial!, body, projectionAnchor)};
  } catch (error) {
    if (isFactUnavailable(error) || error instanceof WorkspaceInputError || error instanceof WorkbookSourceMismatch) return;
    throw error;
  }
}
