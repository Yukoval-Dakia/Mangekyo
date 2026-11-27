import { factId, isJson } from '@mangekyo/kernel';
import { parseCalcArtifactBinding } from './calc-artifact-binding.ts';

export function artifactMount(input: unknown) {
  if (
    !isJson(input) ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !('turnId' in input) ||
    typeof input.turnId !== 'string' ||
    typeof input.sessionId !== 'string' ||
    !input.view ||
    !input.manifest ||
    (input.assessment !== undefined && (!input.assessment || typeof input.assessment !== 'object' ||
      Array.isArray(input.assessment) || !('release' in input.assessment) || !('qualification' in input.assessment) ||
      !Array.isArray(input.assessment.runs))) ||
    (input.predictionPrompt !== null && typeof input.predictionPrompt !== 'string')
  )
    throw new Error('作品版本或会话引用无效。');
  return {
    sessionId: factId(input.sessionId),
    turnId: factId(input.turnId),
    view: input.view,
    manifest: input.manifest,
    predictionPrompt: input.predictionPrompt,
    ...(input.assessment === undefined ? {} : { assessment: input.assessment }),
    ...(input.calcBindings === undefined ? {} : {
      calcBindings: Array.isArray(input.calcBindings)
        ? Object.freeze(input.calcBindings.map(parseCalcArtifactBinding)) : (() => { throw new Error('验算工件绑定无效。'); })(),
    }),
  };
}
