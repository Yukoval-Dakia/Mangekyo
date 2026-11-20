import {openLearningSearchNext, type OpenLearningArgs} from '../../executors/teaching/workspace-tools.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import {parseLearningReference, type SourceRefV1} from '../../modules/activity/source-values.ts';
import {projectOpenedLearning, type OpenedLearningRecord} from '../../modules/activity/workspace-source-projection.ts';
import {purpose} from './identity.ts';
import type {SourceTrack, WorkspaceSourceRecipient} from './source-read.ts';
import {readWorkbookDiagnosis} from './workbook-diagnosis.ts';
import type {WorkspaceAssessmentBasis} from './workspace-read.ts';

export async function unreadable(tx: ReadTransaction, id: string, known: boolean, maySend: WorkspaceSourceRecipient) {
  if (!known) return learningToolError('not_found','refs','未能定位可打开的学习对象。',openLearningSearchNext);
  try {
    const current = await createCommandReadContext(tx,purpose).fact(factId(id),{mode:'following'});
    if (maySend(current)) return learningToolError('basis_stale','refs','所选版本或其依据当前不可用。',{
      tool:'open_learning',args:{refs:id},why:'打开当前获准版本。',
    });
  } catch (error) {
    if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
  }
  return learningToolError('access_revoked','refs','此前读到的记录当前不可读。',openLearningSearchNext);
}

export async function openLearningBatch(tx: ReadTransaction, args: OpenLearningArgs, access: {
  known: (id: string) => boolean;
  maySend: WorkspaceSourceRecipient;
  track: SourceTrack;
  currentObject?: {alias: string; sourceRef: SourceRefV1} | undefined;
  trackAssessment?: ((basis: WorkspaceAssessmentBasis) => void) | undefined;
}, read: (id: string, track: SourceTrack) => Promise<string>) {
  const items = [];
  for (const input of args.refs) {
    const alias = input === 'current_attempt' || input === 'current_page';
    const current = access.currentObject?.alias === input ? access.currentObject.sourceRef : undefined;
    if (alias && !current) {
      items.push(learningToolError('not_found','refs','本轮没有绑定这个当前学习对象。',openLearningSearchNext));
      continue;
    }
    const ref = current ?? parseLearningReference(input);
    if (!ref) {
      items.push(learningToolError('invalid_args','refs','请使用 id 或 sourceRef。',openLearningSearchNext));
      continue;
    }
    const id = typeof ref === 'string' ? ref : ref.fact.id;
    const witnesses: Parameters<SourceTrack>[] = [];
    const track: SourceTrack = (...witness) => { witnesses.push(witness); };
    if (args.lens === 'diagnose') {
      const diagnosis = await readWorkbookDiagnosis(tx, ref, {
        maySend: access.maySend, track, ...(access.trackAssessment ? { trackAssessment: access.trackAssessment } : {}),
      });
      if (diagnosis) {
        for (const witness of witnesses) access.track(...witness);
        items.push({ok:true as const,...diagnosis});
      } else items.push(learningToolError(access.known(id) ? 'basis_stale' : 'not_found','refs',
        '没有可用于诊断的已交卷作答及获准题源。'));
      continue;
    }
    const value = JSON.parse(await read(current ? JSON.stringify(current) : input,track)) as OpenedLearningRecord;
    if (value.error || !value.sourceRef) {
      items.push(await unreadable(tx,id,access.known(id),access.maySend));
      continue;
    }
    const root = witnesses.find(([fact]) => fact.ref.id === id && fact.ref.rev === value.sourceRef?.fact.rev)?.[0];
    const result = root ? projectOpenedLearning(value,root,args.part) ?? learningToolError('not_found','part',
      args.part.kind === 'block' ? '未找到所选教材块。' : '没有找到所选题项。',{
        tool:'open_learning',args:{refs:JSON.stringify(value.sourceRef)},
        why:args.part.kind === 'block' ? '先核对当前版本的教材块标识。' : '先读原记录以确认题项。',
      }) : value;
    if (result.ok !== false) for (const witness of witnesses) access.track(...witness);
    items.push(result);
  }
  const failures = items.filter(item => item.ok === false);
  return {
    items,
    ...(failures.length ? learningToolError(failures.length < items.length ? 'partial_success' : failures[0]!.code,
      'refs','部分或全部引用未打开，详见逐项结果。') : {ok:true}),
  };
}
