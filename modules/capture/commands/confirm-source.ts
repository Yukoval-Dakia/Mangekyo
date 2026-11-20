import { defineCommand } from '@mangekyo/kernel';
import { confirmSourceCommand, sourceInputWrite } from '../source.ts';

export default defineCommand({
  type: confirmSourceCommand,
  destructive: true,
  schema: { parse: input => sourceInputWrite(input, true) },
  write: (_ctx, write) => [write],
});
