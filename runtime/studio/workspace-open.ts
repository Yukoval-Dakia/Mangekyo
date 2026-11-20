import {openLearningSearchNext, type OpenLearningArgs} from '../../executors/teaching/workspace-tools.ts';
import {learningToolError} from '../../executors/teaching/tool-error.ts';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {parseLearningReference, type SourceRefV1} from '../../modules/activity/source-values.ts';
import {openedQuestionText} from '../../modules/activity/workspace-projection.ts';
import {workbookAttemptType, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {ridingPracticeType} from '../../modules/activity/practice-values.ts';
import {purpose} from './identity.ts';
import {sourceQuestions, textbookText, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {textbookPageFrom, textbookPageType} from '../../modules/content/textbook-page.ts';
import {readWorkbookDiagnosis} from './workbook-diagnosis.ts';
import type {WorkspaceAssessmentBasis} from './workspace-read.ts';

type ReadResult = {
  ok?: true;
  id?: string;
  sourceRef?: SourceRefV1;
  content?: unknown;
  question?: {prompt:string};
  assessments?: unknown[];
  nextOffset?: number;
  error?: unknown;
} & Record<string, unknown>;

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

function projectOpenLearning(value: ReadResult, fact: FactSnapshot, part: OpenLearningArgs["part"]): ReadResult | ReturnType<typeof learningToolError> {
  const {sourceRef, question, nextOffset, ...body} = value;
  if (!sourceRef) return value;
  if (part.kind === 'block') {
    const block = fact.type === textbookPageType && sourceRef.anchor.kind === 'whole'
      ? textbookPageFrom(fact).blocks.find(block => block.id === part.blockId) : undefined;
    if (!block) return learningToolError('not_found','part','未找到所选教材块。',{
      tool:'open_learning',args:{refs:JSON.stringify(sourceRef)},why:'先核对当前版本的教材块标识。',
    });
    return {id:sourceRef.fact.id,rev:sourceRef.fact.rev,kind:'page',title:value.title,content:textbookText(block.body),
      part,sourceRef:{...sourceRef,anchor:part}};
  }
  if (part.kind === 'question') {
    const item = sourceRef.anchor.kind === 'whole' ? sourceQuestions(fact)[part.index - 1] : undefined;
    if (!item) return learningToolError('not_found','part','没有找到所选题项。',{
      tool:'open_learning',args:{refs:JSON.stringify(sourceRef)},why:'先读原记录以确认题项。',
    });
    const {assessments: _assessments, ...record} = body;
    return {...record, content:item.prompt, part, sourceRef:{...sourceRef,anchor:{kind:'question',itemId:item.id}}};
  }
  if (part.kind === 'assessment') {
    return {id:sourceRef.fact.id, rev:sourceRef.fact.rev, title:value.title, sourceRef, part, assessments:value.assessments ?? []};
  }
  if (sourceRef.anchor.kind === 'whole' && (question || fact.type === workbookPaperType ||
      fact.type === workbookAttemptType || fact.type === ridingPracticeType)) {
    return {...body, sourceRef, content:openedQuestionText(fact)};
  }
  return {...body, sourceRef, ...(nextOffset !== undefined ? {nextOffset} : {})};
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
    const value = JSON.parse(await read(current ? JSON.stringify(current) : input,track)) as ReadResult;
    if (value.error || !value.sourceRef) {
      items.push(await unreadable(tx,id,access.known(id),access.maySend));
      continue;
    }
    const root = witnesses.find(([fact]) => fact.ref.id === id && fact.ref.rev === value.sourceRef?.fact.rev)?.[0];
    const result = root ? projectOpenLearning(value,root,args.part) : value;
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
