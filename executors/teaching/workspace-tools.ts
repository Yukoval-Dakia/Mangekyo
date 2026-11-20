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
export const workspaceDefinitions = [
  tool('open_learning', '打开 1–8 个已获准的学习对象。refs 可传 id、sourceRef JSON 字符串或这些引用的数组。part 可传 question:<题号> 或 assessment。', {
    refs: {anyOf: [text, {type: 'array', minItems: 1, maxItems: openLearningLimit, items: text}]},
    part: text,
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
  tool('save_workspace', '新建给 kind、title、body；修改给 id 和变动字段。教材或方法笔记用 page。出题时 body 只写题面，解答放 answer，评分放 rubric。links 填来源 id，关系按起点、终点排列。', {
    kind: {type: 'string', enum: workspaceKinds}, title: text, body: text, tags: strings, links: strings,
    answer: text, rubric: text, id: {type:'string', pattern:'^[0-9A-HJKMNP-TV-Z]{26}$', description:'仅更新时用已有 id；创建时省略。'}, rev: integer,
  }),
];
export type WorkspaceTools = {
  presentationTool?: (typeof workspaceDefinitions)[number];
  writes: () => readonly {id:string; rev:number; title:string}[];
  execute: (name: string, args: Record<string, unknown>, step: number) => Promise<string>;
};
