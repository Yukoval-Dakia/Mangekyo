import { defineCommand } from '@mangekyo/kernel';
import { captureSourceCommand, sourceInputWrite } from '../source.ts';

export default defineCommand({
  type: captureSourceCommand,
  destructive: false,
  schema: { parse: input => sourceInputWrite(input, false) },
  write: (_ctx, write) => [write],
});
