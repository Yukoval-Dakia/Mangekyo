import type {FunctionCall, ProviderTurn} from './provider-stream.ts';
import type {StudyImage} from './workspace-tools.ts';

export type StudyMessage =
  | {role: 'system' | 'user' | 'assistant'; content: string}
  | {role: 'assistant'; tool_calls: FunctionCall[]; providerTurn?: ProviderTurn; content: null}
  | ToolResultMessage;

export type ToolResultMessage = {role: 'tool'; tool_call_id: string; content: string; image?: StudyImage};

const budget = 48 * 1024;

// Keep provider call/result pairs intact, including signed assistant turns.
// Project only tool payloads, oldest first, without changing the original journal.
export function projectWorkspaceContext(messages: readonly StudyMessage[], previews: WeakMap<ToolResultMessage, string>): readonly StudyMessage[] {
  const textBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, (key, part) => key === 'image' ? undefined : part));
  let bytes = textBytes(messages);
  if (bytes <= budget) return messages;
  const output = [...messages];
  for (const [index, message] of messages.entries()) {
    if (bytes <= budget) break;
    if (message.role !== 'tool') continue;
    const content = previews.get(message);
    if (!content || content === message.content) continue;
    const replacement = {...message, content};
    const saved = textBytes(message) - textBytes(replacement);
    if (saved <= 0) continue;
    bytes -= saved;
    output[index] = replacement;
  }
  return output;
}

type ChatImagePart = {type:'text'; text:string} | {type:'image_url'; image_url:{url:string}};

export function projectChatImages(messages: readonly StudyMessage[]) {
  if (!messages.some(message => message.role === 'tool' && message.image)) return messages;
  const output: (StudyMessage | {role:'user'; content:ChatImagePart[]})[] = [];
  let images: ChatImagePart[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') {
      output.push(message);
      continue;
    }
    const {image, ...tool} = message;
    output.push(tool);
    if (image) images.push({type:'text',text:`同伴工作区 ${tool.tool_call_id} 返回的原图裁剪`},
      {type:'image_url', image_url:{url:`data:${image.mediaType};base64,${image.data}`}});
    // Chat Completions accepts images in user messages after the full tool batch.
    if (images.length && messages[index + 1]?.role !== 'tool') {
      output.push({role:'user',content:images});
      images = [];
    }
  }
  return output;
}
