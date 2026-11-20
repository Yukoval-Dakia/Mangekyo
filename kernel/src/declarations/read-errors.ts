// Studio can load the kernel from source while a domain module loads its
// packed declarations. Both constructors must classify the same read failure.
const missingFact = Symbol.for('@mangekyo/kernel.read-error.fact-not-found.v1');

export class FactNotFoundError extends Error {
  readonly [missingFact] = true;

  static override [Symbol.hasInstance](value: unknown): boolean {
    return super[Symbol.hasInstance](value) ||
      (this === FactNotFoundError && value instanceof Error && Reflect.get(value, missingFact) === true);
  }
}
