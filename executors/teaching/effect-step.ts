import type { Json, JsonObject } from '@mangekyo/kernel';
import type { TeachingDependencies, TeachingModelStep, TeachingDispatch } from './index.ts';
import { TeachingError } from './provider.ts';

type Invoke = Parameters<TeachingDependencies['runEffect']>[1];

/** Encode the durable teaching protocol shared by companion and introductory turns. */
export function teachingEffectStep(step: TeachingModelStep, invoke: Invoke, basis: JsonObject, memorySend?: JsonObject) {
  return {
    request: {
      stepKey: String(step.index),
      label: step.provider.startsWith('tool:') ? step.provider : 'teaching-model',
      input: { digest: step.requestDigest, provider: step.provider, model: step.model, ...basis },
    },
    async invoke(requestId: string, dispatch: TeachingDispatch) {
      try {
        // MCP may negotiate and JIT may prepare a request before the final send.
        const reply = await (step.provider.startsWith('tool:mcp:') || step.jitContext
          ? invoke(requestId, dispatch)
          : dispatch(() => invoke(requestId)));
        return memorySend ? { reply, sent: { ...memorySend, requestId } } : reply;
      } catch (error) {
        console.warn('模型调用未能确认', requestId, error instanceof TeachingError ? error.code : 'transport_error');
        throw error;
      }
    },
    reply(result: Json) {
      if (typeof result === 'string') return result;
      if (memorySend && result && typeof result === 'object' && !Array.isArray(result) &&
          'reply' in result && typeof result.reply === 'string')
        return result.reply;
      throw new Error('Invalid stored model response');
    },
  };
}
