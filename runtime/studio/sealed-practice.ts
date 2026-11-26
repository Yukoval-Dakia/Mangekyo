import {
  commandId, factId, isFactUnavailable, mapKernelError, readAvailable as optionalRead,
  type CommandHooks, type CommandRequest, type Db, type FactId, type ReadTransaction,
} from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { assertUnburned } from '../../kernel/src/lifecycle.ts';
import { arithmeticQuestionId, openArithmeticPractice } from '../../modules/content/arithmetic-practice.ts';
import { assetType } from '../../modules/content/asset.ts';
import { saveQuestionCommand } from '../../modules/content/question-writes.ts';
import {arithmeticPracticePaperId, openSealedPractice, practiceCustodyId, readPracticeCustody, releasePracticeFeedbackCommand, sealedPracticePurpose} from '../../modules/activity/sealed-practice.ts';
import { saveWorkbookPaperCommand, workbookRequestId } from '../../modules/activity/workbook-values.ts';
import { purpose, stableId, storageRead, studioHost } from './identity.ts';
import { RequestError } from './sessions.ts';
import { parsePracticeAdmission, resolveStudioPracticeAdmission as resolvePracticeAdmission } from './generated-practice.ts';

const unavailable = () => new RequestError(404, '找不到当前可用的封闭练习。');
const readPracticeTeaching = (tx: ReadTransaction, paper: FactId) => optionalRead(async () => {
  const read = storageRead(tx), custody = await readPracticeCustody(read, await practiceCustodyId(paper));
  if (!custody || custody.value.paper.id !== paper) throw unavailable();
  const source = await read.fact(custody.value.question.id, { mode: 'following' });
  if (source.type !== assetType) throw unavailable();
  return { id: source.ref.id, rev: source.ref.rev, teaching: source.purpose.includes('teaching') || source.purpose.includes('all') };
}).then(found => found ?? (() => { throw unavailable(); })());

export const isPracticeWorkbook = async (tx: ReadTransaction, paper: FactId) =>
  (await readPracticeCustody(storageRead(tx), await practiceCustodyId(paper)))?.value.paper.id === paper;
export const sealedPracticePaper = (tx: ReadTransaction, id: FactId) => optionalRead(() => openSealedPractice(storageRead(tx), id));

export function openPracticeAdmission(db: Db, content: LoadedModule, activity: LoadedModule, hooks: CommandHooks) {
  const host = studioHost(db);
  return {
    async admit(input: Record<string, unknown>, deletionWatermark: string) {
      const { requestId: raw, allowTeaching, deletionWatermark: _, ...definition } = input;
      let requestId, requested;
      try { requestId = workbookRequestId(raw); requested = parsePracticeAdmission(definition); }
      catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '练习参数无效。'); }
      if (allowTeaching !== undefined && typeof allowTeaching !== 'boolean') throw new RequestError(400, '题面伴学用途无效。');
      return host.lockedTx(async tx => {
        const command = commandId(stableId(sealedPracticePurpose, 'source-command', requestId));
        await assertUnburned(tx, 'command', [command]);
        const practice = await resolvePracticeAdmission(tx, command, requested);
        const questionId = await arithmeticQuestionId(practice), id = await arithmeticPracticePaperId(questionId);
        await assertUnburned(tx, 'fact', [id, questionId, await practiceCustodyId(id)]);
        const read = storageRead(tx), prior = await readPracticeCustody(read, await practiceCustodyId(id));
        const boundHandle = host.boundHandler([activity, content], hooks, tx, {
          // Keep the existing identity for retries of a previously authorized admission.
          bindCommandRead: (_tx, request, base) => request.type === saveQuestionCommand ? read : base });
        await boundHandle({ purpose: allowTeaching ? purpose : 'storage', type: saveQuestionCommand, id: command, deletionWatermark,
          input: { id: questionId, arithmeticPractice: practice, ...(allowTeaching ? {} : { purpose: 'storage' }) } })
          .catch(error => { throw mapKernelError(error, { duplicate_command: () => new RequestError(409, '同一个请求标识已经用于不同练习。') }); });
        if (!prior) await boundHandle({ purpose: 'storage', type: saveWorkbookPaperCommand,
          id: commandId(stableId(sealedPracticePurpose, 'reserve-paper', id)), deletionWatermark,
          input: { id, questionId, savedAt: new Date().toISOString(), condition: sealedPracticePurpose } });
        if (!await openArithmeticPractice(read, questionId, undefined, 'storage')) throw unavailable();
        return { id, questionRef: { id: questionId, rev: prior?.value.question.rev ?? 1 }, path: '/papers/' + id };
      });
    },
    getTeaching: (id: string) => host.snapshot(tx => readPracticeTeaching(tx, factId(id))),
    async teaching(id: string, input: Record<string, unknown>) {
      if (typeof input.allowed !== 'boolean' || !Number.isSafeInteger(input.expectedRev) || Number(input.expectedRev) < 1)
        throw new RequestError(400, '教学用途设置无效。');
      const { allowed, expectedRev } = input;
      return host.lockedTx(async tx => {
        const current = await readPracticeTeaching(tx, factId(id));
        if (current.rev !== expectedRev) throw new RequestError(409, '题面权限已在别处更新。请刷新后再试。');
        if (current.teaching === allowed) return current;
        const questionId = current.id, result = await host.boundHandler([content], hooks, tx)({ purpose: 'storage',
          type: 'content.setQuestionTeaching',
          id: commandId(stableId(sealedPracticePurpose, 'teaching', questionId, String(expectedRev), String(allowed))),
          input: { id: questionId, expectedRev: Number(expectedRev), allowed } });
        return { id: questionId, rev: result.wrote[0]?.rev ?? expectedRev, teaching: allowed };
      });
    },
  };
}

/** Older servers see no Workbook fact until the first official submission and its release commit. */
export function submitWithPracticeCustody(db: Db, activity: LoadedModule, hooks: CommandHooks, paperId: FactId, request: CommandRequest) {
  return studioHost(db).lockedTx(async tx => {
    const custody = await readPracticeCustody(storageRead(tx), await practiceCustodyId(paperId));
    const boundHandle = studioHost(db).boundHandler([activity], hooks, tx);
    if (custody?.value.kind === 'sealed') {
      if (!await sealedPracticePaper(tx, paperId)) throw unavailable();
      await boundHandle({ purpose: 'storage', type: releasePracticeFeedbackCommand,
        id: commandId(stableId(sealedPracticePurpose, 'release-feedback', paperId)),
        ...(request.deletionWatermark !== undefined && { deletionWatermark: request.deletionWatermark }),
        input: { custody: { id: custody.fact.ref.id, rev: custody.fact.ref.rev }, paper: { id: paperId, rev: 1 } } });
    }
    return boundHandle(request);
  });
}
