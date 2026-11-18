import { createCommandHandler } from '../../kernel/src/commands/handle.ts';
import {
  createCommandReadContext,
  FactNotFoundError,
  FactReadDeniedError,
} from '../../kernel/src/commands/reads.ts';
import type { Db } from '../../kernel/src/db/types.ts';
import { commandId, factId, type Revision } from '../../kernel/src/declarations/ids.ts';
import type { Json } from '../../kernel/src/declarations/types.ts';
import type { LoadedModule } from '../../kernel/src/loader.ts';
import { storagePurpose } from '../../modules/activity/library-values.ts';
import {
  createOrganizerNote,
  createOrganizerTask,
  organizerNote,
  organizerNoteDraft,
  organizerNoteRestoreInput,
  organizerNoteSaveInput,
  organizerNoteType,
  organizerTask,
  organizerTaskDoneInput,
  organizerTaskDraft,
  organizerTaskType,
  restoreOrganizerNote,
  saveOrganizerNote,
  setOrganizerTaskDone,
  type OrganizerNote,
  type OrganizerTask,
} from '../../modules/activity/organizer-values.ts';
import { stableId, studioLearner } from './identity.ts';
import { clientRequest, RequestError } from './sessions.ts';

export type OrganizerTaskView = OrganizerTask & {
  readonly id: string;
  readonly rev: number;
};

export type OrganizerNoteVersionView = OrganizerNote & {
  readonly rev: number;
};

export type OrganizerNoteView = OrganizerNoteVersionView & {
  readonly id: string;
  readonly versions: readonly OrganizerNoteVersionView[];
};

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

export function openOrganizer(db: Db, activity: LoadedModule) {
  const handle = createCommandHandler(db, {
    modules: [activity],
    hooks: { async onFactsChanged() {} },
  });

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
      const { rows: taskRows } = await tx.query<{ id: string }>(
        `SELECT id FROM facts
         WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
         ORDER BY created_tick, id`,
        [tx.learner, organizerTaskType],
      );
      const tasks: OrganizerTaskView[] = [];
      for (const row of taskRows) {
        try {
          const fact = await read.fact(factId(row.id), { mode: 'following' });
          tasks.push({ id: row.id, rev: fact.ref.rev, ...organizerTask(fact.value) });
        } catch (error) {
          if (!(error instanceof FactReadDeniedError)) throw error;
        }
      }
      tasks.sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          Number(left.done) - Number(right.done) ||
          left.id.localeCompare(right.id),
      );

      const { rows: noteRows } = await tx.query<{ id: string }>(
        `SELECT id FROM facts
         WHERE learner_id=$1 AND type=$2 AND retracted_rev IS NULL
         ORDER BY created_tick DESC, id DESC`,
        [tx.learner, organizerNoteType],
      );
      const notes: OrganizerNoteView[] = [];
      for (const row of noteRows) {
        const id = factId(row.id);
        try {
          const current = await read.fact(id, { mode: 'following' });
          const versions: OrganizerNoteVersionView[] = [];
          if (includeHistory) {
            const revisions = await tx.query<{ rev: number }>(
              "SELECT rev FROM fact_revs WHERE learner_id=$1 AND fact_id=$2 AND kind='value' ORDER BY rev",
              [tx.learner, id],
            );
            for (const {rev} of revisions.rows) {
              try {
                const version = await read.fact(id, { mode: 'pinned', rev: rev as Revision });
                versions.push({ rev, ...organizerNote(version.value) });
              } catch (error) {
                if (!(error instanceof FactReadDeniedError)) throw error;
              }
            }
          }
          notes.push({ id, ...organizerNote(current.value), rev: current.ref.rev, versions });
        } catch (error) {
          if (!(error instanceof FactReadDeniedError)) throw error;
        }
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
      if (typeof value.id === 'string' && value.id.length > 0) {
        if (value.restoreRev !== undefined) {
          const commandInput = validate(organizerNoteRestoreInput, input);
          return written(await write(restoreOrganizerNote, requestId, commandInput));
        }
        const commandInput = validate(organizerNoteSaveInput, input);
        return written(await write(saveOrganizerNote, requestId, commandInput));
      }
      const draft = validate(organizerNoteDraft, input);
      const id = factId(stableId('organizer-note', requestId));
      return written(await write(createOrganizerNote, requestId, { id, ...draft }));
    },
  };
}
