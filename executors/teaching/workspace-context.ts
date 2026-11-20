import type {FunctionCall, ProviderTurn} from './provider-stream.ts';

export type StudyMessage =
  | {role: 'system' | 'user' | 'assistant'; content: string}
  | {role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null}
  | ToolResultMessage;

export type ToolResultMessage = {role: 'tool'; tool_call_id: string; content: string};

const budget = 48 * 1024;

// Keep provider call/result pairs intact, including signed assistant turns.
// Project only tool payloads, oldest first, without changing the original journal.
export function projectWorkspaceContext(messages: readonly StudyMessage[], previews: WeakMap<ToolResultMessage, string>): readonly StudyMessage[] {
  let bytes = Buffer.byteLength(JSON.stringify(messages));
  if (bytes <= budget) return messages;
  const output = [...messages];
  for (const [index, message] of messages.entries()) {
    if (bytes <= budget) break;
    if (message.role !== 'tool') continue;
    const content = previews.get(message);
    if (!content || content === message.content) continue;
    const replacement = {...message, content};
    const saved = Buffer.byteLength(JSON.stringify(message)) - Buffer.byteLength(JSON.stringify(replacement));
    if (saved <= 0) continue;
    bytes -= saved;
    output[index] = replacement;
  }
  return output;
}
