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
export const workspaceDefinitions = [
  tool('read_learner_radar', '读取当前获准的冻结保持预测和对账、目标、未完成任务、先修查询入口及可用卷面。缺证时保留未知。', {
    scope: {type:'object', additionalProperties:false, properties:{subject_id:text, kc_ids:{...strings, maxItems:8}}},
    horizon_hours: {type:'integer', minimum:1, maximum:168, description:'只看观察窗口在未来指定小时内截止的保持记录。'},
  }),
  tool('open_learning', '打开 1–8 个已获准的学习对象。refs 可传 id、sourceRef JSON 字符串或这些引用的数组。已交卷作答用 lens: diagnose 读取题面、原答、评估和帮助曝光。part 支持 question:<题号>、assessment，或从单个交入材料读 PNG/JPEG 原图的 image_crop。省略 crop 时先查原图尺寸。', {
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
  tool('save_workspace', '新建给 kind、title、body；修改给 id 和变动字段。教材或方法笔记用 page。出题时 body 只写题面，解答放 answer，评分放 rubric。links 填来源 id，关系按起点、终点排列。', {
    kind: {type: 'string', enum: workspaceKinds}, title: text, body: text, tags: strings, links: strings,
    answer: text, rubric: text, id: {type:'string', pattern:'^[0-9A-HJKMNP-TV-Z]{26}$', description:'仅更新时用已有 id；创建时省略。'}, rev: integer,
  }),
];
type WriteReference = { id: string; rev: number; title: string };
type SavedObservation = { status: 'saved'; text: string; undo_token: string };

export type WorkspaceWriteReceipt = WriteReference & { observation?: SavedObservation };
export type WorkspaceTools = {
  presentationTool?: (typeof workspaceDefinitions)[number];
  writes: () => readonly WorkspaceWriteReceipt[];
  execute: (name: string, args: Record<string, unknown>, step: number, receiveImage?: ReceiveStudyImage) => Promise<string>;
};
