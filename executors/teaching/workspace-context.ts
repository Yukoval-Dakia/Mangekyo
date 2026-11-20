import type {FunctionCall, ProviderTurn} from './provider-stream.ts';

export type StudyMessage =
  | {role: 'system' | 'user' | 'assistant'; content: string}
  | {role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null}
  | {role: 'tool'; tool_call_id: string; content: string};

const budget = 48 * 1024;
const workspaceReads = new Set(['read_workspace', 'search_workspace', 'open_learning']);

// Keep provider call/result pairs intact, including signed assistant turns.
// Project only tool payloads, oldest first, without changing the original journal.
export function projectWorkspaceContext(messages: readonly StudyMessage[]): readonly StudyMessage[] {
  let bytes = Buffer.byteLength(JSON.stringify(messages));
  if (bytes <= budget) return messages;
  const output = [...messages];
  const tools = new Map<string, string>();
  for (const [index, message] of messages.entries()) {
    if (bytes <= budget) break;
    if ('tool_calls' in message) {
      for (const call of message.tool_calls) tools.set(call.id, call.function.name);
    }
    if (message.role !== 'tool' || message.content.length <= 800) continue;
    const tool = tools.get(message.tool_call_id);
    if (!tool) continue;
    const content = JSON.stringify({
      archived: true, tool, preview: message.content.slice(0, 320).toWellFormed(),
      ...(workspaceReads.has(tool) && {resume: '可用原查询或记录 id 重新读取。'}),
    });
    const replacement = {...message, content};
    bytes -= Buffer.byteLength(JSON.stringify(message)) - Buffer.byteLength(JSON.stringify(replacement));
    output[index] = replacement;
  }
  return output;
}
