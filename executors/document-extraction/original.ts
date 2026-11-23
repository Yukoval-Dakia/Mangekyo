import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveIntakeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MANGEKYO_INTAKE_DATA_DIR?.trim();
  const home = homedir();
  const base = override ? resolve(override)
    : platform() === 'darwin' ? resolve(home, 'Library/Application Support/Mangekyō')
    : platform() === 'win32' ? resolve(env.LOCALAPPDATA || home, 'Mangekyō')
    : resolve(env.XDG_DATA_HOME || resolve(home, '.local/share'), 'mangekyo');
  return join(base, 'intake');
}

type OriginalMetadata = {name: string; mediaType: string; size: number; sha256: string};
export type OriginalWitness = {sha256: string; size?: number; name?: string; mediaType?: string};
export type MultiPageOriginalEntry = { readonly bytes: Buffer; readonly original: OriginalMetadata };

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const maxStoredPages = 16;

function pageFileNames(page: number): { readonly data: string; readonly meta: string } {
  if (!Number.isSafeInteger(page) || page < 1 || page > maxStoredPages) {
    throw new Error('原件页码无效。');
  }
  return page === 1
    ? { data: 'original', meta: 'meta.json' }
    : { data: `page-${page}`, meta: `meta-${page}.json` };
}

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
    const entries = await readdir(directory).catch(error => {
      if (noEntry(error)) return [] as string[];
      throw error;
    });
    for (const entry of entries) {
      if (/^(?:page-\d+|meta-\d+\.json)$/.test(entry)) {
        await rm(join(directory, entry), { force: true });
      }
    }
    const handle = await open(directory,'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async function verifiedBytes(directory: string, expected: OriginalWitness, page = 1) {
    const names = pageFileNames(page);
    const stored = decode(JSON.parse(await readFile(join(directory,names.meta),'utf8').catch(error => {
      if (noEntry(error)) throw unavailable();
      throw error;
    })));
    if (stored.sha256 !== expected.sha256 || (expected.size !== undefined && stored.size !== expected.size) ||
        (expected.name !== undefined && stored.name !== expected.name) ||
        (expected.mediaType !== undefined && stored.mediaType !== expected.mediaType)) throw conflict();
    const file = await open(join(directory,names.data),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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

type StagedOriginal = {staged: string; path: string; paths: readonly string[]; identity: BigIntStats};

export async function stageOriginals<T>(
  root: string,
  entries: readonly MultiPageOriginalEntry[],
  owner: string,
  use: (staged: StagedOriginal) => Promise<T>,
) {
  if (!entries.length || entries.length > maxStoredPages) throw new Error('原件页数无效。');
  await mkdir(root,{recursive:true,mode:0o700});
  const temporary = await mkdtemp(join(root,'.incoming-'));
  const staged = join(temporary,'object');
  const paths: string[] = [];
  try {
    await mkdir(staged,{mode:0o700});
    const identity = await lstat(staged,{bigint:true});
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const names = pageFileNames(index + 1);
      const dataPath = join(staged, names.data);
      await writeFile(dataPath, entry.bytes, { mode: 0o600 });
      await writeFile(join(staged, names.meta), JSON.stringify(entry.original), { mode: 0o600 });
      paths.push(dataPath);
    }
    await writeFile(join(staged,'store-id'),owner,{mode:0o600});
    return await use({staged, path: paths[0]!, paths, identity});
  } finally {
    await rm(temporary,{recursive:true,force:true});
  }
}

export async function stageOriginal<T>(root: string, bytes: Buffer, original: OriginalMetadata, owner: string,
  use: (staged: StagedOriginal) => Promise<T>) {
  return stageOriginals(root, [{ bytes, original }], owner, use);
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

  async function readPage(id: string, page: number, expected: OriginalWitness) {
    if (!Number.isSafeInteger(page) || page < 1 || page > maxStoredPages) throw unavailable();
    const {owner,scoped,legacy} = await locations(id);
    const marked = await ownerAt(scoped);
    if (marked === owner) return verifiedBytes(scoped, expected, page);
    if (marked !== undefined) throw conflict();
    if (page !== 1) throw unavailable();
    const old = await ownerAt(legacy);
    // Pre-marker originals remain readable only against the authorized database digest.
    if (old === undefined || (old !== null && old !== owner)) throw unavailable();
    return verifiedBytes(legacy, expected, 1);
  }

  async function read(id: string, expected: OriginalWitness) {
    return readPage(id, 1, expected);
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

  async function withOriginals<T>(
    id: string,
    entries: readonly MultiPageOriginalEntry[],
    save: (stagedPaths: readonly string[], install: () => Promise<void>) => Promise<T>,
  ) {
    const {owner,scoped,legacy} = await locations(id);
    return stageOriginals(root, entries, owner, async ({staged, paths, identity}) => {
      let installed: BigIntStats | undefined;
      try {
        return await save(paths, async () => {
          // Every publisher of this store-qualified name holds this database's learner lock.
          const marked = await ownerAt(scoped);
          if (marked === undefined) {
            if (entries.length === 1 && await hasLegacyOwner(legacy, owner)) {
              await verifiedBytes(legacy, entries[0]!.original, 1);
              return;
            }
            await rename(staged, scoped);
            installed = identity;
          } else {
            if (marked !== owner) throw conflict();
            for (let index = 0; index < entries.length; index += 1) {
              await verifiedBytes(scoped, entries[index]!.original, index + 1);
            }
          }
        });
      } catch (error) {
        const published = installed;
        if (published) await whenUncommitted(id, async () => {
          if (await ownerAt(scoped) !== owner) return;
          const current = await lstat(scoped, { bigint: true });
          if (current.dev === published.dev && current.ino === published.ino) await rename(scoped, staged);
        }).catch(() => undefined);
        throw error;
      }
    });
  }

  async function withOriginal<T>(id: string, bytes: Buffer, original: OriginalMetadata,
    save: (staged: string, install: () => Promise<void>) => Promise<T>) {
    return withOriginals(id, [{ bytes, original }], (paths, install) => save(paths[0]!, install));
  }

  async function appendOriginals<T>(
    id: string,
    startPage: number,
    entries: readonly MultiPageOriginalEntry[],
    save: (stagedPaths: readonly string[], install: () => Promise<void>) => Promise<T>,
    appendOptions?: { readonly whenUncommitted?: (undo: () => Promise<void>) => Promise<void> },
  ) {
    if (!Number.isSafeInteger(startPage) || startPage < 2 || !entries.length || startPage + entries.length - 1 > maxStoredPages) {
      throw conflict();
    }
    const { owner, scoped, legacy } = await locations(id);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(root, '.append-'));
    const stagedFiles: {
      readonly page: number;
      readonly dataPath: string;
      readonly metaPath: string;
      readonly dataIdentity: BigIntStats;
      readonly metaIdentity: BigIntStats;
      readonly original: OriginalMetadata;
    }[] = [];
    const installedTargets: { readonly target: string; readonly identity: BigIntStats }[] = [];
    let installCompleted = false;

    const unlinkIfSameFile = async (target: string, expected: BigIntStats) => {
      const current = await lstat(target, { bigint: true }).catch(error => {
        if (noEntry(error)) return undefined;
        throw error;
      });
      if (current && current.dev === expected.dev && current.ino === expected.ino) {
        await rm(target, { force: true });
      }
    };

    const cleanupInstalled = async () => {
      if (await ownerAt(scoped) !== owner) return;
      for (const item of [...installedTargets].reverse()) {
        await unlinkIfSameFile(item.target, item.identity).catch(() => undefined);
      }
    };

    try {
      for (let index = 0; index < entries.length; index += 1) {
        const page = startPage + index;
        const names = pageFileNames(page);
        const dataPath = join(temporary, names.data);
        const metaPath = join(temporary, names.meta);
        await writeFile(dataPath, entries[index]!.bytes, { mode: 0o600 });
        await writeFile(metaPath, JSON.stringify(entries[index]!.original), { mode: 0o600 });
        const [dataIdentity, metaIdentity] = await Promise.all([
          lstat(dataPath, { bigint: true }),
          lstat(metaPath, { bigint: true }),
        ]);
        stagedFiles.push({ page, dataPath, metaPath, dataIdentity, metaIdentity, original: entries[index]!.original });
      }
      return await save(stagedFiles.map(file => file.dataPath), async () => {
        let marked = await ownerAt(scoped);
        if (marked === undefined && await hasLegacyOwner(legacy, owner)) {
          await rename(legacy, scoped);
          marked = await ownerAt(scoped);
        }
        if (marked !== owner) throw conflict();
        try {
          for (const file of stagedFiles) {
            const names = pageFileNames(file.page);
            const dataTarget = join(scoped, names.data);
            const metaTarget = join(scoped, names.meta);
            const existing = await lstat(metaTarget).catch(error => { if (!noEntry(error)) throw error; });
            if (existing) {
              await verifiedBytes(scoped, file.original, file.page);
              continue;
            }
            await rename(file.dataPath, dataTarget);
            installedTargets.push({ target: dataTarget, identity: file.dataIdentity });
            await rename(file.metaPath, metaTarget);
            installedTargets.push({ target: metaTarget, identity: file.metaIdentity });
          }
          installCompleted = true;
        } catch (installError) {
          await cleanupInstalled().catch(() => undefined);
          installedTargets.length = 0;
          throw installError;
        }
      });
    } catch (error) {
      if (installCompleted && installedTargets.length > 0 && appendOptions?.whenUncommitted) {
        await appendOptions.whenUncommitted(cleanupInstalled).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return {read, readPage, erase, withOriginal, withOriginals, appendOriginals};
}
