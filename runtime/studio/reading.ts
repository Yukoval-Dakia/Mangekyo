import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { materialType, storagePurpose, textMaterial } from '../../modules/activity/library-values.ts';
import { intakeDocument, intakeFactType } from '../../modules/activity/intake-values.ts';
import { isSourceFactId, sourceReference, type SourceAnchorV1 } from '../../modules/activity/source-values.ts';
import { stableId } from './identity.ts';

export async function readMaterialText(tx: ReadTransaction, id: string) {
  if (!isSourceFactId(id)) return null;
  const read = createCommandReadContext(tx, storagePurpose);
  try {
    const snapshot = await read.fact(factId(id), {mode: 'following'});
    if (snapshot.type !== materialType) return null;
    const material = textMaterial(snapshot.value);
    try {
      const source = await read.fact(factId(stableId('intake-document', id)), {mode: 'following'});
      if (source.type !== intakeFactType) return null;
      const document = intakeDocument(source.value);
      return document.materialId === id
        ? {id, title: document.title, text: document.extraction.text, sourceRef: sourceReference(source, {kind:'whole'})}
        : null;
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
      return {id, title: material.title, text: material.text, sourceRef: sourceReference(snapshot, {kind:'whole'})};
    }
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return null;
    throw error;
  }
}

export function materialTextOf(fact: FactSnapshot) {
  const material = textMaterial(fact.value);
  return {field: 'text', ...material};
}

export function intakeTextOf(fact: FactSnapshot) {
  const document = intakeDocument(fact.value);
  return {field: 'text', ...document, text: document.extraction.text};
}

export function relatedIntakeId(material: FactSnapshot) {
  return factId(stableId('intake-document', material.ref.id));
}

export function relatedMaterialId(document: FactSnapshot) {
  return intakeTextOf(document).materialId;
}

export function materialIntakeReference(material: FactSnapshot, document: FactSnapshot, anchor: SourceAnchorV1) {
  return {...sourceReference(material, anchor), textFact: sourceReference(document, {kind:'whole'}).fact};
}

export function textSlice(text: string, offset: number, limit = 4000) {
  let start = Math.min(offset, text.length);
  const low = (index: number) => index >= 0 && index < text.length && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
  if (low(start)) start--;
  let end = Math.min(start + limit, text.length);
  if (low(end)) end--;
  const content = text.slice(start, end);
  return {content, offset: start, nextOffset: end < text.length ? end : null};
}
