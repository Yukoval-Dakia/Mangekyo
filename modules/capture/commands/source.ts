import { defineCommand } from '@mangekyo/kernel';
import { captureSourceCommand, sourceInputWrite } from '../source.ts';

import { checkNotionAdmission } from '../notion-source.ts';

export default defineCommand({
  type: captureSourceCommand,
  destructive: false,
  schema: { parse: input => sourceInputWrite(input, false) },
  async write(ctx, write) {
    if (write.data.kind === 'notion') await checkNotionAdmission(ctx, write.id, write.data, write.purpose);
    return [write];
  },
});
