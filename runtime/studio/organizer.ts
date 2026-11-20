import { readFactCollection, readValueRevisions } from '../../kernel/src/commands/fact-collection.ts';
import type { CommandHooks } from '../../kernel/src/commands/contracts.ts';
import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { commandId, factId } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import { organizerNoteType, organizerNoteView, prepareOrganizerNote } from '../../modules/activity/organizer-values.ts';
import {
  createOrganizerTask,
  organizerTask,
  organizerTaskDoneInput,
  organizerTaskDraft,
  organizerTaskType,
  setOrganizerTaskDone,
  type OrganizerTask,
} from '../../modules/plan/organizer-task-values.ts';
import { createStudioCommandHooks } from './command-hooks.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export type OrganizerTaskView = OrganizerTask & {
  readonly id: string;
  readonly rev: number;
};

export type OrganizerNoteView = ReturnType<typeof organizerNoteView>;

export type OrganizerSnapshot = {
  readonly tasks: readonly OrganizerTaskView[];
  readonly notes: readonly OrganizerNoteView[];
};

function validate<Value>(parse: (input: unknown) => Value, input: unknown): Value {
  try {
    return parse(input);
  } catch (error) {
    throw new RequestError(400, error instanceof Error ? error.message : '内容格式无效。');
  }
}

function translate(error: unknown): Error {
  if (error instanceof RequestError) return error;
  if (error instanceof FactNotFoundError) return new RequestError(400, '链接的材料或要恢复的版本不存在。');
  if (error instanceof FactReadDeniedError) return new RequestError(403, '这份材料当前无法链接。');
  if (error instanceof Error) {
    if (error.message === 'Command ID already used with a different command identity') {
      return new RequestError(409, '同一个请求标识已经用于不同内容。');
    }
    if (error.message.startsWith('Fact revision conflict: ')) {
      return new RequestError(409, '这条记录已在别处更新。请刷新后再试。');
    }
    if (error.message.startsWith('Fact does not exist: ')) {
      return new RequestError(404, '这条记录不存在。');
    }
    if (error.message.startsWith('Fact is retracted: ')) {
      return new RequestError(409, '这条记录已经撤回。');
    }
  }
  return error instanceof Error ? error : new Error('安排保存失败。');
}

function written(receipt: Awaited<ReturnType<ReturnType<typeof createCommandHandler>>>) {
  const ref = receipt.wrote[0];
  if (!ref) throw new RequestError(500, '这次写入没有返回记录。');
  return { id: ref.id, rev: ref.rev };
}

export function openOrganizer(db: Db, activity: LoadedModule, plan: LoadedModule,
  hooks: CommandHooks = createStudioCommandHooks()) {
  const handle = createCommandHandler(db, { modules: [activity, plan], hooks });

  async function write(type: string, requestId: string, input: unknown) {
    try {
      return await handle({
        learner: studioLearner,
        actor: 'learner',
        purpose: storagePurpose,
        type,
        id: commandId(stableId('organizer-command', type, requestId)),
        input: input as Json,
      });
    } catch (error) {
      throw translate(error);
    }
  }

  async function snapshot(includeHistory = true): Promise<OrganizerSnapshot> {
    return db.snapshot({ learner: studioLearner }, async (tx) => {
      const read = createCommandReadContext(tx, storagePurpose);
      const tasks: OrganizerTaskView[] = [];
      for await (const fact of readFactCollection(tx, read, [organizerTaskType])) {
        tasks.push({ id: fact.ref.id, rev: fact.ref.rev, ...organizerTask(fact.value) });
      }
      tasks.sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          Number(left.done) - Number(right.done) ||
          left.id.localeCompare(right.id),
      );

      const notes: OrganizerNoteView[] = [];
      for await (const current of readFactCollection(tx, read, [organizerNoteType], { newestFirst: true })) {
        const history = includeHistory ? await readValueRevisions(tx, read, current.ref.id) : [];
        notes.push(organizerNoteView(current, history));
      }
      return { tasks, notes };
    });
  }

  return {
    snapshot,

    async task(input: unknown) {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const requestId = clientRequest(value.requestId);
      if (typeof value.id === 'string' && value.id.length > 0) {
        const commandInput = validate(organizerTaskDoneInput, {
          ...value,
          expectedRev: value.expectedRev ?? value.rev,
        });
        return written(await write(setOrganizerTaskDone, requestId, commandInput));
      }
      const data = validate(organizerTaskDraft, input);
      const id = factId(stableId('organizer-task', requestId));
      return written(await write(createOrganizerTask, requestId, { id, data }));
    },

    async note(input: unknown) {
      const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const requestId = clientRequest(value.requestId);
      const id = factId(stableId('organizer-note', requestId));
      const command = validate(data => prepareOrganizerNote(data, id), input);
      return written(await write(command.type, requestId, command.input));
    },
  };
}
