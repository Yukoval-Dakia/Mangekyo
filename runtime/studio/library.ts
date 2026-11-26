import { commandId, factId, isFactReadDenied, listFactIds, mapKernelError, type CommandHooks, type Db, type Json } from '../../kernel/src/index.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { captureMaterial } from '../../modules/capture/intake-values.ts';
import { materialType, textMaterial } from '../../modules/content/text-material.ts';
import { goalType, setStudyGoal, studyGoal } from '../../modules/plan/goal-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { parseRequest, stableId, studioHost } from './identity.ts';
import { readMaterialText } from './reading.ts';
import { clientRequest, RequestError } from './sessions.ts';

const validate = <Value>(parse: (input: unknown) => Value, input: unknown, message: string) =>
  parseRequest(() => parse(input), message);

export function openLibrary(db: Db, captureModule: LoadedModule, content: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) {
  const host = studioHost(db);
  const exec = host.boundHandler([captureModule, content, plan], hooks, undefined,
    { crossModuleWrites: { [captureMaterial]: { create: [materialType] } } });
  const write = (type: string, requestId: string, input: Json, deletionWatermark?: string) =>
    exec({ purpose: storagePurpose, type, id: commandId(stableId('library', requestId)), input, ...(deletionWatermark === undefined ? {} : { deletionWatermark }) })
      .catch(error => { throw mapKernelError(error, { duplicate_command: () => new RequestError(409, '同一个请求标识已经用于不同内容。') }); });
  return {
    async reading(id: string) {
      const source = await host.snapshot(tx => readMaterialText(tx, id));
      if (!source) throw new RequestError(404, '找不到这份材料。');
      return source;
    },
    snapshot: () => host.snapshot(async tx => {
      const read = host.read(tx, storagePurpose);
      const readValue = (id: string) => read.fact(factId(id), { mode: 'following' }).then(f => f.value, e => isFactReadDenied(e) ? null : Promise.reject(e));
      const [materialIds, [latestGoal]] = await Promise.all([
        listFactIds(tx, { types: [materialType], includeRetracted: true, order: 'created_desc' }),
        listFactIds(tx, { types: [goalType], includeRetracted: true, order: 'created_desc', limit: 1 }),
      ]);
      const materials = [];
      for (const id of materialIds) {
        const value = await readValue(id);
        if (value !== null) materials.push({ id, ...textMaterial(value) });
      }
      const goal = latestGoal ? await readValue(latestGoal) : null;
      return { materials, goal: goal === null ? null : studyGoal(goal).text };
    }),
    async capture(input: { requestId: unknown; title: unknown; text: unknown }, deletionWatermark = '0') {
      const requestId = clientRequest(input?.requestId), id = factId(stableId('text-material', requestId));
      await write(captureMaterial, requestId, { id, data: { ...validate(textMaterial, input, '请输入材料标题（最多 240 字）和正文（最多 4000 字）。'), savedAt: new Date().toISOString() } }, deletionWatermark);
      return { id };
    },
    async setGoal(input: { requestId: unknown; text: unknown }) {
      const requestId = clientRequest(input?.requestId);
      return write(setStudyGoal, requestId, { id: factId(stableId('study-goal', requestId)), data: validate(studyGoal, input, '请输入最多 4000 字的目标，或留空清除。') });
    },
  };
}
