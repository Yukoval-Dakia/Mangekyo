import { FactNotFoundError } from '../declarations/read-errors.ts';
import { FactReadDeniedError } from './reads.ts';

/** Structural categories the kernel may surface; no domain or UI wording. */
export type KernelErrorKind =
  | 'not_found' | 'denied' | 'duplicate_command' | 'revision_conflict' | 'already_exists'
  | 'retracted' | 'purpose_write_denied' | 'proposal_not_found' | 'proposal_decided'
  | 'unknown_command' | 'unknown';

export type KernelError = { readonly kind: KernelErrorKind; readonly reason?: string; readonly cause: unknown };
export type KernelErrorHandlers<T> = Partial<Record<KernelErrorKind, (error: KernelError) => T>> & {
  readonly otherwise: (error: KernelError) => T;
};
export type OptionalKernelErrorHandlers<T> = Partial<Record<KernelErrorKind, (error: KernelError) => T>> & {
  readonly otherwise?: (error: KernelError) => T;
};

const stringRules: readonly (readonly [RegExp, KernelErrorKind])[] = [
  [/^Command ID already used with a different command identity$/, 'duplicate_command'],
  [/^Fact revision conflict(?:$|:)/, 'revision_conflict'],
  [/^Fact already exists:/, 'already_exists'],
  [/^Fact is retracted:/, 'retracted'],
  [/^Fact purpose does not allow this write:/, 'purpose_write_denied'],
  [/^Fact does not exist:/, 'not_found'],
  [/^Proposal not found$/, 'proposal_not_found'],
  [/^Proposal already decided$/, 'proposal_decided'],
  [/^Unknown command:/, 'unknown_command'],
];

export function classifyKernelError(cause: unknown): KernelError {
  if (cause instanceof FactNotFoundError) return { kind: 'not_found', cause };
  if (cause instanceof FactReadDeniedError) return { kind: 'denied', reason: cause.reason, cause };
  if (cause instanceof Error) {
    for (const [pattern, kind] of stringRules) {
      if (pattern.test(cause.message)) return { kind, cause };
    }
  }
  return { kind: 'unknown', cause };
}

export const isKernelErrorKind = (cause: unknown, kind: KernelErrorKind) => classifyKernelError(cause).kind === kind;
export const isFactNotFound = (cause: unknown): cause is FactNotFoundError => cause instanceof FactNotFoundError;
export const isFactReadDenied = (cause: unknown): cause is FactReadDeniedError => cause instanceof FactReadDeniedError;
export const isFactUnavailable = (cause: unknown): boolean => isFactNotFound(cause) || isFactReadDenied(cause);

/** Match a classified kernel error to a handler; `otherwise` catches unknown. */
export function matchKernelError<T>(
  cause: unknown,
  handlers: KernelErrorHandlers<T>,
): T {
  const classified = classifyKernelError(cause);
  const handler = handlers[classified.kind];
  return handler ? handler(classified) : handlers.otherwise(classified);
}

/** Translate at the boundary without repeating an otherwise-rethrowing catch block. */
export const mapKernelError = <T>(error: unknown, handlers: OptionalKernelErrorHandlers<T>): T => {
  const classified = classifyKernelError(error);
  const handler = handlers[classified.kind];
  if (handler) return handler(classified);
  if (!handlers.otherwise) throw error;
  const mapped = handlers.otherwise(classified);
  if (mapped === error) throw error;
  return mapped;
};

/** An unavailable fact is an absent optional read; all other failures retain their identity. */
export const readAvailable = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try { return await read(); } catch (error) { if (isFactUnavailable(error)) return undefined; throw error; }
};

/** Declarative filter for collection reads where unavailable facts are omitted. */
export const ignoreUnavailable = <Args extends readonly unknown[], T>(read: (...args: Args) => Promise<T>) =>
  (...args: Args) => readAvailable(() => read(...args));
