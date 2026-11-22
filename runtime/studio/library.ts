import type { Db } from '../../kernel/src/db/types.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import { createCommandReadContext, isFactReadDenied } from './fact-read-helpers.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { captureMaterial } from '../../modules/capture/intake-values.ts';
import { materialType, textMaterial } from '../../modules/content/text-material.ts';
import { goalType, setStudyGoal, studyGoal } from '../../modules/plan/goal-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { readMaterialText } from './reading.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

function validate<Value>(parse: (input: unknown) => Value, input: unknown, message: string) {
  try {
    return parse(input);
  } catch {
    throw new RequestError(400, message);
  }
}

export function openLibrary(db: Db, captureModule: LoadedModule, content: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) {
  const handle = createCommandHandler(db, {
    modules: [captureModule, content, plan],
    hooks,
    crossModuleWrites: { [captureMaterial]: { create: [materialType] } },
  });
  async function write(type: string, requestId: string, input: Json, deletionWatermark?: string) {
    try {
      return await handle({
        learner: studioLearner,
        actor: 'learner',
        purpose: storagePurpose,
        type,
        id: commandId(stableId('library', requestId)),
        input, ...(deletionWatermark === undefined ? {} : {deletionWatermark}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Command ID already used with a different command identity') {
        throw new RequestError(409, '同一个请求标识已经用于不同内容。');
      }
      throw error;
    }
  }
  return {
    async reading(id: string) {
      const source = await db.snapshot({learner: studioLearner}, tx => readMaterialText(tx, id));
      if (!source) throw new RequestError(404, '找不到这份材料。');
      return source;
    },
    snapshot: () => db.snapshot({ learner: studioLearner }, async (tx) => {
      const read = createCommandReadContext(tx, storagePurpose);
      async function readValue(id: string) {
        try {
          return (await read.fact(factId(id), { mode: 'following' })).value;
        } catch (error) {
          if (isFactReadDenied(error)) return null;
          throw error;
        }
      }
      const { rows: materialsRows } = await tx.query<{ id: string }>(
        `SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick DESC, id`,
        [tx.learner, materialType],
      );
      const { rows: [latestGoal] } = await tx.query<{ id: string }>(
        `SELECT id FROM facts WHERE learner_id=$1 AND type=$2 ORDER BY created_tick DESC, id LIMIT 1`,
        [tx.learner, goalType],
      );
      const materials = [];
      for (const { id } of materialsRows) {
        const value = await readValue(id);
        if (value !== null) materials.push({ id, ...textMaterial(value) });
      }
      const goal = latestGoal ? await readValue(latestGoal.id) : null;
      return { materials, goal: goal === null ? null : studyGoal(goal).text };
    }),
    async capture(input: { requestId: unknown; title: unknown; text: unknown }, deletionWatermark = '0') {
      const requestId = clientRequest(input?.requestId);
      const data = { ...validate(textMaterial, input, '请输入材料标题（最多 240 字）和正文（最多 4000 字）。'),
        savedAt: new Date().toISOString() };
      const id = factId(stableId('text-material', requestId));
      await write(captureMaterial, requestId, { id, data }, deletionWatermark);
      return { id };
    },
    async setGoal(input: { requestId: unknown; text: unknown }) {
      const requestId = clientRequest(input?.requestId);
      const data = validate(studyGoal, input, '请输入最多 4000 字的目标，或留空清除。');
      const id = factId(stableId('study-goal', requestId));
      return write(setStudyGoal, requestId, { id, data });
    },
  };
}
