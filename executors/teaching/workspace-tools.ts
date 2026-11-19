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
export const workspaceDefinitions = [
  tool('search_workspace', '找学习记录、题或笔记；留空列最近记录，related 查关联。', {
    query: text, kind: {enum: ['attempt','paper','material','note', ...workspaceKinds], type: 'string'},
    related: text, cursor: text,
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
  writes: () => readonly {id:string; rev:number; title:string}[];
  execute: (name: string, args: Record<string, unknown>, step: number) => Promise<string>;
};
