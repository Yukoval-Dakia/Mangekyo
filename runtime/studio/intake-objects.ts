import type { BigIntStats } from 'node:fs';
import { lstat, rename } from 'node:fs/promises';
import { openOriginalFiles, stageOriginal, type OriginalWitness } from '@mangekyo/executor-document-extraction/original';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import type { Db } from '../../kernel/src/db/types.ts';
import { lockLearner } from '../../kernel/src/db/learner.ts';
import { factId, type FactId } from '../../kernel/src/declarations/ids.ts';
import { workerStorage } from '../../kernel/src/schema.ts';
import { intakeOriginal, intakeFileLimit, type IntakeOriginal } from '../../modules/capture/intake-values.ts';
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
const unavailable = () => new RequestError(404,'原件暂不可读取。');
const conflict = () => new RequestError(409,'原件的存储归属或内容不匹配。');

export function openIntakeObjects(db: Db) {
  const root = join(dataRoot(),'intake');
  const {ownerAt, eraseContents, verifiedBytes} = openOriginalFiles({
    decode: intakeOriginal, maximumSize: intakeFileLimit, unavailable, conflict,
  });

  // Only a positive legacy marker permits adoption or disposal of a second, old copy.
  async function hasLegacyOwner(directory: string, owner: string) {
    try { return await ownerAt(directory) === owner; }
    catch (error) {
      if (error instanceof RequestError || (error as NodeJS.ErrnoException).code === 'ELOOP') return false;
      throw error;
    }
  }

  async function locations(materialId: string) {
    const id = factId(materialId), store = factId(await workerStorage(db));
    return {owner:store + ':' + id, scoped:join(root,store + '.' + id), legacy:join(root,id)};
  }

  async function read(id: string, expected: OriginalWitness) {
    const {owner,scoped,legacy} = await locations(id);
    const marked = await ownerAt(scoped);
    if (marked === owner) return verifiedBytes(scoped,expected);
    if (marked !== undefined) throw conflict();
    const old = await ownerAt(legacy);
    // Pre-marker originals remain readable only against the authorized database digest.
    if (old === undefined || (old !== null && old !== owner)) throw unavailable();
    return verifiedBytes(legacy,expected);
  }

  async function erase(id: FactId) {
    const {owner,scoped,legacy} = await locations(id);
    const marked = await ownerAt(scoped);
    if (marked === undefined) {
      if (await ownerAt(legacy) !== owner) throw conflict();
      return eraseContents(legacy);
    }
    if (marked !== owner) throw conflict();
    await eraseContents(scoped);
    if (await hasLegacyOwner(legacy,owner)) await eraseContents(legacy);
  }

  async function withOriginal<T>(id: FactId, bytes: Buffer, original: IntakeOriginal,
    save: (staged: string, install: () => Promise<void>) => Promise<T>) {
    const {owner,scoped,legacy} = await locations(id);
    return stageOriginal(root, bytes, original, owner, async ({staged, path, identity}) => {
      let installed: BigIntStats | undefined;
      try {
        return await save(path,async () => {
          // Every publisher of this store-qualified name holds this database's learner lock.
          const marked = await ownerAt(scoped);
          if (marked === undefined) {
            if (await hasLegacyOwner(legacy,owner)) {
              await verifiedBytes(legacy,original);
              return;
            }
            await rename(staged,scoped);
            installed = identity;
          } else {
            if (marked !== owner) throw conflict();
            await verifiedBytes(scoped,original);
          }
        });
      } catch (error) {
        const published = installed;
        if (published) await db.tx({learner:studioLearner},async tx => {
          await lockLearner(tx,tx.learner);
          const {rowCount} = await tx.query(`SELECT id FROM facts WHERE learner_id=$1 AND id=$2
            UNION ALL SELECT id FROM tombstones WHERE learner_id=$1 AND kind='fact' AND id=$2`,[tx.learner,id]);
          if (rowCount || await ownerAt(scoped) !== owner) return;
          const current = await lstat(scoped,{bigint:true});
          if (current.dev === published.dev && current.ino === published.ino) await rename(scoped,staged);
        }).catch(() => undefined);
        throw error;
      }
    });
  }
  return {read,erase,withOriginal};
}
