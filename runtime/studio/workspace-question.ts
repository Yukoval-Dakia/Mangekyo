import { toolFailure } from '../../executors/teaching/learning-tools.ts';
import { commandId, factId, isFactUnavailable, type Db, type FactId, type ReadTransaction, type Tick } from '../../kernel/src/index.ts';
import { parseSaveQuestion, QuestionAuthoringError } from '../../modules/content/question-authoring.ts';
import { saveQuestionCommand } from '../../modules/content/question-writes.ts';
import { buildDraftQuestionAsset } from '../../modules/content/workspace-slice.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { purpose, stableId, studioHost, studioLearner, studioModule } from './identity.ts';
import { confirmNotionRead, createNotionReader } from './notion.ts';
import type { WorkspaceSourceRecipient } from './source-read.ts';

export type DraftWitness = { id: FactId; rev: number; epoch: Tick };

export function openWorkspaceQuestion(db: Db, turn: string, maySend: WorkspaceSourceRecipient,
  authorize: (tx: ReadTransaction) => Promise<void>, witnesses: () => DraftWitness[]) {
  const host = studioHost(db, { actor: 'companion' }), schema = { tool: 'find_tools', args: { query: 'save_question' } };
  return async (args: Record<string, unknown>, step: number) => {
    try {
      const parsed = parseSaveQuestion(args);
      if (parsed.kind !== 'create' || parsed.append_metadata) return toolFailure('invalid_args', '目前可保存新增题面草稿。题版修改或解法核验请使用题库。', schema);
      if (parsed.question.interaction || parsed.question.sources || parsed.question.shared_materials)
        return toolFailure('evidence_not_opened', '带引用或交互的题目须在题库核验。', schema);
      const id = factId(stableId('learning-question', turn, String(step))), pins = [...new Map(witnesses().map(w => [`${w.id}:${w.rev}`, w])).values()];
      const basis = await confirmNotionRead(db, studioLearner, async (tx, check) => {
        await authorize(tx);
        const read = createNotionReader(tx, { purpose, recipient: maySend, check });
        return Promise.all(pins.map(async w => {
          const fact = await read.reopen({ id: w.id, rev: w.rev, accessEpoch: w.epoch, mode: 'pinned' });
          return { ...w, type: fact.type };
        }));
      });
      const handle = host.boundHandler([await studioModule('content')], createStudioCommandHooks({ afterFactsChanged: authorize }));
      await host.snapshot(authorize);
      const receipt = await handle({ purpose, id: commandId(stableId('learning-question-command', turn, String(step))), type: saveQuestionCommand, input: { id, asset: buildDraftQuestionAsset(parsed, basis) } });
      return { ok: true as const, data: { status: 'draft', ref: id, rev: receipt.wrote[0]!.rev, commandId: receipt.commandId } };
    } catch (error) {
      if (isFactUnavailable(error)) return toolFailure('access_revoked', '题目草稿的依据已不可用。', schema);
      if (error instanceof QuestionAuthoringError) return toolFailure(error.code, error.message, schema, error.field);
      if (error instanceof Error && /题目|评估|作答|题干|JSON/.test(error.message)) return toolFailure('invalid_args', '题面或评估契约无效。', schema);
      throw error;
    }
  };
}
