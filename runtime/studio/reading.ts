import { createHash } from 'node:crypto';
import { intakeTextOf, materialTextOf } from '../../modules/activity/workspace-source-projection.ts';
export { intakeTextOf, materialTextOf, textSlice } from '../../modules/activity/workspace-source-projection.ts';
import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { createCommandReadContext, FactNotFoundError, isFactReadDenied, storageRead, teachingRead } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId, type FactId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { FactReadOptions, FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { materialType, storagePurpose } from '../../modules/activity/library-values.ts';
import { intakeDocument, intakeFactType } from '../../modules/capture/intake-values.ts';
import { isSourceFactId, sourceReference, type SourceAnchorV1 } from '../../modules/activity/source-values.ts';
import { studyTurn, type studyAttachment } from '../../modules/activity/values.ts';
import { purpose, stableId } from './identity.ts';

async function readStudyTurn(tx: ReadTransaction, id: string, use: string, options: FactReadOptions) {
  const fact = await createCommandReadContext(tx, use).fact(factId(id), options);
  if (fact.type !== 'activity.studyTurn') throw new FactNotFoundError('学习回合不存在。');
  return fact;
}

export const readTeachingTurn = (tx: ReadTransaction, id: string) => readStudyTurn(tx, id, purpose, {mode:'following'});

export async function readOwnStudyTurn(tx: ReadTransaction, id: string, options: FactReadOptions = {mode:'following'}) {
  try {
    return await readStudyTurn(tx, id, storagePurpose, options);
  } catch (error) {
    if (isFactReadDenied(error) && error.reason === 'purpose') return readStudyTurn(tx, id, purpose, options);
    throw error;
  }
}

export async function readMaterialText(tx: ReadTransaction, id: string) {
  if (!isSourceFactId(id)) return null;
  const read = storageRead(tx);
  return await readable(async () => {
    const snapshot = await read.fact(factId(id), {mode: 'following'});
    if (snapshot.type !== materialType) return null;
    const link = await materialIntakeLink(tx, snapshot.ref.id);
    if (!link) {
      const material = materialTextOf(snapshot);
      return {id, title: material.title, text: material.text, sourceRef: sourceReference(snapshot, {kind:'whole'})};
    }
    if (!link.matches) return null;
    const source = await read.fact(link.id, {mode: 'following'});
    if (!isMaterialIntakePair(snapshot.ref.id, source)) return null;
    const document = intakeTextOf(source);
    return {
      id,
      title: document.title,
      text: document.text,
      sourceRef: materialIntakeReference(snapshot, source, {kind:'whole'}),
    };
  }) ?? null;
}

export async function attachmentSources(tx: ReadTransaction, attachment: ReturnType<typeof studyAttachment>) {
  const source = await readMaterialText(tx, attachment.id);
  if (!source || source.title !== attachment.title || !source.text.includes(attachment.text)) return;
  const read = storageRead(tx);
  const witnesses = await Promise.all([source.sourceRef.fact, ...(source.sourceRef.textFact ? [source.sourceRef.textFact] : [])]
    .map(async ({id, rev}) => {
      const {ref, accessEpoch} = await read.fact(factId(id), {mode:'pinned', rev:rev as Revision});
      return {ref:{id:ref.id, rev:ref.rev}, accessEpoch};
    }));
  return {witnesses, digest:createHash('sha256').update(JSON.stringify(witnesses)).digest('hex')};
}

export async function attachmentCurrent(tx: ReadTransaction, origin: ReturnType<typeof studyTurn>) {
  if (!origin.attachment) return true;
  const opened = await attachmentSources(tx, origin.attachment);
  if (!opened) return false;
  if (origin.attachmentBasis !== undefined) return opened.digest === origin.attachmentBasis;
  // Older turns carry the excerpt but no basis. Only reuse it if every
  // currently selected source revision was already present when selected.
  const {rows:[row]} = await tx.query<{count:number}>(`
    SELECT count(*)::int AS count FROM fact_revs source
    JOIN facts turn ON turn.learner_id=source.learner_id AND turn.id=$2
    JOIN jsonb_to_recordset($3::jsonb) AS ref(id text, rev integer) ON (source.fact_id,source.rev)=(ref.id,ref.rev)
    WHERE source.learner_id=$1 AND source.tick<=turn.created_tick`, [tx.learner,origin.sessionId,JSON.stringify(opened.witnesses.map(w=>w.ref))]);
  return row?.count === opened.witnesses.length;
}

export async function teachingOrigin(tx: ReadTransaction, turn: ReturnType<typeof studyTurn>) {
  if (!turn.parentId) return turn;
  return studyTurn((await teachingRead(tx).fact(turn.sessionId,{mode:'following'})).value);
}

export async function teachingTurnAllowed(tx: ReadTransaction, turn: ReturnType<typeof studyTurn>,
  grantCurrent: (turn: ReturnType<typeof studyTurn>) => Promise<boolean>, origin?: ReturnType<typeof studyTurn>) {
  if (!await grantCurrent(turn)) return false;
  origin ??= await teachingOrigin(tx,turn);
  return (origin === turn || await grantCurrent(origin)) && await attachmentCurrent(tx,origin);
}

export function relatedIntakeId(materialId: FactId) {
  return factId(stableId('intake-document', materialId));
}

export async function materialIntakeLink(tx: ReadTransaction, materialId: FactId) {
  const id = relatedIntakeId(materialId);
  const {rows: [row]} = await tx.query<{
    type: string;
    purpose: string[];
    retracted: boolean;
    materialId: string | null;
  }>(
    `SELECT f.type, f.purpose, f.retracted_rev IS NOT NULL AS retracted,
            r.data->>'materialId' AS "materialId"
     FROM facts f
     LEFT JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.id=$2`,
    [tx.learner, id],
  );
  if (!row) return;
  const matches = row.type === intakeFactType && !row.retracted && row.materialId === materialId;
  return {id, purpose: row.purpose, matches};
}

export function relatedMaterialId(document: FactSnapshot) {
  return intakeDocument(document.value).materialId;
}

export function isMaterialIntakePair(materialId: FactId, document: FactSnapshot) {
  return document.ref.id === relatedIntakeId(materialId) && document.type === intakeFactType
    && relatedMaterialId(document) === materialId;
}

export function materialIntakeReference(material: FactSnapshot, document: FactSnapshot, anchor: SourceAnchorV1) {
  return {...sourceReference(material, anchor), textFact: sourceReference(document, {kind:'whole'}).fact};
}
