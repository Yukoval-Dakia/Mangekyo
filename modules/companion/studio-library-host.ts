import {
  commandId, factId, isFactReadDenied, isKernelErrorKind,
  type CommandHooks, type Db, type Json, type ReadTransaction,
} from '@mangekyo/kernel';

type LoadedModule = any;
export type StudioLibraryDeps = Record<string, any>;

export function openLibrary(deps: StudioLibraryDeps, db: Db, captureModule: LoadedModule, content: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = deps.createStudioCommandHooks()) {
  const host = deps.studioHost(db);
  const exec = host.boundHandler([captureModule, content, plan], hooks, undefined,
    { crossModuleWrites: { [deps.captureMaterial]: { create: [deps.materialType] } } });
  const write = (type: string, requestId: string, input: Json, deletionWatermark?: string) =>
    exec({ purpose: deps.storagePurpose, type, id: commandId(deps.stableId('library', requestId)), input, ...(deletionWatermark === undefined ? {} : { deletionWatermark }) })
      .catch((error: any) => Promise.reject(isKernelErrorKind(error, 'duplicate_command') ? new deps.RequestError(409, '同一个请求标识已经用于不同内容。') : error));
  return {
    async reading(id: string) {
      const source = await host.snapshot((tx: ReadTransaction) => deps.readMaterialText(tx, id));
      if (!source) throw new deps.RequestError(404, '找不到这份材料。');
      return source;
    },
    snapshot: () => host.snapshot(async (tx: ReadTransaction) => {
      const read = host.read(tx, deps.storagePurpose);
      const readValue = (id: string) => read.fact(factId(id), { mode: 'following' }).then((f: any) => f.value, (e: any) => isFactReadDenied(e) ? null : Promise.reject(e));
      const { rows: materialsRows } = await tx.query<{ id: string }>('SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick DESC, id', [tx.learner, deps.materialType]);
      const { rows: [latestGoal] } = await tx.query<{ id: string }>('SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick DESC, id LIMIT 1', [tx.learner, deps.goalType]);
      const materials = [];
      for (const { id } of materialsRows) {
        const value = await readValue(id);
        if (value !== null) materials.push({ id, ...deps.textMaterial(value) });
      }
      const goal = latestGoal ? await readValue(latestGoal.id) : null;
      return { materials, goal: goal === null ? null : deps.studyGoal(goal).text };
    }),
    async capture(input: { requestId: unknown; title: unknown; text: unknown }, deletionWatermark = '0') {
      const requestId = deps.clientRequest(input?.requestId), id = factId(deps.stableId('text-material', requestId));
      await write(deps.captureMaterial, requestId, { id, data: { ...deps.validate(deps.textMaterial, input, '请输入材料标题（最多 240 字）和正文（最多 4000 字）。'), savedAt: new Date().toISOString() } }, deletionWatermark);
      return { id };
    },
    setGoal: (input: { requestId: unknown; text: unknown }) => {
      const requestId = deps.clientRequest(input?.requestId);
      return write(deps.setStudyGoal, requestId, { id: factId(deps.stableId('study-goal', requestId)), data: deps.validate(deps.studyGoal, input, '请输入最多 4000 字的目标，或留空清除。') });
    },
  };
}
