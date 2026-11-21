import { z } from 'zod';
import { defineCommand, defineFact, defineModule } from '../../src/declarations/define.ts';
import { factId, type Revision } from '../../src/declarations/ids.ts';
import type { LoadedModule } from '../../src/loader.ts';

const noteData = z.object({ text: z.string() });
const note = defineFact({ type: 'note.entry', schema: noteData });
const recordInput = noteData.extend({ id: z.string().transform(factId) });
const revision = z.number().refine(rev => Number.isInteger(rev) && rev >= 1).transform(rev => rev as Revision);
const editInput = recordInput.extend({ rev: revision });
const edits = (['correct', 'revise'] as const).map(kind => defineCommand({
  type: `note.${kind}`,
  destructive: kind === 'correct',
  schema: editInput,
  write: (_ctx, { id, rev, text }) => [{ kind, id, expectedRev: rev, data: { text } }],
}));

export function noteModule(purpose?: readonly string[]): LoadedModule {
  const record = defineCommand({
    type: 'note.record',
    schema: recordInput,
    destructive: false,
    write: (_ctx, { id, text }) => [{
      kind: 'create', id, factType: note.type, data: { text },
      ...(purpose === undefined ? {} : { purpose }),
    }],
  });
  return {
    definition: defineModule({ name: 'note' }),
    facts: new Map([[note.type, note]]),
    commands: new Map([record, ...edits].map(command => [command.type, command])),
    slots: new Map(),
    derivers: new Map(),
  };
}
