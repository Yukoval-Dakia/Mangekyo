export const modelTasks = ['companion', 'preparation', 'diagnostic', 'assessment'] as const;
export type ModelTask = typeof modelTasks[number];
export type ModelRoutes = Partial<Record<ModelTask, string>>;

export function readModelRoutes(value: unknown, providers: readonly {id: string}[]): ModelRoutes {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务模型配置无效。');
  const result: ModelRoutes = {};
  for (const [task, id] of Object.entries(value)) {
    if (!modelTasks.some(item => item === task) || typeof id !== 'string' || !providers.some(p => p.id === id))
      throw new Error('任务使用的模型配置不存在。');
    result[task as ModelTask] = id;
  }
  return result;
}

export function turnTask(caseId: string, preparation: boolean): ModelTask {
  if (caseId !== 'companion' && caseId !== 'riding') return 'diagnostic';
  return preparation ? 'preparation' : 'companion';
}
