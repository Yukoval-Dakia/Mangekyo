import { createCommandReadContext, FactNotFoundError, FactReadDeniedError } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { materialType, storagePurpose, textMaterial } from '../../modules/activity/library-values.ts';
import { intakeDocument } from '../../modules/activity/intake-values.ts';
import { stableId } from './identity.ts';

export async function readMaterialText(tx: ReadTransaction, id: string) {
  const result = await tx.query('SELECT id FROM facts WHERE learner_id=$1 AND type=$2 AND id=$3 AND retracted_rev IS NULL', [tx.learner, materialType, id]);
  if (!result.rows.length) return null;
  const read = createCommandReadContext(tx, storagePurpose);
  try {
    const material = textMaterial((await read.fact(factId(id), {mode: 'following'})).value);
    try {
      const document = intakeDocument((await read.fact(factId(stableId('intake-document', id)), {mode: 'following'})).value);
      return { id, title: material.title, text: document.extraction.text };
    } catch (error) {
      if (!(error instanceof FactNotFoundError)) throw error;
      return { id, ...material };
    }
  } catch (error) {
    if (error instanceof FactReadDeniedError || error instanceof FactNotFoundError) return null;
    throw error;
  }
}
