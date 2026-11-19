import { defineCommand, defineFact, defineModule } from '../../src/declarations/define.ts';
import { factId, type FactId } from '../../src/declarations/ids.ts';
import type { FactWrite } from '../../src/declarations/types.ts';
import type { LoadedModule } from '../../src/loader.ts';

const schema = { parse(input: unknown): { id: FactId; text: string } {
  if (typeof input !== 'object' || input === null || !('id' in input) || !('text' in input)
      || typeof input.id !== 'string' || typeof input.text !== 'string') throw new Error('Invalid note');
  return { id: factId(input.id), text: input.text };
} };
const note = defineFact({ type: 'note.entry', schema: { parse(input: unknown) {
  if (typeof input !== 'object' || input === null || !('text' in input) || typeof input.text !== 'string') throw new Error('Invalid note data');
  return { text: input.text };
} } });
const correct = defineCommand({ type: 'note.correct', destructive: true,
  schema: { parse(input: unknown) {
    const parsed = schema.parse(input);
    if (!('rev' in Object(input)) || typeof (input as {rev?:unknown}).rev !== 'number') throw new Error('Invalid revision');
    const rev = (input as {rev:number}).rev;
    if (!Number.isInteger(rev) || rev < 1) throw new Error('Invalid revision');
    return {...parsed, rev};
  } },
  write: (_ctx,input):readonly FactWrite[] => [{kind:'correct',id:input.id,expectedRev:input.rev as import('../../src/declarations/ids.ts').Revision,data:{text:input.text}}],
});
export function noteModule(purpose?: readonly string[]): LoadedModule {
  const record = defineCommand({ type: 'note.record', schema, destructive: false,
    write: (_ctx, input): readonly FactWrite[] => [{
      kind: 'create', id: input.id, factType: 'note.entry', data: { text: input.text },
      ...(purpose === undefined ? {} : { purpose }),
    }],
  });
 return {definition:defineModule({name:'note'}),facts:new Map([[note.type,note]]),commands:new Map<string, Record<string, unknown>>([[record.type,record],[correct.type,correct]]),slots:new Map(),derivers:new Map()};
}
