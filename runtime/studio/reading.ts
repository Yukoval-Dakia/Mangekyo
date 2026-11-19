import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import type { FactSnapshot } from '../../kernel/src/declarations/types.ts';
import { materialType, storagePurpose, textMaterial } from '../../modules/activity/library-values.ts';
import { intakeDocument, intakeFactType } from '../../modules/activity/intake-values.ts';
import { isSourceFactId, sourceReference } from '../../modules/activity/source-values.ts';
import { stableId } from './identity.ts';

export async function readMaterialText(tx: ReadTransaction, id: string) {
  if (!isSourceFactId(id)) return null;
  const read = createCommandReadContext(tx, storagePurpose);
  try {
    const snapshot = await read.fact(factId(id), {mode: 'following'});
    if (snapshot.type !== materialType) return null;
    const material = textMaterial(snapshot.value);
    function view(fact: FactSnapshot, text: string) {
      return {id, title: material.title, text, sourceRef: sourceReference(fact, {kind: 'text', field: 'text', start: 0, end: text.length})};
    }
    try {
      const source = await read.fact(factId(stableId('intake-document', id)), {mode: 'following'});
      if (source.type !== intakeFactType) return null;
      const document = intakeDocument(source.value);
      return document.materialId === id ? view(source, document.extraction.text) : null;
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
      return view(snapshot, material.text);
    }
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return null;
    throw error;
  }
}
