import {learningToolError} from './tool-error.ts';
import { createHash } from 'node:crypto';
import { remoteToolDefinition, type RemoteTool } from './mcp-tools.ts';

const maximumQuery = 500;
const maximumMatches = 3;

export const findTools = {type: 'function', function: {
  name: 'find_tools',
  description: '按任务关键词或准确名称查找本轮已授权的按需工具。匹配工具的参数定义只在紧接的一次请求中可用，请在下一步调用。',
  parameters: {type: 'object', properties: {query: {type: 'string', minLength: 1, maxLength: maximumQuery}},
    required: ['query'], additionalProperties: false},
}};

const segmenter = new Intl.Segmenter('zh', {granularity: 'word'});
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const hasHan = /\p{Script=Han}/u;
const wireName = /^mcp_[a-z0-9_-]*_[a-f0-9]{12}$/;

function words(text: string) {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return new Set(Array.from(segmenter.segment(normalize(spaced).replace(/[^\p{L}\p{N}]+/gu, ' ')))
    .filter(({isWordLike, segment}) => isWordLike && segment.length >= 2)
    .map(({segment}) => segment));
}

export function studyToolDiscovery(remotes: ReadonlyMap<string, RemoteTool>) {
  // Rebuild the view from the journaled authorized MCP catalog on each replay.
  const catalog = Array.from(remotes, ([name, remote]) => {
    const {server, tool} = remote;
    const declarationVersion = createHash('sha256').update(JSON.stringify([server.url, tool])).digest('hex');
    return {
      descriptor: {name, declarationVersion, schemaRef: 'mcp:' + name + '@' + declarationVersion},
      remote, originalName: normalize(tool.name),
      nameWords: words(tool.name + ' ' + server.id),
      descriptionWords: words(tool.description),
      descriptionText: normalize(tool.description),
    };
  });
  const pending = new Map<string, ReturnType<typeof remoteToolDefinition>>();
  return {
    find(query: unknown) {
      if (typeof query !== 'string' || query.length > maximumQuery || !query.trim()) {
        return {content: JSON.stringify(learningToolError('invalid_args','query','查询需填写任务关键词或准确工具名，最多 500 个字符。')), summary: '查找工具 · 参数错误'};
      }
      const exactQuery = normalize(query.trim());
      const phrases = exactQuery.match(/\p{Script=Han}{2,}/gu) ?? [];
      const terms = [...new Set([...phrases, ...words(query)])];
      const exactWireName = wireName.test(exactQuery);
      const ranked = catalog.map(entry => {
        const exact = exactWireName ? exactQuery === normalize(entry.descriptor.name) : exactQuery === entry.originalName;
        const name = exactWireName ? [] : terms.filter(term => entry.nameWords.has(term));
        // In Chinese a standalone search term can be segmented differently in a sentence.
        const description = exactWireName ? [] : terms.filter(term => !entry.nameWords.has(term) &&
          (entry.descriptionWords.has(term) || (hasHan.test(term) && entry.descriptionText.includes(term))));
        return {entry, exact, name, description, score: name.length * 3 + description.length};
      });
      const hasExact = ranked.some(match => match.exact);
      const matches = ranked.filter(match => hasExact ? match.exact : match.score > 0)
        .sort((a, b) => b.score - a.score || (a.entry.descriptor.name < b.entry.descriptor.name ? -1 : 1))
        .slice(0, maximumMatches);
      const items = matches.map(({entry, exact, name, description}) => {
        const {descriptor, remote} = entry;
        pending.set(descriptor.schemaRef, remoteToolDefinition(descriptor.name, remote));
        return {...descriptor, match: exact ? {by: 'name'} : {by: 'keywords', name: name.slice(0, 4), description: description.slice(0, 4)}};
      });
      return {content: JSON.stringify({items, message: items.length
        ? '匹配工具将在下一步可用。请按返回的 name 和下一步的参数定义调用。'
        : '本轮没有匹配的已授权工具。可换用更具体的任务词或准确工具名，也可用当前工具继续。'}),
        summary: '查找工具 · ' + (items.length ? items.length + ' 项匹配' : '无匹配')};
    },
    takeDefinitions() {
      const definitions = [...pending.values()];
      pending.clear();
      return definitions;
    },
  };
}
