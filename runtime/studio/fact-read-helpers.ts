import { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError, snapshotFactReaders } from '../../kernel/src/commands/reads.ts';
import type { ReadTransaction } from '../../kernel/src/db/types.ts';
import type { FactId } from '../../kernel/src/declarations/ids.ts';
import type { FactReadOptions, FactSnapshot } from '../../kernel/src/declarations/types.ts';

export { createAuthorizedFactReader, createCommandReadContext, FactNotFoundError, FactReadDeniedError, snapshotFactReaders };

export const isFactNotFound = (error: unknown): error is FactNotFoundError => error instanceof FactNotFoundError;
export const isFactReadDenied = (error: unknown): error is FactReadDeniedError => error instanceof FactReadDeniedError;
export const isFactUnavailable = (error: unknown): boolean => isFactNotFound(error) || isFactReadDenied(error);
export const factReadChecks = {isFactNotFound, isFactReadDenied};

export function storageRead(tx: ReadTransaction): ReturnType<typeof createCommandReadContext> {
  return createCommandReadContext(tx, 'storage');
}

export function teachingRead(tx: ReadTransaction): ReturnType<typeof createCommandReadContext> {
  return createCommandReadContext(tx, 'teaching');
}

export function purposeReader(tx: ReadTransaction, maySend: (fact: FactSnapshot) => boolean): ReturnType<typeof createAuthorizedFactReader> {
  return createAuthorizedFactReader(tx, 'teaching', maySend);
}

export async function readFactOrNull(tx: ReadTransaction, purpose: string, id: FactId, options: FactReadOptions) {
  try { return await createCommandReadContext(tx, purpose).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}

export async function readAuthorizedFactOrNull(tx: ReadTransaction, purpose: string, maySend: (fact: FactSnapshot) => boolean, id: FactId, options: FactReadOptions) {
  try { return await createAuthorizedFactReader(tx, purpose, maySend).fact(id, options); }
  catch (error) { if (isFactUnavailable(error)) return; throw error; }
}
