import { FactNotFoundError } from '../declarations/read-errors.ts';
import { FactReadDeniedError } from './reads.ts';

/** Structural categories the kernel may surface; no domain or UI wording. */
export type KernelErrorKind =
  | 'not_found' | 'denied' | 'duplicate_command' | 'revision_conflict' | 'already_exists'
  | 'retracted' | 'purpose_write_denied' | 'proposal_not_found' | 'proposal_decided'
  | 'unknown_command' | 'unknown';

export type KernelError = { readonly kind: KernelErrorKind; readonly reason?: string; readonly cause: unknown };

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
  handlers: Partial<Record<KernelErrorKind, (error: KernelError) => T>> & { readonly otherwise: (error: KernelError) => T },
): T {
  const classified = classifyKernelError(cause);
  const handler = handlers[classified.kind];
  return handler ? handler(classified) : handlers.otherwise(classified);
}
