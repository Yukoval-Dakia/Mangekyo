import {commandId, createCommandReadContext, isFactNotFound, isFactReadDenied, listCompletedEffects, type CommandHooks, type Db, type DbTransaction, type FactId, type ReadTransaction} from '../../kernel/src/index.ts';
import { assertDeletionWatermark } from '../../kernel/src/lifecycle.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { recordLocalRead } from '../../kernel/src/work/effects.ts';
import { bankProposalView, inspectTeachingBankQuestion, parsePaper, parseProposal, questionSourceMaterialIds, recordedReferences, selectBankQuestions, storedIqdbQuestionView, type QuestionRef } from '../../modules/activity/iqdb-selection.ts';
import { setWorkspaceTeachingCommand } from '../../modules/activity/workspace-values.ts';
import { intakeFactType } from '../../modules/capture/intake-values.ts';
import { assetType } from '../../modules/content/asset.ts';
import { materialType } from '../../modules/content/intake-question-bank.ts';
import { classifySetQuestionTeachingError, parseSetQuestionTeachingInput, questionMetaDraftId } from '../../modules/content/question-state.ts';
import { parseRequest, purpose, stableId, storageRead, studioHost } from './identity.ts';
import { intakeIdFor } from './intake-lifecycle.ts';
import { enqueueQuestionVerification, readCurrentQuestionVerification } from './iqdb-verification.ts';
import { RequestError } from './sessions.ts';

export type IssueBank = (tx: DbTransaction, input: { requestId: string; questionRefs: readonly QuestionRef[]; deletionWatermark: string }) => Promise<{ id: FactId }>;
const proposalLabel = 'iqdb-proposal';
const validated = <Result>(parse: () => Result) => parseRequest(parse, '题库请求无效。');
const inspectQuestion = (tx: ReadTransaction, id: FactId, pinned?: QuestionRef['rev']) =>
  inspectTeachingBankQuestion({ ...createCommandReadContext(tx, purpose), slot: readCurrentQuestionVerification(tx) }, storageRead(tx), id, pinned);

async function listQuestions(tx: ReadTransaction, { teachingOnly = false }: { teachingOnly?: boolean } = {}) {
  const { rows } = await tx.query<{ id: FactId; purpose: readonly string[] }>(
    `SELECT f.id, f.purpose FROM facts f JOIN fact_revs r ON (r.learner_id,r.fact_id,r.rev)=(f.learner_id,f.id,f.current_rev)
     WHERE f.learner_id=$1 AND f.type=$2 AND f.retracted_rev IS NULL AND r.data->>'kind'='question'
       AND f.purpose && ARRAY['storage',$3,'all']::text[] ORDER BY f.id`, [tx.learner, assetType, purpose]);
  const questions = [];
  for (const { id, purpose: purposes } of rows) {
    const strict = (purposes.includes('teaching') || purposes.includes('all')) ? await inspectQuestion(tx, id) : undefined;
    const opened = strict ? { view: strict, teachingAuthorized: true } : await storedIqdbQuestionView(tx, { id, purposes, teachingOnly, teachingPurpose: purpose });
    if (opened) questions.push({ ...opened.view.public, teachingAuthorized: opened.teachingAuthorized });
  }
  return questions;
}

export function openIqdb(db: Db, verificationConfigured: boolean, issueBank: IssueBank,
  content?: LoadedModule, hooks?: CommandHooks, activity?: LoadedModule, capture?: LoadedModule) {
  const host = studioHost(db), modules = [content, activity, capture].filter((m): m is LoadedModule => Boolean(m));
  const exec = modules.length && hooks ? host.boundHandler(modules, hooks, undefined,
    activity ? { crossModuleWrites: { [setWorkspaceTeachingCommand]: { set_purpose: [materialType, intakeFactType] } } } : undefined) : undefined;
  return {
    questions: () => host.snapshot(async tx => ({ questions: await listQuestions(tx) })),
    async proposals({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parseProposal(raw)), proposalId = stableId(proposalLabel, input.requestId);
      const saved = await recordLocalRead(db, { ...host.scope, ownerKind: 'session', ownerId: proposalId, stepKey: 'plan', label: proposalLabel, input },
        async tx => JSON.stringify({ ...input, questionRefs: input.questionRefs.length
          ? input.questionRefs : selectBankQuestions(input, await listQuestions(tx, { teachingOnly: true })) }),
        tx => assertDeletionWatermark(tx, watermark))
        .catch(e => Promise.reject(e instanceof Error && e.message === 'Workspace read receipt does not match the request'
          ? new RequestError(409, '这个请求标识已经用于另一份提案。') : e));
      return host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        const requested = recordedReferences(saved), selected: NonNullable<Awaited<ReturnType<typeof inspectQuestion>>>[] = [];
        for (const ref of requested) {
          const opened = await inspectQuestion(tx, ref.id, ref.rev);
          if (!opened) continue;
          if (verificationConfigured && opened.public.status === 'needs_verification' && !opened.reviewed) await enqueueQuestionVerification(tx, opened.version);
          selected.push(opened);
        }
        return bankProposalView(input, proposalId, requested, selected);
      });
    },
    async papers({ deletionWatermark: _, ...raw }: Record<string, unknown>, watermark: string) {
      const input = validated(() => parsePaper(raw));
      return host.lockedTx(async tx => {
        await assertDeletionWatermark(tx, watermark);
        const refs = input.sourceRef ? [input.sourceRef]
          : await listCompletedEffects(tx, { ownerKind: 'session', ownerId: input.proposalId!, label: proposalLabel })
            .then(({ rows: [saved] }) => {
              if (!saved) throw new RequestError(404, '找不到这份题库提案。');
              return recordedReferences(saved.result as string);
            });
        if (!refs.length) throw new RequestError(409, '请重新选择当前获准且已独立验收的固定题版。');
        return issueBank(tx, { requestId: input.requestId, questionRefs: refs, deletionWatermark: watermark });
      });
    },
    async setTeaching(id: string, raw: Record<string, unknown>) {
      if (!exec) throw new RequestError(503, '当前服务不支持题库教学授权。');
      const { questionId, requestId, expectedRev, allowed, includeSourceMaterial } = validated(() => parseSetQuestionTeachingInput(id, raw));
      try {
        const sources = allowed && includeSourceMaterial ? await host.snapshot(async tx => {
          const read = host.read(tx, 'storage'), question = await read.fact(questionId, { mode: 'following' });
          if (question.type !== assetType || question.ref.rev !== expectedRev) throw new RequestError(409, '题目基版已变化，请刷新后再试。');
          const metadata = await read.fact(await questionMetaDraftId(question.ref), { mode: 'following' });
          return Promise.all([...questionSourceMaterialIds(question, metadata)].map(async materialId => {
            const material = await read.fact(materialId, { mode: 'following' });
            const intakeId = await host.readOrNull(tx, 'storage', intakeIdFor(materialId), { mode: 'following' }).then(f => f?.ref.id);
            return { id: materialId, rev: material.ref.rev, ...(intakeId && { intakeId }),
              teaching: material.purpose.includes('teaching') || material.purpose.includes('all') };
          }));
        }) : [];
        if (sources.some(s => !s.teaching) && (!activity || !capture)) throw new RequestError(409, '题目来源未授权教学用途，请先开放对应来源材料的教学权限。');
        for (const s of sources) if (!s.teaching) await exec({ purpose: 'storage', type: setWorkspaceTeachingCommand,
          id: commandId(stableId('iqdb-question-source-teaching', questionId, s.id, requestId)),
          input: { id: s.id, expectedRev: s.rev, enabled: true, ...(s.intakeId && { intakeId: s.intakeId }) } });
        const receipt = await exec({ purpose: 'storage', type: 'content.setQuestionTeaching',
          id: commandId(stableId('iqdb-question-teaching', questionId, requestId)), input: { id: questionId, expectedRev, allowed } });
        return { id: questionId, rev: receipt.wrote.find(w => w.id === questionId)?.rev ?? expectedRev,
          teachingAuthorized: allowed, changed: receipt.wrote.length > 0, sourceMaterialAuthorized: allowed };
      } catch (error) {
        const mapped = classifySetQuestionTeachingError(error, { notFound: isFactNotFound(error),
          deniedReason: isFactReadDenied(error) ? error.reason : undefined });
        if (mapped) throw new RequestError(mapped.status, mapped.message);
        throw error;
      }
    },
  };
}
