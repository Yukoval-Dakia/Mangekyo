import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

type OriginalMetadata = {name: string; mediaType: string; size: number; sha256: string};
export type OriginalWitness = {sha256: string; size?: number; name?: string; mediaType?: string};

export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const noEntry = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export function openOriginalFiles({decode, maximumSize, unavailable, conflict}: {
  decode: (value: unknown) => OriginalMetadata;
  maximumSize: number;
  unavailable: () => Error;
  conflict: () => Error;
}) {
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
