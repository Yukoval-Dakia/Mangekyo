export function isOpaqueUlid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}

export function validateExecutionRef(value: string): void {
  if (!isOpaqueUlid(value)) {
    throw new TypeError('Invalid Temporal execution reference');
  }
}
