import { toolFailure } from '../../executors/teaching/learning-tools.ts';
import { validateInteractiveArtifactV1 } from '../../executors/teaching/interactive-artifact.ts';
import { isUneditedCompanionDraft } from '../../kernel/src/commands/writes.ts';
import { commandId, createAuthorizedFactReader, factId, isFactNotFound, isFactReadDenied, isFactUnavailable,
  type Db, type FactId, type ReadTransaction, type Revision, type Tick } from '../../kernel/src/index.ts';
import { assetType } from '../../modules/content/asset.ts';
import { parseSaveQuestion, QuestionAuthoringError } from '../../modules/content/question-authoring.ts';
import { questionMetaDraftId, questionStateId } from '../../modules/content/question-state.ts';
import { buildWorkspaceQuestionCommands } from '../../modules/content/workspace-slice.ts';
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
      const id = parsed.kind === 'create' ? factId(stableId('learning-question', turn, String(step)))
        : (() => { try { return factId(parsed.ref); } catch { try {
          const wire = JSON.parse(parsed.ref) as { fact?: { id?: unknown } };
          if (typeof wire.fact?.id !== 'string') throw new Error(); return factId(wire.fact.id);
        } catch { throw new QuestionAuthoringError('invalid_args', 'ref', '题目标识无效。'); } } })();
      const interaction = parsed.kind === 'create' ? parsed.question.interaction : parsed.patch.interaction;
      if (interaction !== undefined && !validateInteractiveArtifactV1(interaction).ok)
        throw new QuestionAuthoringError('invalid_args', 'interaction', '交互题面无效。');
      const pins = [...new Map(witnesses().map(w => [`${w.id}:${w.rev}`, w])).values()];
      const opened = await confirmNotionRead(db, studioLearner, async (tx, check) => {
        await authorize(tx);
        const read = createNotionReader(tx, { purpose, recipient: maySend, check });
        const reopened = await Promise.all(pins.filter(w => parsed.kind === 'create' || w.id !== id).map(async w => {
          const fact = await read.reopen({ id: w.id, rev: w.rev, accessEpoch: w.epoch, mode: 'pinned' });
          return { ...w, type: fact.type };
        }));
        if (parsed.kind === 'create') return { pins: reopened };
        const targetPin = pins.find(w => w.id === id && w.rev === parsed.expected_rev) ?? pins.filter(w => w.id === id).at(-1);
        if (!targetPin) return { pins: reopened, notOpened: true as const };
        let commandPurpose = purpose;
        const targetFact = await read.reopen({ id: targetPin.id, rev: targetPin.rev, accessEpoch: targetPin.epoch, mode: 'pinned' })
          .catch(async error => {
            if (!isFactReadDenied(error) || error.reason !== 'purpose') throw error;
            // 仅本轮已打开、通过 maySend 且未经学习者编辑的 storage-only 伴学草稿降级为存储读写。
            const stored = await createAuthorizedFactReader(tx, 'storage', maySend)
              .fact(targetPin.id, { mode: 'pinned', rev: targetPin.rev as Revision });
            const storageOnly = !stored.purpose.includes(purpose) && !stored.purpose.includes('all');
            if (!storageOnly || stored.type !== assetType || stored.accessEpoch !== targetPin.epoch
                || !await isUneditedCompanionDraft(tx, targetPin.id)) throw error;
            commandPurpose = 'storage';
            return stored;
          });
        if (targetFact.type !== assetType || targetFact.ref.rev !== parsed.expected_rev) return { pins: reopened, versionConflict: true as const };
        let expectedMetaRev: number | undefined;
        if (!Object.keys(parsed.patch).length) {
          const metaSnap = await createAuthorizedFactReader(tx, commandPurpose, maySend)
            .fact(await questionMetaDraftId({ learner: studioLearner, id, rev: parsed.expected_rev }), { mode: 'following' })
            .catch(error => { if (isFactNotFound(error)) return undefined; throw error; });
          expectedMetaRev = metaSnap?.ref.rev;
        }
        const epoch = targetFact.accessEpoch, meta = expectedMetaRev === undefined ? {} : { expectedMetaRev };
        return { pins: reopened, commandPurpose, target: { epoch, ...meta } };
      });
      if ('notOpened' in opened) return toolFailure('evidence_not_opened', '请先打开本轮要修订的题目。', schema);
      if ('versionConflict' in opened) return toolFailure('version_conflict', '题目版本已变更，请重新打开。', schema, 'expected_rev');
      const basis = opened.pins.filter(w => w.id !== id);
      const commandPurpose = 'commandPurpose' in opened ? opened.commandPurpose! : purpose;
      const draftIds = commandPurpose === 'storage' && parsed.kind === 'revise' ? new Set<FactId>([
        id, await questionStateId(id),
        await questionMetaDraftId({ learner: studioLearner, id, rev: parsed.expected_rev }),
        await questionMetaDraftId({ learner: studioLearner, id, rev: (parsed.expected_rev + 1) as Revision }),
      ]) : null;
      const handle = host.boundHandler([await studioModule('content')], createStudioCommandHooks({ afterFactsChanged: authorize }), undefined, {
        bindCommandRead: (tx, _req, base) => {
          const teachingReader = createNotionReader(tx, { purpose, recipient: maySend });
          const draftReader = draftIds ? createAuthorizedFactReader(tx, 'storage', maySend) : teachingReader;
          const fact: typeof base.fact = (f, opts) => (draftIds?.has(f) ? draftReader : teachingReader).fact(f, opts) as never;
          return { ...base, fact };
        },
      });
      await host.snapshot(authorize);
      const commands = buildWorkspaceQuestionCommands(parsed, { id, learner: studioLearner, basis,
        ...(opened.target?.epoch === undefined ? {} : { questionEpoch: opened.target.epoch }),
        ...(opened.target?.expectedMetaRev === undefined ? {} : { expectedMetaRev: opened.target.expectedMetaRev as Revision }) });
      let rev = parsed.kind === 'revise' ? parsed.expected_rev : 1, metaProposalId: string | undefined, executedKey: string | undefined;
      for (const command of commands.commands) {
        const receipt = await handle({ actor: 'companion', purpose: commandPurpose,
          id: commandId(stableId('learning-question-command', turn, String(step), command.key)),
          type: command.type, input: command.input });
        rev = receipt.wrote.find(w => w.id === id)?.rev ?? rev;
        if (command.type === 'content.proposeQuestionMeta' && receipt.state === 'proposed') metaProposalId = receipt.commandId;
        if (command.key === 'question' || executedKey === undefined) executedKey = command.key;
      }
      return { ok: true as const, data: { status: 'draft', ref: id, rev,
        commandId: commandId(stableId('learning-question-command', turn, String(step), executedKey ?? 'question')),
        ...(metaProposalId ? { metaProposalId } : {}) } };
    } catch (error) {
      if (isFactUnavailable(error)) return toolFailure('access_revoked', '题目草稿的依据已不可用。', schema);
      if (error instanceof QuestionAuthoringError) return toolFailure(error.code, error.message, schema, error.field);
      if (error instanceof Error && (error.message.startsWith('Fact revision conflict') ||
        error.message === 'Only an unedited companion draft can be revised'))
        return toolFailure('version_conflict', '题目版本已变更，请重新打开。', schema, 'expected_rev');
      if (error instanceof Error && error.message.startsWith('教材依据已变更'))
        return toolFailure('basis_stale', '题目草稿的依据已变更。', schema);
      if (error instanceof Error && /题目|评估|作答|题干|JSON/.test(error.message)) return toolFailure('invalid_args', '题面或评估契约无效。', schema);
      throw error;
    }
  };
}
