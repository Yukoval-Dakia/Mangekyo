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
const textbookBlockBody = {type:'object', required:['kind'], properties:{
  kind:{type:'string',enum:['text','list','table','formula','image','reference','related']}, text, latex:text, order:text,
  rows:{type:'array',items:strings}, source:{type:'object'}, alt:text, role:text, target:{anyOf:[text,{type:'object'}]}, allOf:{type:'array',items:{type:'object'}},
}, additionalProperties:false};
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
};
export type WorkspaceTools = {
  presentationTool?: (typeof workspaceDefinitions)[number];
  writes: () => readonly WorkspaceWriteReceipt[];
  execute: (name: string, args: Record<string, unknown>, step: number, receiveImage?: ReceiveStudyImage) => Promise<string>;
};
