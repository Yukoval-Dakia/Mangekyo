import { learningToolError } from './tool-error.ts';

// Product tools use the same call interface on both provider protocols.
const text = {type: 'string'} as const;
const strings = {type: 'array', items: text} as const;
const integer = {type: 'integer', minimum: 1} as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return {type: 'function', function: {name, description, parameters: {
    type: 'object', properties, required, additionalProperties: false,
  }}};
}
export const workspaceKinds = ['question', 'page', 'concept', 'relation', 'observation', 'annotation'] as const;
export const openLearningLimit = 8;
export const imageCropEdgeLimit = 512;
export type ImageCrop = {left: number; top: number; width: number; height: number};
export type StudyImage = {mediaType: 'image/png'; data: string};
export type ReceiveStudyImage = (image: StudyImage) => void;
export const openLearningSearchNext = {tool:'search_workspace' as const, args:{}, why:'从当前可读结果选择引用。'};
type Part = {kind:'whole' | 'assessment'} | {kind:'question'; index:number} | {kind:'block'; blockId:string};
export type OpenLearningArgs = {refs: string[]; part: Part; lens: 'raw' | 'diagnose'};
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
    return learningToolError('invalid_args','refs',`refs 须为 1–${openLearningLimit} 个可打开的引用。`,openLearningSearchNext);
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
    const question = typeof args.part === 'string' && /^question:([1-9]\d?)$/.exec(args.part);
    const block = typeof args.part === 'string' && /^block:([A-Za-z0-9_.-]{1,128})$/.exec(args.part);
    if (question) part = {kind:'question',index:Number(question[1])};
    else if (block && block[1]) part = {kind:'block',blockId:block[1]};
    else return learningToolError('invalid_args','part','part 须为 question:<题号>、block:<块标识>、assessment 或 image_crop。',{
      tool:'open_learning',args:{refs},why:'先打开可用范围，再选择题号。',
    });
  }
  return {refs:refs.map(ref => ref.trim()),part,lens} satisfies OpenLearningArgs;
}

const textbookBlockBody = {type:'object', required:['kind'], properties:{
  kind:{type:'string',enum:['text','list','table','formula','image','reference','related']}, text, latex:text, order:text,
  rows:{type:'array',items:strings}, source:{type:'object'}, alt:text, role:text, target:{anyOf:[text,{type:'object'}]}, allOf:{type:'array',items:{type:'object'}},
}, additionalProperties:false};
// This order and wire schema are part of the provider request digest for v1 turns.
export const workspaceDefinitions = [
  tool('read_learner_radar', '读取当前获准的冻结保持预测和对账、目标、未完成任务、先修查询入口及可用卷面。缺证时保留未知。', {
    scope: {type:'object', additionalProperties:false, properties:{subject_id:text, kc_ids:{...strings, maxItems:8}}},
    horizon_hours: {type:'integer', minimum:1, maximum:168, description:'只看观察窗口在未来指定小时内截止的保持记录。'},
  }),
  tool('open_learning', '打开 1–8 个已获准的学习对象。refs 可传 id、sourceRef JSON 字符串或这些引用的数组。已交卷作答用 lens: diagnose 读取题面、原答、评估和帮助曝光。part 支持 question:<题号>、block:<教材块标识>、assessment，或从单个交入材料读 PNG/JPEG 原图的 image_crop。省略 crop 时先查原图尺寸。', {
    refs: {anyOf: [text, {type: 'array', minItems: 1, maxItems: openLearningLimit, items: text}]},
    part: text,
    lens: {type:'string', enum:['raw','diagnose']},
    crop: {type:'object', additionalProperties:false, required:['left','top','width','height'],
      description:'仅用于 image_crop。以原件编码像素左上角为 (0,0)，按右下开区间选区，坐标不应用 EXIF 旋转。',
      properties:{left:{type:'integer', minimum:0}, top:{type:'integer', minimum:0},
        width:{...integer, maximum:imageCropEdgeLimit}, height:{...integer, maximum:imageCropEdgeLimit}}},
  }, ['refs']),
  tool('search_workspace', '找学习记录、题或笔记。用 conceptId 查有向知识边，用 sourceRef 重开版本。', {
    query: text, kind: {enum: ['attempt','paper','material','note','goal','task', ...workspaceKinds], type: 'string'},
    kinds: strings, tags: strings, since: text, related: text, cursor: text,
    conceptId: text, hops: {type: 'integer', minimum: 0, maximum: 2}, edgeKinds: strings,
    direction: {type:'string', enum:['inbound','outbound','both']},
    exposureFilter: {type:'string', enum:['exposed','unexposed','unknown']},
  }),
  tool('read_workspace', '按 id 读原文，learner 读学情概览。长文用 nextOffset 续读。', {
    id: text, offset: {type: 'integer', minimum: 0},
  }, ['id']),
  tool('record_observation', '从本轮已打开的原答记录一条可撤回的推断。evidence_refs 使用读回的引用或记录 id。', {
    title: text, text, evidence_refs: {...strings, minItems: 1, maxItems: openLearningLimit},
  }, ['title','text','evidence_refs']),
  tool('save_page', '新建教材传 title 与 content 或 blocks。修改先用 open_learning 打开教材页或指定块，再传 ref（页 id、sourceRef JSON 或 current_page）、expected_rev 与 patch。target 是块 id；insert_after 另传新 block_id；replace_anchor 传恰好出现一次的原文 anchor 与替换 content。links 使用本轮实际打开的来源 id。本人编辑过的页返回可选差异，尚未应用。', {
    title:text, content:text, tags:strings, links:{...strings,maxItems:openLearningLimit}, ref:text, expected_rev:integer,
    blocks:{type:'array',minItems:1,maxItems:64,items:{type:'object',required:['id','parentId','body'],additionalProperties:false,
      properties:{id:text,parentId:{type:['string','null']},body:textbookBlockBody}}},
    patch:{type:'array',minItems:1,maxItems:24,items:{type:'object',required:['op','target'],additionalProperties:false,properties:{
      op:{type:'string',enum:['replace_block','insert_after','replace_anchor','delete_block']},target:text,block_id:text,
      anchor:text,content:{anyOf:[text,textbookBlockBody]},
    }}},
  }),
  tool('save_relation', '保存知识图谱有向边，from 指向 to。先用 open_learning 打开两个端点（概念或题目）及补充来源的整份记录，传本轮打开的 id 或 sourceRef JSON。普通推断返回待本人采纳的 proposed。只有本轮打开且与此边一致的既存核验证明才可传入 verification 并直接保存。', {
    kind:{...text, description:'图谱边类型。例：prereq_of（先修到后继）、contrasts_with（易混对照）、targets_concept（题到考查概念）、variant_of（变式）。'},
    from:text, to:text, scope:{...text,maxLength:1000}, sources:{...strings,maxItems:openLearningLimit-2},
    verification:text,
    variant:{type:'object',required:['familyId','preserved','changed','spoilsNext'],additionalProperties:false,
      properties:{familyId:text,preserved:strings,changed:strings,spoilsNext:{type:'string',enum:['unknown','none','former','latter']}}},
  }, ['kind','from','to','scope']),
  // Retired six-in-one entry kept only for versioned agentVersion 1 replay. New turns use
  // narrowWorkspaceDefinitions (save_page / save_question / save_edge), never this name.
  tool('save_workspace', '兼容旧工作区条目。个人教材使用 save_page，有向图谱使用 save_relation。新建旧条目给 kind、title、body；修改给 id 和变动字段。出题时 body 只写题面，解答放 answer，评分放 rubric。links 填来源 id，旧关系条目按起点、终点排列。', {
    kind: {type: 'string', enum: workspaceKinds}, title: text, body: text, tags: strings, links: strings,
    answer: text, rubric: text, id: {type:'string', pattern:'^[0-9A-HJKMNP-TV-Z]{26}$', description:'仅更新时用已有 id；创建时省略。'}, rev: integer,
  }),
];
export const memoryToolDefinitions = [
  tool('retrieve_memory', '查找目前获准使用的旧记忆。根据学习者的自然语言判断目标，含糊时先问清。query 可省略，或传可能出现在旧条目中的一小段原文字词。', {query: text}),
  tool('save_memory', '保存学习者在本轮表达的持久偏好、明确状态，或本轮明确要求的更正、遗忘。每个独立事实调用一次。只使用本轮逐字原话片段作为证据，不能引用旧聊天、教材、工具结果或自己生成的内容。', {
    action: {type: 'string', enum: ['remember', 'update', 'forget']},
    text: {...text, description: '忠实表达这条独立偏好或状态，保留原话限定。遗忘时省略。'},
    quote_excerpt: {...text, description: '本轮学习者消息的连续逐字摘录。每项各取其证据。'},
    supersedes: {...text, description: '更正或遗忘时使用 retrieve_memory 给出的唯一目标引用。无需学习者提供标识。'},
    category: {type: 'string', enum: ['preference', 'claim', 'state'], description: '短期状态用 state。'},
    scope: {type: 'string', enum: ['general', 'current_object', 'unknown'],
      description: '原话明确泛用时选 general。仅指当前对象时选 current_object。缺少可验证范围时选 unknown。更新省略则继承。'},
    valid_until: {type: ['string', 'null'], description: '短期状态须有明确时限并转成 ISO UTC（含毫秒）；不确定时询问，不能猜。'},
  }, ['action', 'quote_excerpt']),
];

type WriteReference = { id: string; rev: number; title: string };
type SavedObservation = { status: 'saved'; text: string; undo_token: string };

export type WorkspaceWriteReceipt = WriteReference & { observation?: SavedObservation;
  memory?: {status: 'saved'; action: 'remember' | 'correct' | 'forget'; undo_token: string};
  page?: {status:'saved'; undo_token:string} | {status:'proposed'; proposalId:string};
  relation?: {status:'saved'; undo_token:string} | {status:'proposed'; proposalId:string};
};

type ChangedWrite = {status: 'changed'} | {status: 'withdrawn'};

export type WorkspaceWriteView = Omit<WorkspaceWriteReceipt, 'observation' | 'memory' | 'page' | 'relation'> & {
  observation?: NonNullable<WorkspaceWriteReceipt['observation']> | ChangedWrite;
  memory?: NonNullable<WorkspaceWriteReceipt['memory']> | ChangedWrite;
  page?: NonNullable<WorkspaceWriteReceipt['page']> | ChangedWrite | {status: 'reverted'};
  relation?: NonNullable<WorkspaceWriteReceipt['relation']> | ChangedWrite;
};

export function workspaceWriteNeedsCurrentFact(write: WorkspaceWriteReceipt) {
  return Boolean(write.observation || write.memory || write.page?.status === 'saved' || write.relation?.status === 'saved');
}

export function projectStaleWorkspaceWrite(write: WorkspaceWriteReceipt, withdrawn: boolean, pageUndone: boolean): WorkspaceWriteView {
  const state: ChangedWrite = {status: withdrawn ? 'withdrawn' : 'changed'};
  if (write.page?.status === 'saved') {
    return {...write, page: {status: pageUndone ? write.rev === 1 ? 'withdrawn' : 'reverted' : 'changed'}};
  }
  if (write.relation?.status === 'saved') return {...write, relation: state};
  if (write.memory) return {...write, memory: state};
  if (write.observation) return {...write, observation: state};
  return write;
}

export function presentationTool(schema: object, bindings: string) {
  return {type:'function',function:{name:'mount_artifact',
    description:'用组件目录创作当前回合的互动作品。view 只含可向学生展示的题面，排除答案和评分依据。需要先冻结预测时提供 predictionPrompt。正式断句另传 sentenceBreaks（两套完整断点 ID），预测必填，题面和回复都不得包含断法。宿主独立核验后才正式发放。'+bindings,
    parameters:{type:'object',required:['view'],additionalProperties:false,properties:{
      view:schema,predictionPrompt:{...text,maxLength:160},
      sentenceBreaks:{type:'array',minItems:2,maxItems:2,items:{type:'array',minItems:1,maxItems:128,items:text}},
    }}}};
}

export function workspaceWriteResult(
  state: string, command: string, written: { id: string; rev: number } | undefined, observation: boolean,
) {
  if (!written) return {state, command};
  const {id, rev} = written;
  if (!observation) return {state, id, rev};
  return {ok:true, status:'saved', kind:'inferred', ref:{id, rev}, undo_token:command};
}

export function workspaceStoredReceipt(
  { id, rev }: { id: string; rev: number }, entry: Record<string, unknown>, command: string, observation: boolean,
): WorkspaceWriteReceipt {
  return {id, rev, title:String(entry.title),
    ...(observation ? {observation:{status:'saved',text:String(entry.body),undo_token:command}} : {})};
}

export function radarArguments(args: Record<string, unknown>, isFactId: (value: unknown) => boolean) {
  const { scope, horizon_hours: hours } = args;
  if (hours !== undefined && (typeof hours !== 'number' || !Number.isSafeInteger(hours) || hours < 1 || hours > 168)) return;
  if (scope !== undefined) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return;
    const { subject_id, kc_ids, ...other } = scope as Record<string, unknown>;
    if (Object.keys(other).length || (subject_id !== undefined && !isFactId(subject_id)) ||
        (kc_ids !== undefined && (!Array.isArray(kc_ids) || kc_ids.length > 8 || !kc_ids.every(isFactId)))) return;
    if (subject_id !== undefined || (Array.isArray(kc_ids) && kc_ids.length)) return { scoped: true };
  }
  const now = Date.now();
  return { scoped: false, horizon: hours === undefined ? undefined : {
    from: new Date(now).toISOString(), through: new Date(now + hours * 3_600_000).toISOString(),
  } };
}

export function observationToolInput(args: Record<string, unknown>, isReference: (value: string) => boolean) {
  const {title, text, evidence_refs: refs} = args;
  if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim())
    return learningToolError('invalid_args','text','请填写标题和作为推断的观察正文。');
  if (!Array.isArray(refs) || !refs.length || refs.length > openLearningLimit ||
      !refs.every(ref => typeof ref === 'string' && ref.length <= 4096 && isReference(ref)))
    return learningToolError('invalid_args','evidence_refs','请提供 1–8 个原答引用。');
  return {title, text, refs: refs as string[]};
}

export function validateWorkspaceToolArgs(name: string, args: Record<string, unknown>) {
  const tool = workspaceDefinitions.find(tool => tool.function.name === name);
  if (!tool) return learningToolError('tool_unavailable',undefined,'请从本轮提供的工作区工具中选择。');
  const fields = tool.function.parameters.properties;
  const unknown = Object.keys(args).find(key => !Object.hasOwn(fields,key));
  if (!unknown) return undefined;
  return {...learningToolError('invalid_args',unknown.slice(0,60),'发现工具定义之外的字段。',{
    tool:name,args:Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(fields,key))),why:'仅传工具支持的字段。',
  }),valid_fields:Object.keys(fields)};
}

export type WorkspaceTools = {
  narrowSaves?: true;
  presentationTool?: (typeof workspaceDefinitions)[number];
  writes: () => readonly WorkspaceWriteReceipt[];
  execute: (name: string, args: Record<string, unknown>, step: number, receiveImage?: ReceiveStudyImage) => Promise<string>;
};

/** A learner decision or undo can still be managed after its originating reply is hidden. */
export function revokedReplyWriteReceipts(writes: readonly WorkspaceWriteReceipt[]) {
  return writes.flatMap<WorkspaceWriteReceipt>(write => {
    if (write.memory) return [{id: write.id, rev: write.rev, title: '记忆回执', memory: write.memory}];
    const relation = write.relation?.status === 'proposed'
      ? { status: 'proposed' as const, proposalId: write.relation.proposalId }
      : write.relation?.status === 'saved'
        ? { status: 'saved' as const, undo_token: write.relation.undo_token }
        : undefined;
    if (!relation) return [];
    return [{ id: write.id, rev: write.rev, title: '知识关系回执', relation }];
  });
}
