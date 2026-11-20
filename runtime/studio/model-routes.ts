import type { ModelTask } from '../../executors/teaching/model-routes.ts';

export function turnTask(caseId: string, preparation: boolean): ModelTask {
  if (caseId !== 'companion' && caseId !== 'riding') return 'diagnostic';
  return preparation ? 'preparation' : 'companion';
}
