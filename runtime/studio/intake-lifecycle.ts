import { lstat, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDeletionWatermark, assertUnburned, deletionState, eraseOriginal, LifecycleError } from '../../kernel/src/lifecycle.ts';
import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { captureIntakeCommand, correctIntakeCommand, completeCloudIntakeCommand, setIntakeResearchCommand, intakeDocument, intakeFactType, intakePurpose, materialType } from '../../modules/capture/intake-values.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export function intakeIdFor(materialId: FactId) { return factId(stableId('intake-document', materialId)); }

export function openIntakeLifecycle(db: Db, base: (id: string) => string) {
  const scope = {learner:studioLearner};
  const storeId = async () => {
    const {rows:[row]} = await db.query<{store_id:string}>('SELECT store_id FROM kernel_runtime_identity WHERE singleton');
    if (!row) throw new Error('Missing storage identity');
    return row.store_id;
  };
  async function erase(id: string, input: Record<string, unknown>) {
    const root = factId(id);
    if (input.confirmation !== 'permanently-delete-original')
      throw new RequestError(403, '请明确确认永久删除原件和历次抽取。');
    const rev = input.expectedRev;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) throw new RequestError(400, '材料版本无效。');
    const requestId = commandId(stableId('erase-intake', clientRequest(input.requestId)));
    return eraseOriginal(db, scope, {actor:'learner', confirmed:true, requestId, root, expectedRev:rev}, async tx => {
      const documentId = intakeIdFor(root);
      const read = createCommandReadContext(tx, intakePurpose);
      const material = await read.fact(root, {mode:'following'});
      const document = await read.fact(documentId, {mode:'following'});
      if (material.type !== materialType || document.type !== intakeFactType || intakeDocument(document.value).materialId !== root)
        throw new RequestError(404, '找不到这份交入原件。');
      if (document.ref.rev !== rev) throw new LifecycleError(409, '材料已有新版本。请重新查看后确认。');
      return {ids:[root, documentId], commandTypes:[captureIntakeCommand,correctIntakeCommand,completeCloudIntakeCommand,setIntakeResearchCommand]};
    }, async () => {
      const location = base(root);
      // Only unlink files owned by this database. Legacy objects without an ownership marker remain pending.
      if (!(await lstat(location)).isDirectory()) throw new Error('Unverified original directory');
      const owner = await readFile(join(location,'store-id'), 'utf8');
      if (owner !== (await storeId()) + ':' + root) throw new Error('Original belongs to an unverified store');
      await rm(join(location,'original'), {force:true});
      await rm(join(location,'meta.json'), {force:true});
      const directory = await open(location,'r');
      try { await directory.sync(); } finally { await directory.close(); }
      // The directory and opaque store identity support retry after an ambiguous commit.
    });
  }
  return {storeId, erase, state: () => db.snapshot(scope,deletionState),
    checkCapture: async (tx: ReadTransaction, id: FactId, watermark: string) => {
      await assertUnburned(tx, 'fact', [id]);
      await assertDeletionWatermark(tx,watermark);
    }};
}
