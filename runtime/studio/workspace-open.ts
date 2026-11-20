import {imageCropEdgeLimit, openLearningLimit, type ImageCrop} from '../../executors/teaching/workspace-tools.ts';
import {createCommandReadContext, FactNotFoundError, FactReadDeniedError} from '../../kernel/src/commands/reads.ts';
import type {ReadTransaction} from '../../kernel/src/db/types.ts';
import {factId} from '../../kernel/src/declarations/ids.ts';
import type {FactSnapshot} from '../../kernel/src/declarations/types.ts';
import {isSourceFactId, sourceRefV1, type SourceRefV1} from '../../modules/activity/source-values.ts';
import {workbookAttempt, workbookAttemptType, workbookPaperType} from '../../modules/activity/workbook-values.ts';
import {practiceSubmission, ridingPracticeType} from '../../modules/activity/practice-values.ts';
import {purpose} from './identity.ts';
import {sourceQuestions, type SourceTrack, type WorkspaceSourceRecipient} from './source-read.ts';
import {readWorkbookDiagnosis} from './workbook-diagnosis.ts';
import type {WorkspaceAssessmentBasis} from './workspace-read.ts';

type ToolErrorCode = 'not_found' | 'access_revoked' | 'basis_stale' | 'invalid_args' | 'partial_success' | 'evidence_not_opened' | 'image_unavailable';

export function learningToolError(code: ToolErrorCode, field: string, message: string, next?: {
  tool: 'open_learning' | 'search_workspace' | 'record_observation'; args: Record<string, unknown>; why: string;
}) {
  return {ok:false as const, code, field, message, ...(next && {next})};
}

const searchNext = {tool:'search_workspace' as const, args:{}, why:'从当前可读结果选择引用。'};
type Part = {kind:'whole' | 'assessment'} | {kind:'question'; index:number};
type OpenLearningArgs = {refs: string[]; part: Part; lens: 'raw' | 'diagnose'};
type OpenImageArgs = {refs: [string]; part: {kind:'image_crop'; crop?: ImageCrop}; lens: 'raw'};

function imageCrop(value: unknown): ImageCrop | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) return;
  const {left, top, width, height} = value as Record<string, unknown>;
  if (typeof left !== 'number' || typeof top !== 'number' || !Number.isSafeInteger(left) || !Number.isSafeInteger(top) || left < 0 || top < 0 ||
      typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > imageCropEdgeLimit || height > imageCropEdgeLimit) return;
  return {left,top,width,height};
}

export function parseOpenLearningArgs(args: Record<string, unknown>) {
  const refs = typeof args.refs === 'string' ? [args.refs] : args.refs;
  if (!Array.isArray(refs) || !refs.length || refs.length > openLearningLimit ||
      !refs.every(ref => typeof ref === 'string' && ref.trim() && ref.length <= 4096)) {
    return learningToolError('invalid_args','refs',`refs 须为 1–${openLearningLimit} 个可打开的引用。`,searchNext);
  }
  const lens = args.lens === undefined ? 'raw' : args.lens;
  if (lens !== 'raw' && lens !== 'diagnose') {
    return learningToolError('invalid_args','lens','lens 须为 raw 或 diagnose。',{
      tool:'open_learning',args:{refs},why:'打开原记录。',
    });
  }
  if (lens === 'diagnose' && args.part !== undefined) {
    return learningToolError('invalid_args','part','diagnose 读取整份已交卷作答。',{
      tool:'open_learning',args:{refs,lens},why:'一次打开题面与作答依据。',
    });
  }
  if (args.part === 'image_crop') {
    if (refs.length !== 1) return learningToolError('invalid_args','refs','原图裁剪每次只接受一个交入材料引用。');
    const crop = imageCrop(args.crop);
    if (args.crop !== undefined && !crop) return learningToolError('invalid_args','crop',
      `crop 须包含非负整数 left、top 和 1–${imageCropEdgeLimit} 的整数 width、height。`);
    return {refs:[refs[0].trim()],part:{kind:'image_crop',...(crop ? {crop} : {})},lens:'raw'} satisfies OpenImageArgs;
  }
  if (args.crop !== undefined) return learningToolError('invalid_args','crop','crop 仅可用于 part: image_crop。');
  let part: Part;
  if (args.part === undefined) part = {kind:'whole'};
  else if (args.part === 'assessment') part = {kind:'assessment'};
  else {
    const match = typeof args.part === 'string' && /^question:([1-9]\d?)$/.exec(args.part);
    if (!match) return learningToolError('invalid_args','part','part 须为 question:<题号>、assessment 或 image_crop。',{
      tool:'open_learning',args:{refs},why:'先打开可用范围，再选择题号。',
    });
    part = {kind:'question',index:Number(match[1])};
  }
  return {refs:refs.map(ref => ref.trim()),part,lens} satisfies OpenLearningArgs;
}

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
  if (!known) return learningToolError('not_found','refs','未能定位可打开的学习对象。',searchNext);
  try {
    const current = await createCommandReadContext(tx,purpose).fact(factId(id),{mode:'following'});
    if (maySend(current)) return learningToolError('basis_stale','refs','所选版本或其依据当前不可用。',{
      tool:'open_learning',args:{refs:id},why:'打开当前获准版本。',
    });
  } catch (error) {
    if (!(error instanceof FactNotFoundError || error instanceof FactReadDeniedError)) throw error;
  }
  return learningToolError('access_revoked','refs','此前读到的记录当前不可读。',searchNext);
}

function projectOpenLearning(value: ReadResult, fact: FactSnapshot, part: Part): ReadResult | ReturnType<typeof learningToolError> {
  const {sourceRef, question, nextOffset, ...body} = value;
  if (!sourceRef) return value;
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
    const questions = sourceQuestions(fact);
    const originalAnswers = fact.type === workbookAttemptType ? workbookAttempt(fact.value).answers : undefined;
    const practiceFeedback = fact.type === ridingPracticeType ? practiceSubmission(fact.value).feedback : undefined;
    const content = questions.map((item,index) => {
      const prompt = questions.length > 1 ? `${index + 1}. ${item.prompt}` : item.prompt;
      if (!originalAnswers && !practiceFeedback) return prompt;
      return prompt + '\n我的作答：' + String(originalAnswers?.[item.id] ?? practiceFeedback?.[index]?.answer ?? '未作答');
    }).join('\n\n');
    return {...body, sourceRef, content};
  }
  return {...body, sourceRef, ...(nextOffset !== undefined ? {nextOffset} : {})};
}

export function parseLearningReference(input: string) {
  if (isSourceFactId(input)) return input;
  try { return sourceRefV1(JSON.parse(input)); }
  catch { return undefined; }
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
      items.push(learningToolError('not_found','refs','本轮没有绑定这个当前学习对象。',searchNext));
      continue;
    }
    const ref = current ?? parseLearningReference(input);
    if (!ref) {
      items.push(learningToolError('invalid_args','refs','请使用 id 或 sourceRef。',searchNext));
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
