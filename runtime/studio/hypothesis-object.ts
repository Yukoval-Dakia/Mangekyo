import { readable, type ReadTransaction } from '../../kernel/src/index.ts';
import { originalHypothesisObject } from '../../modules/companion/belief.ts';
import { claimRef } from '../../modules/companion/claim.ts';
import type { ExtractedUnderstanding } from '../../modules/companion/understanding.ts';
import { readCurrentLearningObject } from './current-learning-object.ts';
import { purposeReader, teachingRead } from './identity.ts';
import { verifyNotionFact, type CheckNotionRead } from './notion.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';
export async function openHypothesisObject(tx: ReadTransaction, data: ExtractedUnderstanding, maySend: WorkspaceSourceRecipient, checkSelf?: CheckNotionRead) {
  if (data.scope.kind !== 'object') return [];
  const reader = purposeReader(tx, maySend);
  return readable(async () => {
    let basis = data.belief?.objectBasis;
    if (!basis) {
      const original = await originalHypothesisObject(teachingRead(tx), data);
      const opened = original ? await readCurrentLearningObject(tx, original, maySend, checkSelf && true) : undefined;
      if (!opened || opened.basisDigest !== original!.basisDigest) return;
      basis = opened.basis;
    }
    for (const w of basis) {
      const fact = await reader.reopen({ ...claimRef({ id: w.id, rev: w.rev, accessEpoch: w.epoch }), mode: w.mode, type: w.type });
      await verifyNotionFact(tx, fact, checkSelf ? 'storage' : 'teaching', checkSelf, false, checkSelf ? 'learner' : maySend);
    }
    return basis;
  });
}
