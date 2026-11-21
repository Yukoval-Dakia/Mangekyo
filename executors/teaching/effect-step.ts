import type { Json, JsonObject } from '@mangekyo/kernel';
import type { TeachingDependencies, TeachingModelStep, TeachingDispatch } from './index.ts';
import { TeachingError } from './provider.ts';
import { completionUsage } from './provider-stream.ts';

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
        if (!memorySend) return reply;
        // learning-tools-v1 wraps the provider payload as a JSON string inside
        // `reply`; surface its reportedModel/usage so consumers can read them
        // without parsing the serialized body themselves.
        if (typeof reply !== 'string') return { reply, sent: { ...memorySend, requestId } };
        let parsed: unknown;
        try {
          parsed = JSON.parse(reply);
        } catch {
          return { reply, sent: { ...memorySend, requestId } };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return { reply, sent: { ...memorySend, requestId } };
        const fields = parsed as Record<string, unknown>;
        const reportedModel = typeof fields.reportedModel === 'string' && fields.reportedModel
          ? fields.reportedModel : undefined;
        let usage: JsonObject | undefined;
        try {
          usage = completionUsage(fields.usage) as JsonObject | undefined;
        } catch {
          usage = undefined;
        }
        return {
          reply,
          sent: { ...memorySend, requestId },
          ...(reportedModel ? { reportedModel } : {}),
          ...(usage ? { usage } : {}),
        };
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
