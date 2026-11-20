import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const unavailable = () => new RequestError(404,'原件暂不可读取。');
const conflict = () => new RequestError(409,'原件的存储归属或内容不匹配。');
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function ownerAt(directory: string) {
  const stat = await lstat(directory).catch(error => { if (!noEntry(error)) throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory()) throw conflict();
  const file = await open(join(directory,'store-id'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (!noEntry(error)) throw error; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 128) throw conflict();
    const marker = await file.readFile('utf8');
    if (!/^[0-9A-HJKMNP-TV-Z]{26}:[0-9A-HJKMNP-TV-Z]{26}$/.test(marker)) throw conflict();
    return marker;
  } finally { await file.close(); }
}

// Only a positive legacy marker permits adoption or disposal of a second, old copy.
async function hasLegacyOwner(directory: string, owner: string) {
  try { return await ownerAt(directory) === owner; }
  catch (error) {
    if (error instanceof RequestError || (error as NodeJS.ErrnoException).code === 'ELOOP') return false;
    throw error;
  }
}

async function eraseContents(directory: string) {
  await rm(join(directory,'original'),{force:true});
  await rm(join(directory,'meta.json'),{force:true});
  const handle = await open(directory,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

type OriginalWitness = {sha256:string; size?:number; name?:string; mediaType?:string};

async function verifiedBytes(directory: string, expected: OriginalWitness) {
  const stored = intakeOriginal(JSON.parse(await readFile(join(directory,'meta.json'),'utf8').catch(error => {
    if (noEntry(error)) throw unavailable();
    throw error;
  })));
  if (stored.sha256 !== expected.sha256 || (expected.size !== undefined && stored.size !== expected.size) ||
      (expected.name !== undefined && stored.name !== expected.name) ||
      (expected.mediaType !== undefined && stored.mediaType !== expected.mediaType)) throw conflict();
  const file = await open(join(directory,'original'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (noEntry(error)) throw unavailable(); throw error; });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > intakeFileLimit || stat.size !== stored.size) throw conflict();
    const bytes = Buffer.alloc(stat.size);
    if ((await file.read(bytes,0,bytes.length,0)).bytesRead !== bytes.length || digest(bytes) !== expected.sha256) throw conflict();
    return bytes;
  } finally { await file.close(); }
}

export function openIntakeObjects(db: Db) {
  const root = join(dataRoot(),'intake');
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
    await mkdir(root,{recursive:true,mode:0o700});
    const temporary = await mkdtemp(join(root,'.incoming-'));
    const staged = join(temporary,'object');
    const path = join(staged,'original');
    let installed: BigIntStats | undefined;
    try {
      await mkdir(staged,{mode:0o700});
      const identity = await lstat(staged,{bigint:true});
      await writeFile(path,bytes,{mode:0o600});
      await writeFile(join(staged,'meta.json'),JSON.stringify(original),{mode:0o600});
      await writeFile(join(staged,'store-id'),owner,{mode:0o600});
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
    } finally {
      await rm(temporary,{recursive:true,force:true});
    }
  }
  return {read,erase,withOriginal};
}
