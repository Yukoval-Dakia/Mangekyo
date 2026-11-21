import { openOwnedOriginalFiles } from '@mangekyo/executor-document-extraction/original';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import type { Db } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { factId } from '../../kernel/src/declarations/ids.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { intakeOriginal, intakeFileLimit } from '../../modules/capture/intake-values.ts';
import { studioLearner } from './identity.ts';
import { RequestError } from './sessions.ts';

function dataRoot() {
  const override = process.env.MANGEKYO_INTAKE_DATA_DIR;
  if (override && override.trim()) return resolve(override.trim());
  const home = homedir();
  if (platform() === 'darwin') return resolve(home, 'Library/Application Support/Mangekyō');
  if (platform() === 'win32') return resolve(process.env.LOCALAPPDATA || home, 'Mangekyō');
  return resolve(process.env.XDG_DATA_HOME || resolve(home, '.local/share'), 'mangekyo');
}

export { digest } from '@mangekyo/executor-document-extraction/original';
export function openIntakeObjects(db: Db) {
  const root = join(dataRoot(),'intake');
  return openOwnedOriginalFiles(root, {
    decode: intakeOriginal, maximumSize: intakeFileLimit,
    unavailable: () => new RequestError(404,'原件暂不可读取。'),
    conflict: () => new RequestError(409,'原件的存储归属或内容不匹配。'),
    unavailableOwner: error => error instanceof RequestError,
    async locations(materialId) {
      const id = factId(materialId), store = factId(await workerStorage(db));
      return {owner:store + ':' + id, scoped:join(root,store + '.' + id), legacy:join(root,id)};
    },
    whenUncommitted: (id, undo) => db.tx({learner:studioLearner},async tx => {
      await lockLearner(tx,tx.learner);
      const {rowCount} = await tx.query(`SELECT id FROM facts WHERE learner_id=$1 AND id=$2
        UNION ALL SELECT id FROM tombstones WHERE learner_id=$1 AND kind='fact' AND id=$2`,[tx.learner,id]);
      if (!rowCount) await undo();
    }),
  });
}
