import type {FunctionCall, ProviderTurn} from './provider-stream.ts';

export type StudyMessage =
  | {role: 'system' | 'user' | 'assistant'; content: string}
  | {role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null}
  | {role: 'tool'; tool_call_id: string; content: string};

// Preserve complete provider call/result pairs and the latest results. Earlier
// workspace payloads remain addressable by id even after leaving the live window.
export function projectWorkspaceContext(messages: readonly StudyMessage[]): readonly StudyMessage[] {
  const budget = 48 * 1024;
  let bytes = Buffer.byteLength(JSON.stringify(messages));
  if (bytes <= budget) return messages;
  const output = [...messages];
  const lastCall = messages.findLastIndex(message => 'tool_calls' in message);
  const recoverable = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (index >= lastCall || bytes <= budget) break;
    if ('tool_calls' in message) {
      for (const call of message.tool_calls) {
        if (call.function.name === 'read_workspace' || call.function.name === 'search_workspace')
          recoverable.set(call.id, call.function.name);
      }
    } else if (message.role === 'tool' && recoverable.has(message.tool_call_id) && message.content.length > 800) {
      const content = JSON.stringify({archived: true, tool: recoverable.get(message.tool_call_id),
        preview: message.content.slice(0, 320), resume: '可用原查询或记录 id 重新读取。'});
      const replacement = {...message, content};
      bytes -= Buffer.byteLength(JSON.stringify(message)) - Buffer.byteLength(JSON.stringify(replacement));
      output[index] = replacement;
    }
  }
  return output;
}
