import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

type OriginalMetadata = {name: string; mediaType: string; size: number; sha256: string};
export type OriginalWitness = {sha256: string; size?: number; name?: string; mediaType?: string};

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

type OriginalFileOptions = {
  decode: (value: unknown) => OriginalMetadata;
  maximumSize: number;
  unavailable: () => Error;
  conflict: () => Error;
};

export function openOriginalFiles({decode, maximumSize, unavailable, conflict}: OriginalFileOptions) {
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

  async function eraseContents(directory: string) {
    await rm(join(directory,'original'),{force:true});
    await rm(join(directory,'meta.json'),{force:true});
    const handle = await open(directory,'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function verifiedBytes(directory: string, expected: OriginalWitness) {
    const stored = decode(JSON.parse(await readFile(join(directory,'meta.json'),'utf8').catch(error => {
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
      if (!stat.isFile() || stat.size > maximumSize || stat.size !== stored.size) throw conflict();
      const bytes = Buffer.alloc(stat.size);
      if ((await file.read(bytes,0,bytes.length,0)).bytesRead !== bytes.length || digest(bytes) !== expected.sha256) throw conflict();
      return bytes;
    } finally { await file.close(); }
  }

  return {ownerAt, eraseContents, verifiedBytes};
}

type StagedOriginal = {staged: string; path: string; identity: BigIntStats};

export async function stageOriginal<T>(root: string, bytes: Buffer, original: OriginalMetadata, owner: string,
  use: (staged: StagedOriginal) => Promise<T>) {
  await mkdir(root,{recursive:true,mode:0o700});
  const temporary = await mkdtemp(join(root,'.incoming-'));
  const staged = join(temporary,'object');
  const path = join(staged,'original');
  try {
    await mkdir(staged,{mode:0o700});
    const identity = await lstat(staged,{bigint:true});
    await writeFile(path,bytes,{mode:0o600});
    await writeFile(join(staged,'meta.json'),JSON.stringify(original),{mode:0o600});
    await writeFile(join(staged,'store-id'),owner,{mode:0o600});
    return await use({staged, path, identity});
  } finally {
    await rm(temporary,{recursive:true,force:true});
  }
}

type OriginalLocations = { owner: string; scoped: string; legacy: string };

export function openOwnedOriginalFiles(root: string, options: OriginalFileOptions & {
  locations(id: string): Promise<OriginalLocations>;
  unavailableOwner(error: unknown): boolean;
  whenUncommitted(id: string, undo: () => Promise<void>): Promise<void>;
}) {
  const { unavailable, conflict, locations, unavailableOwner, whenUncommitted } = options;
  const { ownerAt, eraseContents, verifiedBytes } = openOriginalFiles(options);

  // Only a positive legacy marker permits adoption or disposal of a second, old copy.
  async function hasLegacyOwner(directory: string, owner: string) {
    try { return await ownerAt(directory) === owner; }
    catch (error) {
      if (unavailableOwner(error) || (error as NodeJS.ErrnoException).code === 'ELOOP') return false;
      throw error;
    }
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

  async function erase(id: string) {
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

  async function withOriginal<T>(id: string, bytes: Buffer, original: OriginalMetadata,
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
        if (published) await whenUncommitted(id,async () => {
          if (await ownerAt(scoped) !== owner) return;
          const current = await lstat(scoped,{bigint:true});
          if (current.dev === published.dev && current.ino === published.ino) await rename(scoped,staged);
        }).catch(() => undefined);
        throw error;
      }
    });
  }
  return {read,erase,withOriginal};
}
