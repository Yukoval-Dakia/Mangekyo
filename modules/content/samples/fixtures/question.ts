import type { JsonObject } from '@mangekyo/kernel';

export function numericQuestion(title: string, prompt: string, criterionId: string, parameters: number | JsonObject, blocks: readonly JsonObject[]) {
  const statement = { id: 'statement', parentId: null, body: { kind: 'text', text: prompt } };
  return {
    kind: 'question', title, promptBlockId: statement.id, blocks: [statement, ...blocks],
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
