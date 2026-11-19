import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
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
    const link = await materialIntakeLink(tx, snapshot.ref.id);
    if (!link || !link.purpose.includes(storagePurpose)) {
      const material = textMaterial(snapshot.value);
      return {id, title: material.title, text: material.text, sourceRef: sourceReference(snapshot, {kind:'whole'})};
    }
    if (link.materialId !== id || link.retracted) return null;
    const source = await read.fact(link.id, {mode: 'following'});
    const document = intakeDocument(source.value);
    return {
      id,
      title: document.title,
      text: document.extraction.text,
      sourceRef: materialIntakeReference(snapshot, source, {kind:'whole'}),
    };
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

export function relatedIntakeId(materialId: FactId) {
  return factId(stableId('intake-document', materialId));
}

export async function materialIntakeLink(tx: ReadTransaction, materialId: FactId) {
  const id = relatedIntakeId(materialId);
  const {rows: [row]} = await tx.query<{
    rev: number;
    purpose: string[];
    retracted: boolean;
    materialId: string | null;
  }>(
    `SELECT f.current_rev AS rev, f.purpose, f.retracted_rev IS NOT NULL AS retracted,
            r.data->>'materialId' AS "materialId"
     FROM facts f
     LEFT JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id=$2 AND f.type=$3`,
    [tx.learner, id, intakeFactType],
  );
  if (!row || (!row.retracted && isSourceFactId(row.materialId) && row.materialId !== materialId)) return;
  return {id, ...row};
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
