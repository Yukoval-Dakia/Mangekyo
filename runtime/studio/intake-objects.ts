import { openOwnedOriginalFiles, resolveIntakeDataDir } from '@mangekyo/executor-document-extraction/original';
import { join } from 'node:path';
import { factId, type Db } from '../../kernel/src/index.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { intakeFileLimit, intakeOriginal } from '../../modules/capture/intake-values.ts';
import { RequestError } from './sessions.ts';
import { studioHost } from './fact-read-helpers.ts';
export { digest } from '@mangekyo/executor-document-extraction/original';
export function openIntakeObjects(db: Db) { const root = resolveIntakeDataDir(), host = studioHost(db);
  return openOwnedOriginalFiles(root, {decode: intakeOriginal, maximumSize: intakeFileLimit,
    unavailable: () => new RequestError(404, '原件暂不可读取。'),
    conflict: () => new RequestError(409, '原件的存储归属或内容不匹配。'),
    unavailableOwner: error => error instanceof RequestError, locations: async materialId => {
      const id = factId(materialId), store = factId(await workerStorage(db));
      return { owner: `${store}:${id}`, scoped: join(root, `${store}.${id}`), legacy: join(root, id) };
    },
    whenUncommitted: (id, undo) => host.lockedTx(async tx => {
      const { rowCount } = await tx.query(`SELECT id FROM facts WHERE learner_id=$1 AND id=$2 UNION ALL SELECT id FROM tombstones WHERE learner_id=$1 AND kind='fact' AND id=$2`, [tx.learner, id]);
      if (!rowCount) await undo();
    }),
  });
}
