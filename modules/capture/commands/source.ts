import { defineCommand } from '@mangekyo/kernel';
import { captureObject, captureText } from '../parse.ts';
import { captureSourceCommand, createSourceWrite } from '../source.ts';

export default defineCommand({
  type: captureSourceCommand,
  destructive: false,
  schema: { parse(input: unknown) {
    const row = captureObject(input);
    const purpose = row.purpose;
    if (purpose !== undefined && !Array.isArray(purpose)) throw new Error('原件用途无效。');
    return createSourceWrite(captureText(row.id, '原件标识', 26), row.envelope,
      purpose?.map(value => captureText(value, '原件用途', 100)));
  } },
  write: (_ctx, write) => [write],
});
