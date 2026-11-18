export function validateExecutionRef(value: string): void {
  if (typeof value !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) {
    throw new TypeError('Invalid Temporal execution reference');
  }
}
