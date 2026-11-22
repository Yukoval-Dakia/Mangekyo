import { assertDeletionWatermark, assertUnburned, deletionState, eraseOriginal, LifecycleError } from '../../kernel/src/lifecycle.ts';
import { createCommandReadContext } from '../../kernel/src/commands/reads.ts';
import type { Db, ReadTransaction } from '../../kernel/src/db/types.ts';
import { commandId, factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { appendIntakePagesCommand, captureIntakeCommand, correctIntakeCommand, completeCloudIntakeCommand, completeVisionIntakeCommand, retryVisionIntakeCommand, setIntakeResearchCommand, intakeDocument, intakeFactType, intakePurpose, materialType } from '../../modules/capture/intake-values.ts';
import { captureSourceCommand, captureSourceType, sourceEnvelope } from '../../modules/capture/source.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';
import { teachingErasure } from './teaching-erasure.ts';

export const intakeCaptureId = (requestId: string) => commandId(stableId('intake-capture',requestId));

export function intakeIdFor(materialId: FactId) { return factId(stableId('intake-document', materialId)); }

export function openIntakeLifecycle(db: Db, removeObject: (id: FactId) => Promise<void>) {
  const scope = {learner:studioLearner};
  async function erase(id: string, input: Record<string, unknown>) {
    const root = factId(id);
    if (input.confirmation !== 'permanently-delete-original')
      throw new RequestError(403, '请明确确认永久删除原件和历次抽取。');
    const rev = input.expectedRev;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) throw new RequestError(400, '材料版本无效。');
    const requestId = commandId(stableId('erase-intake', clientRequest(input.requestId)));
    return eraseOriginal(db, scope, {actor:'learner', confirmed:true, requestId, root, expectedRev:rev}, async tx => {
      const read = createCommandReadContext(tx, intakePurpose);
      const material = await read.fact(root, {mode:'following'});
      if (material.type === captureSourceType) {
        const source = sourceEnvelope(material.value);
        if ((source.kind !== 'paper-return' && !source.workbookAttachment) || source.originals.length !== 1 || source.originals[0]?.blobRef !== root)
          throw new RequestError(404, '找不到这份交入原件。');
        if (material.ref.rev !== rev) throw new LifecycleError(409, '原件已有新版本。请重新查看后确认。');
        return {ids:[root],commandTypes:[captureSourceCommand]};
      }
      const documentId = intakeIdFor(root);
      const document = await read.fact(documentId, {mode:'following'});
      if (material.type !== materialType || document.type !== intakeFactType || intakeDocument(document.value).materialId !== root)
        throw new RequestError(404, '找不到这份交入原件。');
      if (document.ref.rev !== rev) throw new LifecycleError(409, '材料已有新版本。请重新查看后确认。');
      return {ids:[root, documentId], commandTypes:[captureIntakeCommand,correctIntakeCommand,completeCloudIntakeCommand,completeVisionIntakeCommand,retryVisionIntakeCommand,appendIntakePagesCommand,setIntakeResearchCommand]};
    }, () => removeObject(root), teachingErasure);
  }
  return {erase, state: () => db.snapshot(scope,deletionState),
    checkCapture: async (tx: ReadTransaction, id: FactId, watermark: string) => {
      await assertUnburned(tx, 'fact', [id]);
      await assertDeletionWatermark(tx,watermark);
    }};
}
