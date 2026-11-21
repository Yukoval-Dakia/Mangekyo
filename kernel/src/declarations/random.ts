import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function stableId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 26).toUpperCase();
}

export { createHmac, randomInt, timingSafeEqual };
