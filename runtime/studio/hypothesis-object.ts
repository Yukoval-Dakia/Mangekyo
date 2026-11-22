import { readable } from '../../kernel/src/commands/fact-collection.ts';
import { purposeReader, teachingRead } from './fact-read-helpers.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import { originalHypothesisObject } from '../../modules/companion/belief.ts';
import { claimRef } from '../../modules/companion/claim.ts';
import type { ExtractedUnderstanding } from '../../modules/companion/understanding.ts';
import { readCurrentLearningObject } from './current-learning-object.ts';
import { checkStudioNotionFact, type CheckNotionRead } from './notion.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

export async function openHypothesisObject(tx: ReadTransaction, data: ExtractedUnderstanding,
  maySend: WorkspaceSourceRecipient, checkSelf?: CheckNotionRead) {
  if (data.scope.kind !== 'object') return [];
  const reader = purposeReader(tx, maySend);
  return readable(async () => {
    let basis = data.belief?.objectBasis;
    if (!basis) {
      const original = await originalHypothesisObject(teachingRead(tx), data);
      if (!original) return;
      const opened = await readCurrentLearningObject(tx, original, maySend, checkSelf && true);
      if (opened?.basisDigest !== original.basisDigest) return;
      basis = opened.basis;
    }
    for (const w of basis) {
      const ref = claimRef({id:w.id, rev:w.rev, accessEpoch:w.epoch});
      const fact = await reader.reopen({...ref, mode:w.mode, type:w.type});
      if (checkSelf) {
        await checkStudioNotionFact(tx, fact, 'storage', 'learner');
        await checkSelf(fact);
      } else await checkStudioNotionFact(tx, fact, 'teaching', maySend);
    }
    return basis;
  });
}
