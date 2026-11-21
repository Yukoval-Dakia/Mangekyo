import type { EffectRequest, JsonObject } from '@mangekyo/kernel';
import { bindQuestionExecution, type QuestionExecution } from '../../question-effects.ts';

export function numericQuestion(title: string, prompt: string, criterionId: string, parameters: number | JsonObject, blocks: readonly JsonObject[]) {
  const statement = { id: 'statement', parentId: null, body: { kind: 'text', text: prompt } };
  return {
    kind: 'question', title, promptBlockId: statement.id,
    blocks: [statement, ...blocks] satisfies [JsonObject, ...JsonObject[]],
    response_schema: [{ slotId: 'answer', schemaVersion: '1', fields: [{ kind: 'numeric', path: '' }] }],
    assessment_contract: [{
      criterionId, inputs: [{ slotId: 'answer', path: '' }], maximum: 1,
      missingEvidence: 'insufficient-evidence', evaluator: { id: 'frozen-value-match', version: '1' },
      parameters: typeof parameters === 'number' ? { value: parameters } : parameters,
    }],
  };
}

export function localVerificationExecution(hex: string) {
  const digest = hex.repeat(64);
  return { kind: 'local_wasm', moduleDigest: digest, executableDigest: digest, feeMicroUsd: 0 } as const;
}

export function bindFixtureVerifiers<Plan extends { readonly effects: readonly EffectRequest[] }>(plan: Plan,
  executionAt: (index: number) => QuestionExecution = index => localVerificationExecution((index + 1).toString(16))) {
  return { ...plan, effects: plan.effects.map((request, index) => bindQuestionExecution(request, executionAt(index))) };
}
